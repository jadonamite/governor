/**
 * DelphiVenue — live adapter for the Delphi Agent Arena (competition-testnet).
 *
 * Env (see .env.example):
 *   DELPHI_NETWORK=competition-testnet   ← scopes REST to the active competition
 *   DELPHI_SIGNER_TYPE=private_key
 *   WALLET_PRIVATE_KEY=0x…               ← the registered competition wallet
 *   DELPHI_API_ACCESS_KEY=…              ← https://delphi-api-access.gensyn.ai/
 *
 * The competition runs LMSR, NOT the dynamic-parimutuel market used on Delphi
 * testnet/mainnet. Three consequences, and they are the whole adapter:
 *
 *   1. Outcome prices sum to 1 and the spot price IS the implied probability.
 *      They come back from listMarkets({pricesAndImpliedProbabilities:true})
 *      in one batched multicall — there is no need to discover a price by
 *      quoting a tiny buy.
 *   2. A winning share pays EXACTLY 1 token. So EV per share = q − price,
 *      and shares ≈ tokens / price.
 *   3. Depth is a fixed `b` chosen at market creation and some markets were
 *      created at the minimum. An oversized order REVERTS rather than filling
 *      badly, so every buy quotes first and steps its size down on failure.
 *
 * Decimals are the trap: collateral (TST) is 6dp, outcome shares are 18dp.
 * They never share a converter.
 *
 * Venue interface consumed by runner.js:
 *   init()             → recover open positions from chain (restart-safe)
 *   markets(now)       → [{ id, question, category, outcomes:[{idx,name,price}], closesInMs }]
 *   stake(id, outcomeIdx, tokens)   → buy, quote-first, depth-aware
 *   resolutions()      → [{ id, outcomeIdx, ret, spent }]  ret = tokens returned
 */

'use strict';

import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';

const SHARE_DP = 18n;                      // outcome shares are always 18dp
const ONE_SHARE = 10n ** SHARE_DP;

const toShares = (n) => BigInt(Math.round(n * 1e6)) * (10n ** (SHARE_DP - 6n));
const fromShares = (wei) => Number(wei) / Number(ONE_SHARE);

/** Size ladder: if a quote reverts on shallow `b`, back off rather than give up. */
const SIZE_BACKOFF = [1, 0.5, 0.25, 0.1, 0.05];
const MIN_SHARES = 0.05;

export class DelphiVenue {
  constructor() {
    for (const k of ['WALLET_PRIVATE_KEY', 'DELPHI_API_ACCESS_KEY']) {
      if (!process.env[k]) throw new Error(`DelphiVenue: missing ${k} (see .env.example)`);
    }
    this.client = new DelphiClient({
      network: process.env.DELPHI_NETWORK ?? 'competition-testnet',
      signerType: 'private_key',
      privateKey: process.env.WALLET_PRIVATE_KEY,
      apiKey: process.env.DELPHI_API_ACCESS_KEY,
    });
    this.held = new Map();       // marketAddress -> { outcomeIdx, shares(bigint), spent(number) }
    this.badMarkets = new Set(); // markets that would not quote — don't hammer every tick
    this.tokenDp = null;         // read from chain in init(), never assumed
    this.address = null;
  }

  /** Token amounts are collateral-decimals, read from chain rather than assumed. */
  toTokens(wei) { return Number(wei) / 10 ** this.tokenDp; }
  fromTokens(n) { return BigInt(Math.round(n * 10 ** this.tokenDp)); }

  /**
   * Recover state from chain. The runner holds positions in memory, so without
   * this a restart mid-competition orphans every open position — it would stop
   * redeeming them and double-stake markets it already holds.
   */
  async init() {
    const { address } = await this.client.getSigner();
    this.address = address;
    const { decimals } = await this.client.getErc20BalanceWithDecimals();
    this.tokenDp = decimals;

    const { positions } = await this.client.listPositions({ wallet: address, limit: 200 });
    for (const p of positions ?? []) {
      if (p.redeemedOrLiquidated) continue;
      const shares = BigInt(p.shares);
      if (shares <= 0n) continue;
      this.held.set(p.marketProxy, {
        outcomeIdx: Number(p.outcomeIdx),
        shares,
        spent: NaN, // cost basis is not in the positions API; unknown on recovery
      });
    }
    return { address, tokenDp: decimals, recovered: this.held.size };
  }

  async balance() {
    const { balance } = await this.client.getErc20BalanceWithDecimals();
    return this.toTokens(balance);
  }

  /**
   * Open markets with live prices. One batched multicall for every price —
   * `pricesAndImpliedProbabilities` is the whole reason this is cheap.
   * Ordered by soonest settlement: short resolution latency is what lets
   * capital recycle, which is what the pacer's model is built to exploit.
   */
  async markets(now) {
    const { markets } = await this.client.listMarkets({
      status: 'open', orderBy: 'settles_at', limit: 100,
      pricesAndImpliedProbabilities: true,
    });

    const out = [];
    for (const m of markets ?? []) {
      if (this.badMarkets.has(m.id) || this.held.has(m.id)) continue;

      const names = m.metadata?.outcomes;
      const probs = m.spotImpliedProbabilities;
      if (!Array.isArray(names) || !Array.isArray(probs) || names.length !== probs.length) {
        continue; // no prices this tick — transient, so do NOT blacklist
      }
      // LMSR prices are a softmax over supplies: they must sum to 1. If they
      // don't, we are reading the wrong network — refuse rather than guess.
      const sum = probs.reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 1) > 0.01) { this.badMarkets.add(m.id); continue; }

