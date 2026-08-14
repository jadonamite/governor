import test from 'node:test';
import assert from 'node:assert/strict';
import { Governor, STARTUP, PROBE } from '../src/pacer.js';

function makeGov(overrides = {}) {
  let t = 0;
  const clock = () => t;
  const gov = new Governor({
    maxPerPosition: 10,
    maxInflight: 50,
    maxDailySpend: 100,
    seedInflight: 20,
    clock,
    ...overrides,
  });
  return { gov, tick: (ms) => { t += ms; } };
}

test('floor: retry loop cannot spend past maxDailySpend — THE invariant', () => {
  const { gov } = makeGov();
  let granted = 0;
  // A berserk agent retries 10,000 times.
  for (let i = 0; i < 10_000; i++) {
    const r = gov.request(`retry-${i}`, 10);
    if (r.allowed) granted += 10;
  }
  assert.ok(granted <= 100, `granted ${granted} > maxDailySpend 100`);
});

test('floor: duplicate position id is rejected (idempotency)', () => {
  const { gov } = makeGov();
  assert.equal(gov.request('a', 5).allowed, true);
  const dup = gov.request('a', 5);
  assert.equal(dup.allowed, false);
  assert.equal(dup.reason, 'floor:duplicate-id');
});

test('floor: per-position cap holds even in STARTUP euphoria', () => {
  const { gov } = makeGov();
  assert.equal(gov.state, STARTUP);
  const r = gov.request('big', 11);
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'floor:per-position');
});

test('floor: NaN/negative/zero amounts are rejected before touching the model', () => {
  const { gov } = makeGov();
  for (const bad of [NaN, -5, 0, Infinity]) {
    assert.equal(gov.request(`bad-${bad}`, bad).allowed, false);
  }
});

test('floor: inflight cap blocks even when daily budget remains', () => {
  const { gov } = makeGov({ maxDailySpend: 1000 });
  let inflightGranted = 0;
  for (let i = 0; i < 100; i++) {
    if (gov.request(`p${i}`, 10).allowed) inflightGranted += 10;
  }
  assert.ok(inflightGranted <= 50, `inflight ${inflightGranted} > maxInflight 50`);
});

test('daily window slides: capacity returns after 24h', () => {
  const { gov, tick } = makeGov();
  for (let i = 0; i < 10; i++) gov.request(`d${i}`, 10); // exhaust 100/day
  assert.equal(gov.request('blocked', 10).allowed, false);
  // Resolve everything so inflight frees too.
  for (let i = 0; i < 10; i++) gov.onResult(`d${i}`, 10);
  tick(25 * 3600e3);
  assert.equal(gov.request('fresh', 10).allowed, true);
});

test('resolutions free inflight', () => {
  const { gov } = makeGov({ maxDailySpend: 1000 });
  gov.request('x', 10);
  assert.equal(gov.snapshot().inflight, 10);
  gov.onResult('x', 12);
  assert.equal(gov.snapshot().inflight, 0);
  assert.equal(gov.snapshot().openPositions, 0);
});

test('losing streak shrinks the model cap (health collapse)', () => {
  const { gov, tick } = makeGov({ maxDailySpend: 10_000 });
  // Feed pure losses.
  for (let i = 0; i < 10; i++) {
    gov.request(`loss-${i}`, 10);
    tick(60e3);
    gov.onResult(`loss-${i}`, 0); // total loss
  }
  const cap = gov.snapshot().modelCap;
  // health=0.25 → cap ≤ 0.25 × gain × maxInflight; even at startup gain 2.0 that's ≤ 25… but
  // modelCap is clamped to maxInflight; with losses: 50 × 0.25 × gain ≤ 25 for gain ≤ 2.
  assert.ok(cap <= 25, `cap ${cap} did not shrink after pure losses`);
});

test('state machine: STARTUP exits after growth stalls, reaches PROBE', () => {
  const { gov, tick } = makeGov({ maxDailySpend: 100_000, maxInflight: 1000, maxPerPosition: 10 });
  // Flat, modest wins → valueRate stops improving → DRAIN → PROBE.
  for (let i = 0; i < 12; i++) {
    gov.request(`w${i}`, 10);
    tick(60e3);
    gov.onResult(`w${i}`, 10.4); // steady +4%
  }
  assert.equal(gov.state, PROBE, `expected PROBE, got ${gov.state}`);
});

test('constructor refuses a missing floor', () => {
  assert.throws(() => new Governor({ maxPerPosition: 10, maxInflight: 50 }));
  assert.throws(() => new Governor({ maxPerPosition: 10, maxDailySpend: 100 }));
  assert.throws(() => new Governor({}));
});
