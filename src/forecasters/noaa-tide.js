/**
 * NOAA CO-OPS tide-gauge forecaster (water level vs threshold).
 *
 * Markets ask whether the MAX observed water level inside a stated UTC window
 * exceeds a threshold, at a named station, on a named datum.
 *
 * THE DECOMPOSITION — this is the whole edge.
 *
 * Observed water level = astronomical tide + surge (weather + seasonal MSL).
 * NOAA publishes the astronomical `predictions` series YEARS ahead, so the
 * deterministic half of the answer is knowable exactly. What remains is the
 * distribution of the gap:
 *
 *     gap = max(observed in window) − max(predicted in window)
 *
 * measured empirically from this station's own recent record. That gap is NOT
 * mean-zero: NOAA predictions are referenced to the 1983-2001 tidal epoch, and
 * both sea-level rise and the seasonal mean-sea-level cycle (which peaks at The
 * Battery in early autumn) push observations systematically above prediction.
 * Measured at 8518750 in Aug 2026: mean +0.39 ft, and trending up ~0.11 ft
 * across 60 days.
 *
 * A SUBTLETY THAT NEARLY COST US. Do not compute the distribution of the
 * pointwise residual (observed − predicted at matching timestamps) and take its
 * max. max(a + b) <= max(a) + max(b), because the surge peak and the tide peak
 * generally fall at different times. That error inflated P(Yes) from 0.49 to
 * 0.78 on the first attempt — a fabricated 35-point edge. Always compare
 * max-to-max, which is exactly what the market settles on.
 *
 * Fails closed: no predictions for the target window, thin history, or an
 * unparseable spec all return null.
 */

'use strict';

import { clamp01, fetchRetry } from './stats.js';

const COOPS = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter';
const HISTORY_DAYS = 60;
const MIN_DAYS = 25;
const CHUNK = 30;              // water_level requests are capped at ~31 days
const MIN_WINDOW_POINTS = 30;  // a window is ~60 six-minute records

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

export function match(market) {
  const sources = Array.isArray(market.dataSources) ? market.dataSources : [];
  const src = sources.find((s) => typeof s === 'string' && s.includes('tidesandcurrents.noaa.gov/api/prod/datagetter'));
  if (!src) return null;

  let url;
  try { url = new URL(src); } catch { return null; }
  const p = url.searchParams;
  const station = p.get('station');
  const datum = p.get('datum');
  const units = p.get('units');
  const begin = p.get('begin_date');
  if (!station || !datum || !begin) return null;
  // The market must settle on OBSERVED level, never the astronomical forecast.
  if (p.get('product') !== 'water_level') return null;

  const text = `${market.metadata?.model?.prompt_context ?? ''}\n${market.metadata?.question ?? ''}`;

  const t = text.match(/\b(exceed|greater than|above|below|lower than)\s+([\d.]+)\s*ft\b/i);
  if (!t) return null;
  const threshold = Number(t[2]);
  if (!Number.isFinite(threshold)) return null;
  const aboveWins = /exceed|greater than|above/i.test(t[1]);

  // Greedy over the whole "18, 19, 20, 21, 22 or 23" run. A non-greedy match
  // stops at the first comma and yields a one-hour window, which silently
  // changes the question being answered.
  const hw = text.match(/hour\s+(?:field\s+)?(?:is\s+)?((?:\d{1,2}\s*(?:,|or|and)?\s*)+)/i);
  let hours;
  if (hw) hours = [...new Set(hw[1].split(/[^\d]+/).filter(Boolean).map(Number))].filter((h) => h >= 0 && h <= 23);
  if (!hours || !hours.length) {
    const w = text.match(/(\d{2}):(\d{2})\s*(?:through|to|-|–)\s*(\d{2}):(\d{2})\s*UTC/);
    if (!w) return null;
    hours = [];
    for (let h = Number(w[1]); h <= Number(w[3]); h++) hours.push(h);
  }
  if (!hours.length) return null;

  const targetDate = `${begin.slice(0, 4)}-${begin.slice(4, 6)}-${begin.slice(6, 8)}`;
  const targetMs = Date.parse(`${targetDate}T00:00:00Z`);
  if (!Number.isFinite(targetMs)) return null;

  const outcomes = market.metadata?.outcomes ?? [];
  if (outcomes.length !== 2) return null;
  const yesIdx = outcomes.findIndex((o) => /^yes$/i.test(String(o).trim()));
  if (yesIdx === -1) return null;

  return {
    station, datum, units: units ?? 'english', threshold, aboveWins, hours,
    targetDate, targetMs, yesIdx, source: `noaa-tide:${station}`,
  };
}

