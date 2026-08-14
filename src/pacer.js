/**
 * Governor — a BBR-style pacing controller for capital deployment.
 *
 * The transplant: TCP congestion control models the path (bottleneck bandwidth
 * × round-trip time) and paces packets to that product, instead of blasting
 * until packet loss. Netflix carried the same idea into RPC concurrency
 * (concurrency-limits). Governor carries it one hop further: requests → money.
 *
 *   BtlBw   (bytes/sec)  →  valueRate     (realized return per unit staked)
 *   RTprop  (sec)        →  resultLatency (ms from stake to resolution)
 *   BDP = BtlBw×RTprop   →  inflight cap  (capital allowed to be unresolved)
 *
 * States, straight from BBR:
 *   STARTUP — ramp with high gain while valueRate keeps improving
 *   DRAIN   — shed overshoot after startup finds the ceiling
 *   PROBE   — cruise at the model, periodically probe up, then ease off
 *
 * Two layers of protection, deliberately separate:
 *   1. The MODEL (adaptive): inflight cap from valueRate × latency window.
 *   2. The FLOOR (absolute): maxPerPosition / maxInflight / maxDailySpend.
 *      The floor holds NO MATTER WHAT the model says. A retry loop, a
 *      poisoned estimator, or NaN math must be unable to spend past it.
 */

'use strict';

/** Windowed max — BBR keeps a windowed max of delivered bandwidth. */
class WindowedMax {
  constructor(windowMs) { this.windowMs = windowMs; this.samples = []; }
  push(value, now = Date.now()) {
    this.samples.push({ value, at: now });
    this.trim(now);
  }
  trim(now) { this.samples = this.samples.filter(s => now - s.at <= this.windowMs); }
  get(now = Date.now()) {
    this.trim(now);
    return this.samples.length ? Math.max(...this.samples.map(s => s.value)) : null;
  }
}

/** Windowed min — BBR keeps a windowed min of RTT. */
class WindowedMin {
  constructor(windowMs) { this.windowMs = windowMs; this.samples = []; }
  push(value, now = Date.now()) {
    this.samples.push({ value, at: now });
    this.trim(now);
  }
  trim(now) { this.samples = this.samples.filter(s => now - s.at <= this.windowMs); }
  get(now = Date.now()) {
    this.trim(now);
    return this.samples.length ? Math.min(...this.samples.map(s => s.value)) : null;
  }
}

const STARTUP = 'STARTUP';
const DRAIN = 'DRAIN';
const PROBE = 'PROBE';

// BBR's ProbeBW gain cycle: probe up, ease off, cruise.
const PROBE_CYCLE = [1.25, 0.75, 1, 1, 1, 1, 1, 1];
const STARTUP_GAIN = 2.0;   // BBRv3 startup pacing gain territory (2.0–2.77)
const DRAIN_GAIN = 0.5;

export class Governor {
  /**
   * @param {object} opts
   * @param {number} opts.maxPerPosition  hard cap per single stake (floor layer)
   * @param {number} opts.maxInflight     hard cap on unresolved capital (floor layer)
   * @param {number} opts.maxDailySpend   hard cap on gross stake per rolling 24h (floor layer)
   * @param {number} [opts.seedInflight]  model cap before any results exist
   * @param {number} [opts.valueWindowMs] window for valueRate max (default 6h)
   * @param {number} [opts.latencyWindowMs] window for latency min (default 24h)
   * @param {number} [opts.probeStepMs]   how long each probe-cycle phase lasts (default 30min)
   * @param {() => number} [opts.clock]
   */
  constructor(opts) {
    for (const k of ['maxPerPosition', 'maxInflight', 'maxDailySpend']) {
      if (!(Number.isFinite(opts?.[k]) && opts[k] > 0)) {
        throw new Error(`Governor: ${k} must be a positive finite number (the floor is not optional)`);
      }
    }
    this.floor = {
      maxPerPosition: opts.maxPerPosition,
      maxInflight: opts.maxInflight,
      maxDailySpend: opts.maxDailySpend,
    };
    this.clock = opts.clock ?? (() => Date.now());
    this.seedInflight = opts.seedInflight ?? opts.maxInflight * 0.1;

    this.valueRate = new WindowedMax(opts.valueWindowMs ?? 6 * 3600e3);
    this.resultLatency = new WindowedMin(opts.latencyWindowMs ?? 24 * 3600e3);

    this.state = STARTUP;
    this.probeIdx = 0;
    this.probeStepMs = opts.probeStepMs ?? 30 * 60e3;
    this.lastProbeStep = this.clock();

    this.inflight = 0;                 // unresolved capital
    this.positions = new Map();        // id -> { stake, at }
    this.spendLog = [];                // { amount, at } for rolling 24h
    this.startupPrevRate = null;
    this.startupStalls = 0;

    this.stats = { requested: 0, allowed: 0, deniedFloor: 0, deniedModel: 0, resolved: 0 };
  }

  /** Rolling 24h gross spend (floor layer). */
  spentLast24h(now = this.clock()) {
    this.spendLog = this.spendLog.filter(s => now - s.at <= 24 * 3600e3);
    return this.spendLog.reduce((a, s) => a + s.amount, 0);
  }

