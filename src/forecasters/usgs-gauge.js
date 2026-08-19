/**
 * USGS stream-gauge forecaster.
 *
 * Prices markets of the form "will <site> discharge at <time> be below/above
 * <threshold>" by reading the SAME instantaneous-values feed the market's own
 * oracle uses to settle. Every competition market publishes its settlement
 * source in `dataSources` and restates it in the oracle `prompt_context`, so
 * there is no ambiguity about what is being predicted — only about what the
 * value will be.
 *
 * Method: gauge readings are a physical measurement with strong short-horizon
 * autocorrelation. Project the recent recession slope forward to the target
 * time, then put a normal error band on the projection whose width is measured
 * from how much this gauge has actually moved over the same horizon.
 *
 * Everything here fails CLOSED. Unparseable criteria, a stale feed, or a
 * horizon we have no error statistics for all return null, which the estimator
 * reads as "no forecaster" and skips. A forecaster that guesses is worse than
 * no forecaster, because the pacer will happily size a confident wrong number.
 */

'use strict';

import { clamp01 } from './stats.js';

const IV_BASE = 'https://waterservices.usgs.gov/nwis/iv/';
const MAX_STALE_MS = 6 * 3600e3;   // a gauge silent this long is not telling us anything
const MIN_SIGMA_FRAC = 0.02;       // never claim more precision than 2% of current flow

/** Normal CDF (Abramowitz & Stegun 7.1.26 via erf). */
function phi(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014337 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z > 0 ? 1 - p : p;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const stdev = (xs) => {
  if (xs.length < 2) return NaN;
  const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length - 1));
};

/**
 * Does this market settle off a USGS gauge, and if so on what terms?
 * Returns null unless every field can be read with confidence.
 */
export function match(market) {
  const sources = Array.isArray(market.dataSources) ? market.dataSources : [];
  const iv = sources.find((s) => typeof s === 'string' && s.includes('waterservices.usgs.gov/nwis/iv'));
  if (!iv) return null;

  let url;
  try { url = new URL(iv); } catch { return null; }
  const site = url.searchParams.get('sites');
  const param = url.searchParams.get('parameterCd');
  const startDT = url.searchParams.get('startDT');
  if (!site || !param || !startDT) return null;

  const targetMs = Date.parse(startDT);
  if (!Number.isFinite(targetMs)) return null;

  // Threshold and direction come from the oracle's own restatement of the
  // criteria, which is stricter prose than the headline question.
  const ctx = market.metadata?.model?.prompt_context ?? '';
  const q = market.metadata?.question ?? '';
  const text = `${ctx}\n${q}`;

  const m = text.match(/\bis\s+(below|above|at or above|at or below)\s+([\d,]+(?:\.\d+)?)/i)
        ?? text.match(/\bbe\s+(below|above|at or above|at or below)\s+([\d,]+(?:\.\d+)?)/i);
  if (!m) return null;

  const threshold = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(threshold) || threshold <= 0) return null;
  const belowWins = /below/i.test(m[1]);

  // Which outcome index does "below" correspond to?
  const outcomes = market.metadata?.outcomes ?? [];
  if (outcomes.length !== 2) return null;
  const yesIdx = outcomes.findIndex((o) => /^yes$/i.test(String(o).trim()));
  if (yesIdx === -1) return null;

  return { site, param, targetMs, threshold, belowWins, yesIdx, source: `usgs:${site}` };
}

/**
 * Pull the trailing 30 days of instantaneous values.
 *
 * Retried: a single dropped connection must not be allowed to look like "no
 * forecaster covers this market", which is how a transient network failure
 * silently turns into a missed position.
 */
