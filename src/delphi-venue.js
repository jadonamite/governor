/**
 * DelphiVenue — live adapter for the Delphi Agent Arena (competition-testnet).
 *
 * Env (see .env.example):
 *   DELPHI_NETWORK=competition-testnet   ← scopes REST to the active competition
 *   DELPHI_SIGNER_TYPE=private_key
 *   WALLET_PRIVATE_KEY=0x…               ← the registered competition wallet
 *   DELPHI_API_ACCESS_KEY=…              ← https://delphi-api-access.gensyn.ai/
 *
 * Venue interface consumed by runner.js:
 *   markets(now)      → [{ id, yesPrice, closesInMs }]
 *   stake(id, side, amount)              (amount in whole tokens)
 *   resolutions(now)  → [{ id, winner: 'YES'|'NO', ret }]  ret = tokens returned
 *
 * LMSR has no posted price — the marginal price is discovered by quoting a
 * small buy. Binary markets only (outcomeIdx 0 = YES, 1 = NO); anything that
 * doesn't quote cleanly on both outcomes is skipped, not guessed at.
 */

'use strict';

import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';

const ONE = 10n ** 18n;                 // 18-decimal fixed point
const PROBE_SHARES = ONE / 10n;         // 0.1 share — small enough to read the margin

const toFloat = (wei) => Number(wei) / 1e18;
const toWei = (x) => BigInt(Math.round(x * 1e6)) * (10n ** 12n);

export class DelphiVenue {
  constructor() {
    for (const k of ['WALLET_PRIVATE_KEY', 'DELPHI_API_ACCESS_KEY']) {
      if (!process.env[k]) throw new Error(`DelphiVenue: missing ${k} (see .env.example)`);
    }
    this.client = new DelphiClient({
      network: process.env.DELPHI_NETWORK ?? 'competition-testnet',
      signerType: 'private_key',
    });
    this.held = new Map();     // marketAddress -> { side, outcomeIdx, shares, spent }
    this.badMarkets = new Set(); // failed to quote — don't hammer them every tick
  }

  /** Marginal YES price from a tiny quote: tokensIn per share bought. */
  async priceOf(marketAddress, outcomeIdx) {
    const { tokensIn } = await this.client.quoteBuy({
      marketAddress, outcomeIdx, sharesOut: PROBE_SHARES,
    });
    return toFloat(tokensIn) / toFloat(PROBE_SHARES);
  }

  async markets(now) {
    const { markets } = await this.client.listMarkets({
      status: 'open', orderBy: 'liquidity', limit: 50,
    });
    const out = [];
    for (const m of markets) {
      if (this.badMarkets.has(m.id) || this.held.has(m.id)) continue;
      // Settlement time: field name is not pinned in the README — probe candidates.
      const settleRaw = m.settlesAt ?? m.settles_at ?? m.settleAt ?? m.closesAt ?? null;
      const settleMs = settleRaw ? new Date(settleRaw).getTime() : null;
      try {
        const pYes = await this.priceOf(m.id, 0);
        const pNo = await this.priceOf(m.id, 1);
        // Sanity: a binary book should roughly sum to 1. Wide LMSR spread → thin market, skip.
        if (!(pYes > 0 && pNo > 0) || Math.abs(pYes + pNo - 1) > 0.10) {
          this.badMarkets.add(m.id);
          continue;
        }
        out.push({
          id: m.id,
          yesPrice: pYes,
          closesInMs: settleMs ? settleMs - now : undefined,
        });
      } catch {
        this.badMarkets.add(m.id); // non-binary or unquotable — never guess
      }
    }
    return out;
  }

  async stake(marketAddress, side, amount) {
    const outcomeIdx = side === 'YES' ? 0 : 1;
    const price = await this.priceOf(marketAddress, outcomeIdx);
    // Spend ≈ amount tokens: shares = amount / price, then re-quote for the exact cost.
    const shares = toWei(amount / price);
    const { tokensIn } = await this.client.quoteBuy({ marketAddress, outcomeIdx, sharesOut: shares });
    const maxTokensIn = (tokensIn * 102n) / 100n; // 2% slippage cap
    await this.client.ensureTokenApproval({ marketAddress, minimumAmount: maxTokensIn });
    await this.client.buyShares({ marketAddress, outcomeIdx, sharesOut: shares, maxTokensIn });
    this.held.set(marketAddress, { side, outcomeIdx, shares, spent: toFloat(tokensIn) });
  }

  async resolutions() {
    const done = [];
    for (const [addr, pos] of this.held) {
      let status;
      try { status = await this.client.getMarketStatus(addr); } catch { continue; }
      if (status === 'open' || status === 'awaiting_settlement') continue;

      let ret = 0;
      try {
        if (status === 'settled') {
          const { tokensOut } = await this.client.redeemMarket({ marketAddress: addr });
          ret = toFloat(tokensOut ?? 0n);
        } else { // expired | failed — no winning outcome; recover collateral
          const { totalTokensOut } = await this.client.liquidate({
            marketAddress: addr, outcomeIndices: [0, 1],
          });
          ret = toFloat(totalTokensOut ?? 0n);
        }
      } catch (e) {
        // Redeem reverting usually means we held the losing side: ret stays 0.
        if (!/revert|NothingToRedeem/i.test(String(e))) continue; // transient → retry next tick
      }
      this.held.delete(addr);
      done.push({ id: addr, winner: ret > 0 ? pos.side : (pos.side === 'YES' ? 'NO' : 'YES'), ret });
    }
    return done;
  }
}