const get = (product, spec, b, e) => fetchRetry(
  `${COOPS}?product=${product}&application=governor&begin_date=${b}&end_date=${e}` +
  `&datum=${spec.datum}&station=${spec.station}&time_zone=gmt&units=${spec.units}&format=json`
);

/** max value inside the market's hour-window, per UTC day */
function windowMax(rows, hours, key = 'v') {
  const out = {};
  for (const r of rows) {
    const t = r.t;
    if (!t) continue;
    const h = Number(t.slice(11, 13));
    if (!hours.includes(h)) continue;
    const v = parseFloat(r[key]);
    if (!Number.isFinite(v)) continue;            // blank readings skipped, never zeroed
    const d = t.slice(0, 10);
    out[d] = out[d] === undefined ? { m: v, n: 1 } : { m: Math.max(out[d].m, v), n: out[d].n + 1 };
  }
  return out;
}

export async function forecast(market, now = Date.now()) {
  const spec = match(market);
  if (!spec) return null;

  const windowEndMs = spec.targetMs + (Math.max(...spec.hours) + 1) * 3600e3;
  if (now > windowEndMs) return null;                 // window already closed
  if (spec.targetMs - now > 10 * 864e5) return null;   // too far for a stable seasonal read

  // 1. Astronomical prediction for the target day — deterministic, published years out.
  let predTarget;
  try { predTarget = await get('predictions', spec, ymd(spec.targetMs), ymd(spec.targetMs)); } catch { return null; }
  const targetPred = windowMax(predTarget?.predictions ?? [], spec.hours);
  const maxPred = targetPred[spec.targetDate]?.m;
  if (maxPred === undefined) return null;

  // 2. Historical gap distribution: max(observed) − max(predicted), max-to-max.
  const histStart = now - HISTORY_DAYS * 864e5;
  let obs = [];
  for (let s = histStart; s < now; s += CHUNK * 864e5) {
    const e = Math.min(s + (CHUNK - 1) * 864e5, now - 864e5);
    if (e <= s) break;
    try {
      const r = await get('water_level', spec, ymd(s), ymd(e));
      obs = obs.concat(r?.data ?? []);
    } catch { /* a missing chunk thins the sample; MIN_DAYS still gates it */ }
  }
  if (!obs.length) return null;

  let preds;
  try { preds = await get('predictions', spec, ymd(histStart), ymd(now - 864e5)); } catch { return null; }

  const O = windowMax(obs, spec.hours);
  const P = windowMax(preds?.predictions ?? [], spec.hours);

  const gaps = [];
  for (const d of Object.keys(O)) {
    if (P[d] === undefined) continue;
    if (O[d].n < MIN_WINDOW_POINTS) continue;      // partial day — its max is not comparable
    gaps.push({ d, g: O[d].m - P[d].m });
  }
  if (gaps.length < MIN_DAYS) return null;

  gaps.sort((a, b) => (a.d < b.d ? -1 : 1));

  // 3. Recency-weighted empirical CDF. The seasonal mean-sea-level cycle makes
  //    the gap drift within a single season, so older days count for less.
  //    Empirical rather than Gaussian: the gap distribution is skewed, and the
  //    tail is precisely what these thresholds sit in.
  const needed = spec.threshold - maxPred;
  const HALFLIFE = 21;
  const n = gaps.length;
  let wSum = 0;
  let wHit = 0;
  for (let i = 0; i < n; i++) {
    const age = n - 1 - i;
    const w = Math.pow(0.5, age / HALFLIFE);
    wSum += w;
    if (gaps[i].g > needed) wHit += w;
  }
  const pExceed = wHit / wSum;
  const pYes = clamp01(spec.aboveWins ? pExceed : 1 - pExceed);

  const probs = [];
  probs[spec.yesIdx] = pYes;
  probs[1 - spec.yesIdx] = 1 - pYes;

  const raw = gaps.filter((x) => x.g > needed).length / n;
  const mean = gaps.reduce((a, b) => a + b.g, 0) / n;

  return {
    probs,
    source: spec.source,
    note: `maxPred=${maxPred.toFixed(3)}ft threshold=${spec.threshold} needed=${needed.toFixed(3)}ft ` +
          `nDays=${n} meanGap=${mean.toFixed(3)} rawP=${raw.toFixed(3)} weightedP=${pExceed.toFixed(3)}`,
  };
}