async function fetchSeries(site, param, attempts = 3) {
  const url = `${IV_BASE}?format=json&sites=${site}&parameterCd=${param}&period=P30D`;
  let lastErr;
  let body;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(45_000) });
      if (!res.ok) throw new Error(`USGS ${res.status}`);
      body = await res.json();
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  if (lastErr) throw lastErr;
  const ts = body?.value?.timeSeries?.[0];
  const raw = ts?.values?.[0]?.value ?? [];
  const series = raw
    .map((p) => ({ t: Date.parse(p.dateTime), v: Number(p.value) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.v > -1e6)
    .sort((a, b) => a.t - b.t);
  return series;
}

/**
 * @returns {Promise<{probs:number[], source:string, note:string}|null>}
 */
export async function forecast(market, now = Date.now()) {
  const spec = match(market);
  if (!spec) return null;

  let series;
  try { series = await fetchSeries(spec.site, spec.param); } catch { return null; }
  if (series.length < 96) return null; // < ~1 day of 15-min readings

  const last = series.at(-1);
  if (now - last.t > MAX_STALE_MS) return null; // feed has gone quiet — do not extrapolate

  const horizonMs = spec.targetMs - last.t;
  if (horizonMs <= 0) return null;            // target already passed; nothing to forecast
  if (horizonMs > 7 * 864e5) return null;      // beyond where a recession slope means anything
  const horizonDays = horizonMs / 864e5;

  // Daily values at a fixed hour, so the slope is not contaminated by any
  // within-day cycle.
  const daily = [];
  const seen = new Set();
  for (const p of series) {
    const d = new Date(p.t);
    const key = d.toISOString().slice(0, 10);
    if (d.getUTCHours() === 12 && !seen.has(key)) { seen.add(key); daily.push(p); }
  }
  if (daily.length < 8) return null;

  // Recent slope: median of the last 5 day-over-day changes. Median rather
  // than mean so one bad reading cannot set the trend.
  const diffs = [];
  for (let i = 1; i < daily.length; i++) diffs.push(daily[i].v - daily[i - 1].v);
  const recent = diffs.slice(-5);
  const slopePerDay = median(recent);
  if (!Number.isFinite(slopePerDay)) return null;

  const projected = last.v + slopePerDay * horizonDays;

  // Error band measured from this gauge's own behaviour: how far does it move
  // over one day, anywhere in the last 30 days?
  const moves = [];
  for (let i = 1; i < daily.length; i++) moves.push(daily[i].v - daily[i - 1].v);
  const sigma1d = stdev(moves);
  if (!Number.isFinite(sigma1d)) return null;

  // Scale to the actual horizon as sqrt(t), the random-walk convention.
  // Previously the horizon was ROUNDED UP to whole days, so a three-hour
  // forecast carried a full day of uncertainty — roughly 3x too wide in
  // standard-deviation terms, which understates a near-certain position.
  let sigma = sigma1d * Math.sqrt(Math.max(horizonDays, 1 / 24));
  sigma = Math.max(sigma, MIN_SIGMA_FRAC * last.v);

  const pBelow = phi((spec.threshold - projected) / sigma);
  // Clamp away from certainty. The hydrology may be near-deterministic hours
  // out, but settlement is not: the oracle can misread, USGS marks these values
  // provisional and revises them, and the feed itself can be wrong. That
  // residual is irreducible and must never be modelled away — a forecaster
  // that reports 0.999 will size as though settlement risk does not exist.
  const pYes = clamp01(spec.belowWins ? pBelow : 1 - pBelow);

  const probs = [];
  probs[spec.yesIdx] = pYes;
  probs[1 - spec.yesIdx] = 1 - pYes;

  return {
    probs,
    source: spec.source,
    note: `last=${last.v} @${new Date(last.t).toISOString()} slope=${slopePerDay.toFixed(0)}/d ` +
          `h=${horizonDays.toFixed(2)}d projected=${projected.toFixed(0)} sigma=${sigma.toFixed(0)} ` +
          `threshold=${spec.threshold} ${spec.belowWins ? 'below' : 'above'}-wins-yes`,
  };
}
