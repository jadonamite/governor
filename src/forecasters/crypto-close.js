/**
 * CoinGecko daily-close forecaster.
 *
 * Covers both shapes these markets come in:
 *   - binary   "will X's close be $N or higher"
 *   - banded   "which band will X's close fall into"  (4 mutually exclusive outcomes)
 *
 * These recur EVERY DAY for BTC and ETH, which is what makes them worth
 * building: one forecaster prices a market per coin per day for the rest of the
 * window, rather than a single one-off.
 *
 * Method: the settlement value is the CoinGecko 00:00 UTC snapshot for the day
 * after the trading day — i.e. a spot price at a known future instant. Model
 * log-price as a driftless random walk from spot, with sigma measured from
 * recent hourly returns and scaled by sqrt(hours remaining). Driftless is
 * deliberate: any drift term we could estimate from 14 days of history is
 * noise, and betting on it would be inventing an edge rather than measuring one.
 *
 * Fails closed on unparseable bands, a stale price, or a horizon outside the
 * range where a spot-anchored walk means anything.
 */

'use strict';

import { phi, stdev, mean, clamp01, fetchRetry } from './stats.js';

const CG = 'https://api.coingecko.com/api/v3';
const MIN_POINTS = 100;
const MAX_HORIZON_H = 72;

const num = (s) => Number(String(s).replace(/[$,]/g, ''));

/** Parse an outcome label into a [lo, hi) price interval. */
function bandOf(label) {
  const s = String(label).trim();
  let m;
  if ((m = s.match(/^below\s*\$?([\d,.]+)/i))) return [-Infinity, num(m[1])];
  if ((m = s.match(/^\$?([\d,.]+)\s*(?:to|through|–|—|-)\s*\$?([\d,.]+)/i))) return [num(m[1]), num(m[2])];
  if ((m = s.match(/^\$?([\d,.]+)\s*(?:or above|or higher|and above)/i))) return [num(m[1]), Infinity];
  if ((m = s.match(/^(?:above|over)\s*\$?([\d,.]+)/i))) return [num(m[1]), Infinity];
  return null;
}

export function match(market) {
  const sources = Array.isArray(market.dataSources) ? market.dataSources : [];
  const api = sources.find((s) => typeof s === 'string' && /api\.coingecko\.com\/api\/v3\/coins\/[^/]+\/history/.test(s));
  if (!api) return null;

  const coin = api.match(/\/coins\/([^/]+)\/history/)?.[1];
  const dateStr = new URL(api).searchParams.get('date');   // DD-MM-YYYY
  if (!coin || !dateStr) return null;
  const [dd, mm, yyyy] = dateStr.split('-').map(Number);
  if (!dd || !mm || !yyyy) return null;

  // The endpoint returns the 00:00 UTC snapshot for the date supplied, which is
  // the PREVIOUS UTC day's close. So the settlement instant is exactly that.
  const targetMs = Date.UTC(yyyy, mm - 1, dd, 0, 0, 0);
  if (!Number.isFinite(targetMs)) return null;

  const outcomes = market.metadata?.outcomes ?? [];
  if (outcomes.length < 2) return null;

  // Banded form: every outcome parses to an interval.
  const bands = outcomes.map(bandOf);
  if (bands.every(Boolean)) return { coin, targetMs, kind: 'bands', bands, source: `coingecko:${coin}` };

  // Binary form: threshold lives in the criteria prose.
  const yesIdx = outcomes.findIndex((o) => /^yes$/i.test(String(o).trim()));
  if (outcomes.length === 2 && yesIdx !== -1) {
    const text = `${market.metadata?.model?.prompt_context ?? ''}\n${market.metadata?.question ?? ''}`;
    const m = text.match(/\$?([\d,.]+)\s*(or higher|or above|or more|or greater|or lower|or below)/i);
    if (!m) return null;
    const threshold = num(m[1]);
    if (!Number.isFinite(threshold)) return null;
    const aboveWins = /higher|above|more|greater/i.test(m[2]);
    return { coin, targetMs, kind: 'binary', threshold, aboveWins, yesIdx, source: `coingecko:${coin}` };
  }
  return null;
}

export async function forecast(market, now = Date.now()) {
  const spec = match(market);
  if (!spec) return null;

  const horizonH = (spec.targetMs - now) / 3600e3;
  if (horizonH <= 0) return null;                 // close already happened
  if (horizonH > MAX_HORIZON_H) return null;      // spot anchoring stops meaning much

  let chart;
  try {
    chart = await fetchRetry(`${CG}/coins/${spec.coin}/market_chart?vs_currency=usd&days=14`);
  } catch { return null; }

  const prices = (chart?.prices ?? []).filter((p) => Array.isArray(p) && Number.isFinite(p[1]) && p[1] > 0);
  if (prices.length < MIN_POINTS) return null;

  const spot = prices.at(-1)[1];
  const lastMs = prices.at(-1)[0];
  if (now - lastMs > 3 * 3600e3) return null;     // stale feed

  // Hourly log-return sigma, normalised by the actual sampling step.
  const rets = [];
  for (let i = 1; i < prices.length; i++) {
    const dtH = (prices[i][0] - prices[i - 1][0]) / 3600e3;
    if (dtH <= 0) continue;
    rets.push(Math.log(prices[i][1] / prices[i - 1][1]) / Math.sqrt(dtH));
  }
  if (rets.length < MIN_POINTS - 1) return null;
  const sigmaH = stdev(rets);
  if (!Number.isFinite(sigmaH) || sigmaH <= 0) return null;

  const sigma = sigmaH * Math.sqrt(horizonH);     // sd of log-price at the target
  const pBelow = (x) => (x === Infinity ? 1 : x === -Infinity ? 0 : phi(Math.log(x / spot) / sigma));

  let probs;
  if (spec.kind === 'bands') {
    probs = spec.bands.map(([lo, hi]) => Math.max(0, pBelow(hi) - pBelow(lo)));
    const total = probs.reduce((a, b) => a + b, 0);
    if (!(total > 0)) return null;
    probs = probs.map((p) => p / total);                 // bands are exhaustive by construction
    probs = probs.map((p) => clamp01(p, 0.01));
    const t2 = probs.reduce((a, b) => a + b, 0);
    probs = probs.map((p) => p / t2);
  } else {
    const pAbove = 1 - pBelow(spec.threshold);
    const pYes = clamp01(spec.aboveWins ? pAbove : 1 - pAbove);
    probs = [];
    probs[spec.yesIdx] = pYes;
    probs[1 - spec.yesIdx] = 1 - pYes;
  }

  return {
    probs,
    source: spec.source,
    note: `spot=${spot.toFixed(2)} sigmaH=${(sigmaH * 100).toFixed(3)}%/h h=${horizonH.toFixed(1)}h ` +
          `sigma=${(sigma * 100).toFixed(2)}% n=${rets.length}`,
  };
}
