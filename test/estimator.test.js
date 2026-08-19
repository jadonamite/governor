import test from 'node:test';
import assert from 'node:assert/strict';
import { estimate, DEFAULTS } from '../src/estimator.js';

const mkt = (prices, closesInMs = 6 * 3600e3) => ({
  id: 'm1',
  outcomes: prices.map((price, idx) => ({ idx, name: `o${idx}`, price })),
  closesInMs,
});

// The first test is the whole argument: v0 asserted an edge, v1 refuses to act
// without one. Most markets have no forecaster, and that must stay a skip.
test('no forecaster is a skip, never a guess', () => {
  const d = estimate(mkt([0.5, 0.5]), null);
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'no-forecaster');
});

test('forecast shape must match the outcomes', () => {
  const d = estimate(mkt([0.5, 0.5]), { probs: [0.6], source: 't' });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'forecast-shape-mismatch');
});

test('an unnormalised forecast is refused rather than rescaled', () => {
  const d = estimate(mkt([0.5, 0.5]), { probs: [0.9, 0.9], source: 't' });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'forecast-not-normalised');
});

test('prices that do not sum to 1 mean the wrong network — refuse', () => {
  const d = estimate(mkt([0.6, 0.6]), { probs: [0.9, 0.1], source: 't' });
  assert.equal(d.action, 'skip');
  assert.equal(d.reason, 'prices-do-not-sum-to-1');
});

test('edge below the floor is a named skip', () => {
  const d = estimate(mkt([0.5, 0.5]), { probs: [0.52, 0.48], source: 't' });
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /^edge-below-floor/);
});

test('the 0.5% fee is charged on the cost side', () => {
  // q − price = 0.10 gross; fee on a 0.50 price costs 0.0025, so edge is 0.0975.
  const d = estimate(mkt([0.5, 0.5]), { probs: [0.6, 0.4], source: 't' });
  assert.equal(d.action, 'bet');
  assert.ok(Math.abs(d.edge - (0.6 - 0.5 * 1.005)) < 1e-12, `edge was ${d.edge}`);
});

test('picks the best outcome across a multi-outcome market', () => {
  const d = estimate(mkt([0.30, 0.30, 0.20, 0.20]), {
    probs: [0.30, 0.30, 0.15, 0.25], source: 't',
  });
  assert.equal(d.action, 'bet');
  assert.equal(d.outcomeIdx, 3); // 0.25 vs 0.20 is the only real gap
});

// REGRESSION. bankrollFrac is a fraction of BANKROLL. It was previously
// multiplied by maxPerPosition at the call site, which applied the Kelly
// shrink twice and under-deployed by the ratio between them (~6x on the live
// Mississippi position: 3.94 TST staked where the floor allowed 25).
test('bankrollFrac is a fraction of bankroll, not of the position floor', () => {
  const d = estimate(mkt([0.17, 0.83]), { probs: [0.06, 0.94], source: 't' });
  assert.equal(d.action, 'bet');
  assert.equal(d.outcomeIdx, 1);

  const cost = 0.83 * (1 + DEFAULTS.feeRate);
  const kellyFull = (0.94 - cost) / (1 - cost);
  assert.ok(Math.abs(d.kellyFull - kellyFull) < 1e-12);

  // Tournament mode overbets Kelly deliberately, capped at the whole bankroll.
  const expected = Math.min(DEFAULTS.maxStakeFrac, kellyFull * DEFAULTS.kellyFraction);
  assert.ok(Math.abs(d.bankrollFrac - expected) < 1e-12, `got ${d.bankrollFrac}`);

  // Whatever the fraction, it is applied to BANKROLL and then floor-capped.
  const stake = Math.min(d.bankrollFrac * 1000, 25);
  assert.equal(stake, 25);
});

// Tournament objective: among outcomes that clear the edge floor, the
// high-payoff one wins even when a safer outcome has a slightly larger raw
// edge. A step-function payoff needs variance, and variance is in the
// low-priced outcomes.
test('prefers the high-payoff outcome when both clear the edge floor', () => {
  // outcome 0 @0.10 -> q 0.20 (edge ~0.099, payoff ~10x)
  // outcome 1 @0.90 -> q 0.80 (edge negative) ; use a 3-way to isolate
  const m = {
    id: 'm',
    outcomes: [
      { idx: 0, name: 'longshot', price: 0.10 },
      { idx: 1, name: 'favourite', price: 0.60 },
      { idx: 2, name: 'other', price: 0.30 },
    ],
    closesInMs: 6 * 3600e3,
  };
  const d = estimate(m, { probs: [0.20, 0.71, 0.09], source: 't' });
  assert.equal(d.action, 'bet');
  // favourite has the bigger raw edge (0.71-0.603=0.107 vs 0.20-0.1005=0.0995)
  // but the longshot pays ~10x against ~1.7x, so tournament score picks it.
  assert.equal(d.outcomeIdx, 0, `picked ${d.outcomeIdx}`);
  assert.ok(d.payoff > 9);
});

test('too close to resolution, and too far out, both skip', () => {
  const f = { probs: [0.9, 0.1], source: 't' };
  assert.equal(estimate(mkt([0.5, 0.5], 60e3), f).reason, 'too-close-to-resolution');
  assert.equal(estimate(mkt([0.5, 0.5], 30 * 864e5), f).reason, 'too-far-out');
});

test('an outcome with nothing left to win is not bought', () => {
  // price 0.98 → cost > maxCost; the other side has no edge, so nothing to do.
  const d = estimate(mkt([0.98, 0.02]), { probs: [0.99, 0.01], source: 't' });
  assert.equal(d.action, 'skip');
});
