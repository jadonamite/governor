/**
 * Governor runner — discover markets → forecast → estimate → pace → stake → learn.
 *
 * MODE=paper  a simulated venue with a hidden true probability, paired with a
 *             forecaster that sees it noisily. Proves the loop and drives the
 *             naive-vs-paced comparison chart.
 * MODE=live   Delphi Agent Arena (competition-testnet) via ./delphi-venue.js.
 *
 * Every decision — bet, skip or paced — is appended to decisions.ndjson. The
 * log is the audit trail: any run can be replayed and challenged from it.
 *
 * SIZING. Kelly is a fraction of BANKROLL; the floor is a separate absolute
 * cap. The stake is min(bankrollFrac × bankroll, maxPerPosition). Multiplying
 * the Kelly fraction by the floor instead applies the shrink twice.
 */

'use strict';

import { appendFileSync, mkdirSync } from 'node:fs';
import { Governor } from './pacer.js';
import { estimate, DEFAULTS } from './estimator.js';
import { forecastFor } from './forecasters/index.js';

const MODE = process.env.MODE ?? 'paper';
const TICK_MS = Number(process.env.TICK_MS ?? 30_000);
const LOG_DIR = new URL('../logs/', import.meta.url).pathname;
const LOG = `${LOG_DIR}decisions.ndjson`;

// ---------------------------------------------------------------- floor config
// The floor is deliberately in code, not env: changing it should be a commit.
//
// Phase 0 ran at 25 and is done — the first live fill verified buy, position,
// cost basis, decimals and slippage against chain. Raised to 150 so that KELLY
// binds rather than the floor: on a 13-point edge quarter-Kelly wants ~155 TST,
// and a floor of 25 was throwing away five sixths of every good position.
//
// The floor's job is to stop a BUG, not to stop a strategy. The retry-loop
// invariant and the daily cap are what make that safe, and neither is relaxed
// here in spirit — maxDailySpend still bounds a runaway to a knowable number.
// Raised again on an explicit call to take more risk. The floor's job was
// never to express caution — it is there to stop a BUG (a NaN, a runaway retry
// loop, a broken estimate) from spending the stack. Risk appetite belongs in
// the Kelly fraction, which is where it now lives. The invariant is unchanged:
// no sequence of requests, however malformed, spends past maxDailySpend.
const FLOOR = {
  maxPerPosition: Number(process.env.MAX_PER_POSITION ?? 600),
  maxInflight: Number(process.env.MAX_INFLIGHT ?? 1200),
  maxDailySpend: Number(process.env.MAX_DAILY_SPEND ?? 4000),
  seedInflight: 600,
};

// ---------------------------------------------------------------- paper venue
/** Simulated venue: hidden true prob, displayed price skewed off it. */
class PaperVenue {
  constructor(seed = 42) {
    this.rng = mulberry32(seed);
    this.open = new Map();
    this.n = 0;
    this.held = new Map();
  }
  async init() { return { address: 'paper', tokenDp: 6, recovered: 0 }; }
  async balance() { return 1000; }
  skew(p) { return Math.min(0.97, Math.max(0.03, p * 0.9 + 0.05)); }
  async markets(now) {
    while (this.open.size < 8) {
      const truth = this.rng();
      const id = `paper-${this.n++}`;
      this.open.set(id, { id, truth, yes: this.skew(truth), closesAt: now + (30 + this.rng() * 240) * 60e3 });
    }
    return [...this.open.values()]
      .filter((m) => !this.held.has(m.id))
      .map((m) => ({
        id: m.id,
        question: `paper market ${m.id}`,
        _truth: m.truth,
        outcomes: [
          { idx: 0, name: 'Yes', price: m.yes },
          { idx: 1, name: 'No', price: 1 - m.yes },
        ],
        closesInMs: m.closesAt - now,
        resolvesAtMs: m.closesAt,
      }));
  }
  async stake(id, outcomeIdx, tokens, price) {
    this.held.set(id, { outcomeIdx, spent: tokens, shares: tokens / price });
    return { shares: tokens / price, spent: tokens };
  }
  async resolutions(now = Date.now()) {
    const done = [];
    for (const [id, m] of this.open) {
      if (now < m.closesAt) continue;
      this.open.delete(id);
      const pos = this.held.get(id);
      if (!pos) continue;
      this.held.delete(id);
      const yesWon = this.rng() < m.truth;
      const won = (pos.outcomeIdx === 0) === yesWon;
      done.push({ id, outcomeIdx: pos.outcomeIdx, ret: won ? pos.shares : 0, spent: pos.spent });
    }
    return done;
  }
}

/**
 * Paper forecaster: sees the hidden truth through noise. This is the honest
 * analogue of a real forecaster — it has genuine skill, not perfect knowledge,
 * so the paper run exercises the same abstain/size logic as live.
 */
function paperForecaster(rng) {
  return async (m) => {
    if (m._truth === undefined) return null;
    const noisy = Math.min(0.98, Math.max(0.02, m._truth + (rng() - 0.5) * 0.15));
    return { probs: [noisy, 1 - noisy], source: 'paper', note: 'truth+noise' };
  };
}

// ---------------------------------------------------------------- wiring
async function makeVenue() {
  if (MODE !== 'live') return new PaperVenue();
  const { DelphiVenue } = await import('./delphi-venue.js');
  return new DelphiVenue();
}

