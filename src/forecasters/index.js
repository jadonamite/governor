/**
 * Forecaster registry.
 *
 * Each forecaster owns one settlement source and answers one question: given
 * this market, what are our probabilities per outcome? It returns null when it
 * cannot price the market — which is the normal case for most markets, and is
 * reported as such rather than papered over.
 *
 * Forecasters are the ONLY place I/O lives on the decision path. The estimator
 * stays a pure function of (market, forecast) so any decision in the log can be
 * replayed and argued with after the fact.
 */

'use strict';

import * as usgsGauge from './usgs-gauge.js';
import * as wikipediaPageviews from './wikipedia-pageviews.js';
import * as carbonIntensity from './carbon-intensity.js';
import * as noaaBuoy from './noaa-buoy.js';
import * as federalRegister from './federal-register.js';
import * as noaaTide from './noaa-tide.js';

// crypto-close is DELIBERATELY NOT REGISTERED.
//
// It lost 98 TST on a BTC band market and the loss was structural, not bad
// luck. A driftless random walk anchored at spot is a calculation every
// participant can run, so it produces no information the market lacks — and
// when spot sits on a band boundary (64,023 against a $64,000 line) tiny sigma
// errors swing band probabilities enormously. We read a coin flip as a
// 20.7-point edge and sized it accordingly.
//
// The rule this cost us: only price markets where reading a physical or
// administrative feed yields information the market has not already priced.
// The file is kept for reference; do not re-register it without a real
// informational edge over consensus.
const REGISTRY = [usgsGauge, wikipediaPageviews, carbonIntensity, noaaBuoy, federalRegister, noaaTide];

/**
 * @returns {Promise<{probs:number[], source:string, note?:string}|null>}
 */
export async function forecastFor(market, now = Date.now()) {
  let matched = false;
  let failure = null;

  for (const f of REGISTRY) {
    if (!f.match(market)) continue;
    matched = true;
    try {
      const out = await f.forecast(market, now);
      if (out) return out;
      failure ??= 'forecaster-returned-null';
    } catch (e) {
      failure ??= `forecaster-threw: ${String(e.message ?? e).slice(0, 80)}`;
    }
  }

  // A forecaster that matched but could not answer is NOT the same as a market
  // nothing covers. Collapsing the two hides a broken feed as "no coverage" —
  // which on a flaky connection silently stops the agent trading its best
  // position. Surface it so the skip reason names the real cause.
  if (matched) return { failed: true, reason: failure ?? 'forecaster-unavailable' };
  return null;
}

/** Which markets we can price at all — used by staging and reporting. */
export function coverage(markets) {
  return markets.map((m) => ({
    id: m.id,
    covered: REGISTRY.some((f) => Boolean(f.match(m))),
  }));
}
