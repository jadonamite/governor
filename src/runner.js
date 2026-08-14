/**
 * Governor runner — discover markets → estimate → pace → stake → learn.
 *
 * MODE=paper  (default until the wallet is registered): a simulated venue —
 *             markets with a hidden true probability, prices skewed by the
 *             favorite-longshot bias the estimator hunts. Proves the loop.
 * MODE=live   Delphi testnet via @gensyn-ai/gensyn-delphi-sdk (adapter below).
 *
 * Every decision — bet or skip — is appended to decisions.ndjson. The log is
 * the audit trail: any run can be replayed and challenged from it.
 */

'use strict';

import { appendFileSync, mkdirSync } from 'node:fs';
import { Governor } from './pacer.js';
import { estimate } from './estimator.js';

const MODE = process.env.MODE ?? 'paper';
const TICK_MS = Number(process.env.TICK_MS ?? 30_000);
const LOG_DIR = new URL('../logs/', import.meta.url).pathname;
const LOG = `${LOG_DIR}decisions.ndjson`;

// ---------------------------------------------------------------- floor config
// The floor is deliberately in code, not env: changing it should be a commit.
const FLOOR = {
  maxPerPosition: 25,     // testnet units
  maxInflight: 200,
  maxDailySpend: 400,
  seedInflight: 60,
};

// ---------------------------------------------------------------- paper venue
/** Simulated venue: hidden true prob, displayed price skewed by longshot bias. */
class PaperVenue {
  constructor(seed = 42) {
    this.rng = mulberry32(seed);
    this.open = new Map(); // id -> { truth, yesPrice, closesAt }
    this.n = 0;
  }
  /** Skew: favorites displayed cheaper than truth, longshots dearer (the bias). */
  skew(p) { return Math.min(0.99, Math.max(0.01, p * 0.94 + 0.03)); }
  async markets(now) {
    // Keep ~8 markets open; spawn with varied truths.
    while (this.open.size < 8) {
      const truth = this.rng();
      const id = `paper-${this.n++}`;
      this.open.set(id, {
        id, truth,
        yesPrice: this.skew(truth),
        closesAt: now + (30 + this.rng() * 240) * 60e3, // 30min–4.5h out
      });
    }
    return [...this.open.values()].map(m => ({
      id: m.id, yesPrice: m.yesPrice, closesInMs: m.closesAt - now,
    }));
  }
  async stake(_id, _side, _amount) { /* paper: nothing to sign */ }
  /** Resolve closed markets; return [{id, side:'YES'|'NO' winner}] */
  async resolutions(now) {
    const done = [];
    for (const [id, m] of this.open) {
      if (now >= m.closesAt) {
        done.push({ id, winner: this.rng() < m.truth ? 'YES' : 'NO' });
        this.open.delete(id);
      }
    }
    return done;
  }
}

// ---------------------------------------------------------------- live venue
// Real adapter in ./delphi-venue.js (SDK 2.1.0, competition-testnet).
// Needs: registered competition wallet + WALLET_PRIVATE_KEY + DELPHI_API_ACCESS_KEY.
async function makeVenue() {
  if (MODE !== 'live') return new PaperVenue();
  const { DelphiVenue } = await import('./delphi-venue.js');
  return new DelphiVenue();
}

// ---------------------------------------------------------------- the loop
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

async function main() {
  mkdirSync(LOG_DIR, { recursive: true });
  const venue = await makeVenue();
  const gov = new Governor(FLOOR);
  const held = new Map(); // id -> { side, stake }

  console.log(`governor up · mode=${MODE} · tick=${TICK_MS}ms · floor=${JSON.stringify(FLOOR)}`);
  log({ event: 'boot', mode: MODE, floor: FLOOR });

  const tick = async () => {
    const now = Date.now();

    // 1. Learn from resolutions first — money comes home before it goes out.
    for (const r of await venue.resolutions(now)) {
      const pos = held.get(r.id);
      if (!pos) continue;
      held.delete(r.id);
      const won = pos.side === r.winner;
      // Live venue reports actual tokens returned; paper derives from price.
      const ret = r.ret !== undefined ? r.ret : (won ? pos.stake / pos.price : 0);
      gov.onResult(r.id, ret);
      log({ event: 'resolve', id: r.id, won, stake: pos.stake, ret: +ret.toFixed(4) });
    }

    // 2. Scan and act.
    for (const m of await venue.markets(now)) {
      if (held.has(m.id)) continue;
      const d = estimate(m);
      if (d.action === 'skip') { log({ event: 'skip', id: m.id, reason: d.reason }); continue; }

      const stake = +(FLOOR.maxPerPosition * d.stakeFrac).toFixed(2);
      const verdict = gov.request(m.id, stake);
      if (!verdict.allowed) {
        log({ event: 'paced', id: m.id, stake, reason: verdict.reason });
        continue;
      }
      const price = d.side === 'YES' ? m.yesPrice : 1 - m.yesPrice;
      await venue.stake(m.id, d.side, stake);
      held.set(m.id, { side: d.side, stake, price });
      log({ event: 'bet', id: m.id, side: d.side, stake, price: +price.toFixed(3), edge: +d.edge.toFixed(4) });
    }

    // 3. Heartbeat.
    const s = gov.snapshot();
    log({ event: 'heartbeat', state: s.state, inflight: s.inflight, open: s.openPositions, cap: +s.modelCap.toFixed(2), v: s.valueRate, spent24h: s.spent24h });
    console.log(`[${new Date().toISOString()}] ${s.state} inflight=${s.inflight.toFixed(0)} cap=${s.modelCap.toFixed(0)} open=${s.openPositions} spent24h=${s.spent24h.toFixed(0)} allowed=${s.stats.allowed} paced=${s.stats.deniedModel} floored=${s.stats.deniedFloor}`);
  };

  await tick();
  setInterval(() => tick().catch(e => { console.error(e); log({ event: 'error', message: String(e) }); }), TICK_MS);
}

main().catch(e => { console.error(e); process.exit(1); });