function log(entry) {
  appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- the loop
/**
 * Retry forever with capped backoff.
 *
 * This process is meant to run unattended for days on a connection that drops
 * regularly. A transient fetch failure during boot must never be allowed to
 * kill it — the first version exited on the first ETIMEDOUT and the agent was
 * simply gone, holding open positions nobody was redeeming.
 */
async function persist(label, fn, capMs = 60_000) {
  let wait = 2_000;
  for (;;) {
    try { return await fn(); } catch (e) {
      console.error(`${label} failed: ${String(e.message ?? e).slice(0, 120)} — retrying in ${wait / 1000}s`);
      log({ event: 'retry', label, message: String(e.message ?? e).slice(0, 200) });
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(capMs, wait * 2);
    }
  }
}

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  const venue = await makeVenue();
  const info = await persist('init', () => venue.init());
  const forecaster = MODE === 'live' ? forecastFor : paperForecaster(mulberry32(7));
  const gov = new Governor(FLOOR);
  const held = new Map();

  console.log(`governor up · mode=${MODE} · wallet=${info.address} · recovered=${info.recovered} · floor=${JSON.stringify(FLOOR)}`);
  log({ event: 'boot', mode: MODE, floor: FLOOR, ...info });

  const tick = async () => {
    const now = Date.now();

    // 1. Learn from resolutions first — money comes home before it goes out.
    for (const r of await venue.resolutions(now)) {
      const pos = held.get(r.id);
      held.delete(r.id);
      gov.onResult(r.id, r.ret);
      log({
        event: 'resolve', id: r.id, outcomeIdx: r.outcomeIdx,
        ret: +r.ret.toFixed(4),
        spent: Number.isFinite(r.spent) ? +r.spent.toFixed(4) : null,
        pnl: Number.isFinite(r.spent) ? +(r.ret - r.spent).toFixed(4) : null,
        question: pos?.question,
      });
    }

    // 2. Scan and act. Kelly is taken against CASH, not total equity — as
    // capital gets deployed the next bet sizes off what is actually free,
    // which is the conservative reading and the one we can spend.
    const bankroll = await venue.balance();

    // Tournament objective: how many multiples of current CASH we still need to
    // reach the paying zone. Bold play bets harder the further behind we are.
    const shortfall = DEFAULTS.targetEquity / Math.max(1, bankroll);
    const cfg = { ...DEFAULTS, shortfall };

    for (const m of await venue.markets(now)) {
      if (held.has(m.id)) continue;

      const fc = await forecaster(m, now);
      const d = estimate(m, fc, cfg);
      if (d.action === 'skip') { log({ event: 'skip', id: m.id, reason: d.reason }); continue; }

      // Kelly is of bankroll; the floor is an absolute cap on top of it.
      const stake = +Math.min(d.bankrollFrac * bankroll, FLOOR.maxPerPosition).toFixed(2);
      if (stake <= 0) { log({ event: 'skip', id: m.id, reason: 'stake-zero' }); continue; }

      const verdict = gov.request(m.id, stake);
      if (!verdict.allowed) { log({ event: 'paced', id: m.id, stake, reason: verdict.reason }); continue; }

      const fill = await venue.stake(m.id, d.outcomeIdx, stake, d.price);
      if (!fill) {
        gov.onResult(m.id, 0);          // release the reservation the pacer just made
        log({ event: 'unfilled', id: m.id, stake, reason: 'depth' });
        continue;
      }
      held.set(m.id, { outcomeIdx: d.outcomeIdx, stake: fill.spent, question: m.question });
      log({
        event: 'bet', id: m.id, side: d.side, outcomeIdx: d.outcomeIdx,
        stake: +fill.spent.toFixed(4), shares: +fill.shares.toFixed(4),
        q: +d.q.toFixed(4), price: +d.price.toFixed(4), edge: +d.edge.toFixed(4),
        kellyFull: +d.kellyFull.toFixed(4), payoff: +(d.payoff ?? 0).toFixed(2),
        boldness: +(d.boldness ?? 1).toFixed(2), source: fc.source, question: m.question,
      });
    }

    // 3. Heartbeat.
    const s = gov.snapshot();
    log({ event: 'heartbeat', state: s.state, inflight: s.inflight, open: s.openPositions, cap: +s.modelCap.toFixed(2), v: s.valueRate, spent24h: s.spent24h, bankroll });
    console.log(`[${new Date().toISOString()}] ${s.state} bankroll=${bankroll.toFixed(0)} inflight=${s.inflight.toFixed(0)} cap=${s.modelCap.toFixed(0)} open=${s.openPositions} spent24h=${s.spent24h.toFixed(0)} allowed=${s.stats.allowed} paced=${s.stats.deniedModel} floored=${s.stats.deniedFloor}`);
  };

  const safeTick = () => tick().catch((e) => {
    // A failed tick is a skipped tick, never a dead agent. The next one runs.
    console.error(`tick failed: ${String(e.message ?? e).slice(0, 160)}`);
    log({ event: 'error', message: String(e.message ?? e).slice(0, 300) });
  });

  await safeTick();
  setInterval(safeTick, TICK_MS);
}

// Nothing below the tick loop may take the process down: an unattended agent
// that exits stops redeeming its own settled positions.
process.on('unhandledRejection', (e) => {
  console.error(`unhandledRejection: ${String(e?.message ?? e).slice(0, 160)}`);
  log({ event: 'unhandledRejection', message: String(e?.message ?? e).slice(0, 300) });
});

main().catch((e) => {
  console.error(e);
  log({ event: 'fatal', message: String(e?.message ?? e).slice(0, 300) });
  process.exit(1);
});