  /** Current pacing gain from the state machine. */
  gain(now = this.clock()) {
    if (this.state === STARTUP) return STARTUP_GAIN;
    if (this.state === DRAIN) return DRAIN_GAIN;
    if (now - this.lastProbeStep >= this.probeStepMs) {
      this.probeIdx = (this.probeIdx + 1) % PROBE_CYCLE.length;
      this.lastProbeStep = now;
    }
    return PROBE_CYCLE[this.probeIdx];
  }

  /**
   * The model's inflight cap — the budget-delay product.
   * valueRate is return-per-unit-staked (dimensionless, e.g. 0.04 = 4%);
   * we convert to "capital that earns" via the floor's inflight scale, so the
   * model can only ever *shrink* the envelope the floor grants, scaled by gain.
   */
  modelCap(now = this.clock()) {
    const v = this.valueRate.get(now);
    const l = this.resultLatency.get(now);
    if (v === null || l === null) return this.seedInflight * this.gain(now);
    // Positive observed value → willing to keep up to gain × floor inflight.
    // Value ≤ 0 → shrink hard: capital in flight is losing, not earning.
    const health = v > 0 ? 1 : 0.25;
    const cap = this.floor.maxInflight * health * this.gain(now);
    return Math.min(cap, this.floor.maxInflight);
  }

  /**
   * Ask permission to stake.
   * @param {string} id      unique position id (idempotency key — replays are rejected)
   * @param {number} amount
   * @returns {{allowed: boolean, reason: string}}
   */
  request(id, amount) {
    const now = this.clock();
    this.stats.requested++;

    // ---- FLOOR (absolute; checked first; immune to model state) ----
    if (!Number.isFinite(amount) || amount <= 0) {
      this.stats.deniedFloor++;
      return { allowed: false, reason: 'floor:invalid-amount' };
    }
    if (this.positions.has(id)) {
      this.stats.deniedFloor++;
      return { allowed: false, reason: 'floor:duplicate-id' };
    }
    if (amount > this.floor.maxPerPosition) {
      this.stats.deniedFloor++;
      return { allowed: false, reason: 'floor:per-position' };
    }
    if (this.inflight + amount > this.floor.maxInflight) {
      this.stats.deniedFloor++;
      return { allowed: false, reason: 'floor:max-inflight' };
    }
    if (this.spentLast24h(now) + amount > this.floor.maxDailySpend) {
      this.stats.deniedFloor++;
      return { allowed: false, reason: 'floor:daily-spend' };
    }

    // ---- MODEL (adaptive) ----
    const cap = this.modelCap(now);
    if (this.inflight + amount > cap) {
      this.stats.deniedModel++;
      return { allowed: false, reason: `model:pacing (cap=${cap.toFixed(2)}, state=${this.state})` };
    }

    // Committed.
    this.positions.set(id, { stake: amount, at: now });
    this.inflight += amount;
    this.spendLog.push({ amount, at: now });
    this.stats.allowed++;
    return { allowed: true, reason: `ok:${this.state}` };
  }

  /**
   * Report a resolution. `ret` is the gross amount returned for the position
   * (0 = total loss, stake = break-even, >stake = profit).
   * @param {string} id
   * @param {number} ret
   */
  onResult(id, ret) {
    const pos = this.positions.get(id);
    if (!pos) return;
    const now = this.clock();
    this.positions.delete(id);
    this.inflight = Math.max(0, this.inflight - pos.stake);
    this.stats.resolved++;

    const latency = Math.max(1, now - pos.at);
    const perUnit = (ret - pos.stake) / pos.stake; // realized return per unit staked
    this.resultLatency.push(latency, now);
    this.valueRate.push(perUnit, now);

    this.advanceState(now);
  }

  /** STARTUP → DRAIN when valueRate stops improving; DRAIN → PROBE when inflight ≤ model. */
  advanceState(now) {
    if (this.state === STARTUP) {
      const v = this.valueRate.get(now);
      if (v !== null && this.startupPrevRate !== null) {
        // BBR exits startup after 3 rounds of <25% growth.
        if (v <= this.startupPrevRate * 1.25) this.startupStalls++;
        else this.startupStalls = 0;
        if (this.startupStalls >= 3) this.state = DRAIN;
      }
      this.startupPrevRate = v;
    } else if (this.state === DRAIN) {
      if (this.inflight <= this.modelCap(now)) {
        this.state = PROBE;
        this.lastProbeStep = now;
        this.probeIdx = PROBE_CYCLE.length - 1; // enter on cruise, not a probe spike
      }
    }
  }

  snapshot() {
    const now = this.clock();
    return {
      state: this.state,
      inflight: this.inflight,
      openPositions: this.positions.size,
      modelCap: this.modelCap(now),
      valueRate: this.valueRate.get(now),
      resultLatencyMs: this.resultLatency.get(now),
      spent24h: this.spentLast24h(now),
      floor: { ...this.floor },
      stats: { ...this.stats },
    };
  }
}

export { WindowedMax, WindowedMin, STARTUP, DRAIN, PROBE };