      const resolvesAtMs = m.resolvesAt ? new Date(m.resolvesAt).getTime() : null;
      out.push({
        id: m.id,
        question: m.metadata?.question ?? '',
        category: m.category,
        verifiable: m.verifiable,
        resolvesAtMs,
        closesInMs: resolvesAtMs ? resolvesAtMs - now : undefined,
        outcomes: names.map((name, idx) => ({ idx, name, price: probs[idx] })),
        // Forecasters key off the market's own declared settlement source and
        // the oracle's restatement of the criteria — pass both through intact.
        dataSources: m.dataSources,
        metadata: m.metadata,
      });
    }
    return out;
  }

  /**
   * Buy ~`tokens` worth of one outcome.
   *
   * LMSR depth is fixed at creation and can be a single share. Quoting first
   * and stepping down on revert is the documented way to survive that — an
   * oversized order does not fill badly, it fails.
   *
   * Returns { shares, spent } actually filled, or null if even the floor size
   * would not quote.
   */
  async stake(marketAddress, outcomeIdx, tokens, price) {
    const wanted = tokens / price;   // 1 token per winning share ⇒ shares = tokens / price

    for (const factor of SIZE_BACKOFF) {
      const target = wanted * factor;
      if (target < MIN_SHARES) break;
      const sharesOut = toShares(target);

      let tokensIn;
      try {
        ({ tokensIn } = await this.client.quoteBuy({ marketAddress, outcomeIdx, sharesOut }));
      } catch {
        continue; // curve saturated at this size — step down
      }

      const maxTokensIn = (tokensIn * 102n) / 100n; // 2% slippage: others trade between quote and send
      try {
        await this.client.ensureTokenApproval({ marketAddress, minimumAmount: maxTokensIn });
        await this.client.buyShares({ marketAddress, outcomeIdx, sharesOut, maxTokensIn });
      } catch (e) {
        if (/insufficient|balance/i.test(String(e))) throw e; // out of money is not a sizing problem
        continue;
      }

      const spent = this.toTokens(tokensIn);
      const prev = this.held.get(marketAddress);
      this.held.set(marketAddress, {
        outcomeIdx,
        shares: (prev?.shares ?? 0n) + sharesOut,
        spent: (prev && Number.isFinite(prev.spent) ? prev.spent : 0) + spent,
      });
      return { shares: fromShares(sharesOut), spent };
    }

    this.badMarkets.add(marketAddress); // too thin to trade at any size we'd use
    return null;
  }

  /**
   * Sell out of a held position before settlement.
   *
   * Needed because a forecast can INVERT while a market is still open: the
   * underlying moves, our q collapses, and the market has not repriced yet.
   * Holding to settlement then throws away the difference between what the
   * book will pay now and what we now believe the position is worth.
   *
   * Same depth discipline as buying — LMSR sells revert on size too.
   * `fraction` lets us scale out rather than dump.
   */
  async exit(marketAddress, fraction = 1) {
    const pos = this.held.get(marketAddress);
    if (!pos || pos.shares <= 0n) return null;

    const want = (pos.shares * BigInt(Math.round(fraction * 1e6))) / 1_000_000n;
    for (const f of SIZE_BACKOFF) {
      const sharesIn = (want * BigInt(Math.round(f * 1e6))) / 1_000_000n;
      if (sharesIn <= 0n || fromShares(sharesIn) < MIN_SHARES) break;

      let tokensOut;
      try {
        ({ tokensOut } = await this.client.quoteSell({
          marketAddress, outcomeIdx: pos.outcomeIdx, sharesIn,
        }));
      } catch { continue; }

      const minTokensOut = (tokensOut * 98n) / 100n; // 2% slippage
      try {
        await this.client.sellShares({
          marketAddress, outcomeIdx: pos.outcomeIdx, sharesIn, minTokensOut,
        });
      } catch { continue; }

      const got = this.toTokens(tokensOut);
      const remaining = pos.shares - sharesIn;
      if (remaining <= 0n) this.held.delete(marketAddress);
      else this.held.set(marketAddress, { ...pos, shares: remaining });
      return { shares: fromShares(sharesIn), got };
    }
    return null;
  }

  /**
   * Sweep held positions for anything exitable.
   *
   * `settled` redeems at exactly 1 token per winning share. `expired` and
   * `failed` have no winning outcome at all, so redeem() reverts on them and
   * the collateral comes back via liquidate() instead. A competition can end
   * with a lot of both, so the liquidate path is not an edge case.
   */
  async resolutions() {
    const done = [];
    for (const [addr, pos] of [...this.held]) {
      let status;
      try { status = await this.client.getMarketStatus(addr); } catch { continue; }
      if (status === 'open' || status === 'awaiting_settlement') continue;

      let ret = 0;
      try {
        if (status === 'settled') {
          const { tokensOut } = await this.client.redeemMarket({ marketAddress: addr });
          ret = this.toTokens(tokensOut ?? 0n);
        } else {
          const { totalTokensOut } = await this.client.liquidate({
            marketAddress: addr, outcomeIndices: [pos.outcomeIdx],
          });
          ret = this.toTokens(totalTokensOut ?? 0n);
        }
      } catch (e) {
        // Holding only losing shares: redeem reverts with nothing to pay out.
        // That is a resolved position worth 0, not a transient failure.
        if (!/revert|NothingToRedeem|no winning|zero/i.test(String(e))) continue;
      }
      this.held.delete(addr);
      done.push({ id: addr, outcomeIdx: pos.outcomeIdx, ret, spent: pos.spent });
    }
    return done;
  }
}
