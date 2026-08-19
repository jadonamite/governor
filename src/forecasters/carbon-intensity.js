/**
 * Great Britain carbon-intensity forecaster (carbonintensity.org.uk).
 *
 * Markets ask whether `intensity.actual` for one half-hour settlement period
 * clears a threshold. The criteria are explicit that `intensity.forecast` — a
 * different field in the same object — must NOT be substituted at settlement,
 * and that the two routinely differ by ten to fifteen units.
 *
 * That is precisely what makes the published forecast useful to us: it is a
 * legitimate PREDICTOR even though it is not the settlement value. So when a
 * forecast exists for the target period we use it, and calibrate the error
 * from recent periods where both fields are already known.
 *
 * When no forecast has been published yet (the API only looks ~48h ahead), we
 * fall back to the distribution of actuals for the same settlement period on
 * the same weekday. If neither is available, we abstain.
 */

'use strict';

import { mean, stdev, pAbove, clamp01, fetchRetry } from './stats.js';

const API = 'https://api.carbonintensity.org.uk';
const MIN_PAIRS = 40;
const MIN_SLOT_SAMPLES = 10;  // below this the base-rate path is not an estimate
const MIN_SIGMA = 8;          // gCO2/kWh — never claim more precision than the feed has

export function match(market) {
  const sources = Array.isArray(market.dataSources) ? market.dataSources : [];
  const src = sources.find((s) => typeof s === 'string' && s.includes('api.carbonintensity.org.uk/intensity/'));
  if (!src) return null;

  // .../intensity/{fromISO}/{toISO}
  const tail = src.split('/intensity/')[1];
  if (!tail) return null;
  const [fromRaw] = tail.split('/');
  const fromMs = Date.parse(fromRaw);
  if (!Number.isFinite(fromMs)) return null;

  const ctx = market.metadata?.model?.prompt_context ?? '';
  const q = market.metadata?.question ?? '';
  const m = `${ctx}\n${q}`.match(/\b(above|greater than|below|lower than|at or below)\s+([\d,]+(?:\.\d+)?)/i);
  if (!m) return null;
  const threshold = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(threshold)) return null;
  const aboveWins = /above|greater than/i.test(m[1]);

  const outcomes = market.metadata?.outcomes ?? [];
  if (outcomes.length !== 2) return null;
  const yesIdx = outcomes.findIndex((o) => /^yes$/i.test(String(o).trim()));
  if (yesIdx === -1) return null;

  return { fromRaw, fromMs, threshold, aboveWins, yesIdx, source: 'carbonintensity:gb' };
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 16) + 'Z';

// The published forecast is REVISED as the settlement period approaches, and
// the revisions are large: we entered a position 32h out on a published
// forecast of 132 and by settlement that same slot read 193 — a 61-unit move,
// 2.2x the residual sigma we were using. That is not a code bug, it is what a
// forecast IS, and no amount of horizon-widening on the residual distribution
// captures it because the residual is measured against the FINAL forecast, not
// against an early revision of it.
//
// So we simply do not trade these until the input has stabilised. The API
// publishes ~48h ahead; the last several hours are when the forecast stops
// moving materially.
const MAX_LEAD_H = 14;

export async function forecast(market, now = Date.now()) {
  const spec = match(market);
  if (!spec) return null;
  if (spec.fromMs < now) return null;                    // period already past
  if (spec.fromMs - now > MAX_LEAD_H * 3600e3) return null; // forecast still revising

  // Recent history: both fields known, so residuals are measurable.
  let hist;
  try {
    hist = await fetchRetry(`${API}/intensity/${iso(now - 21 * 864e5)}/${iso(now)}`);
  } catch { return null; }

  const rows = (hist?.data ?? [])
    .map((d) => ({
      ms: Date.parse(d.from),
      f: Number(d.intensity?.forecast),
      a: Number(d.intensity?.actual),
    }))
    .filter((d) => Number.isFinite(d.ms) && Number.isFinite(d.a));

  if (rows.length < MIN_PAIRS) return null;

  // Try the published forecast for the target half-hour.
  let targetForecast = null;
  try {
    const fut = await fetchRetry(`${API}/intensity/${spec.fromRaw}/${iso(spec.fromMs + 30 * 60e3)}`);
    const hit = (fut?.data ?? []).find((d) => Date.parse(d.from) === spec.fromMs);
    const f = Number(hit?.intensity?.forecast);
    if (Number.isFinite(f)) targetForecast = f;
  } catch { /* fall through to the base-rate path */ }

  let projected;
  let sigma;
  let basis;

  if (targetForecast !== null) {
    // Calibrate: how far has actual sat from forecast lately, and is it biased?
    const pairs = rows.filter((d) => Number.isFinite(d.f));
    if (pairs.length < MIN_PAIRS) return null;
    const resid = pairs.map((d) => d.a - d.f);
    projected = targetForecast + mean(resid);   // de-bias
    sigma = stdev(resid);
    basis = `forecast=${targetForecast} bias=${mean(resid).toFixed(1)} n=${pairs.length}`;
  } else {
    // No published forecast yet. Fall back to the same settlement period across
    // recent days.
    //
    // NOT same-slot-AND-same-weekday: a 21-day window contains only three
    // matching half-hours, and a mean and sigma taken from three points is not
    // an estimate, it is a coincidence. It produced q=0.92 with sigma=24 and
    // asked for a fifth of the bankroll. Same-slot across all weekdays gives
    // ~21 observations at the cost of some day-of-week variance, which is the
    // right trade — and the small-sample widening below keeps it honest.
    const d = new Date(spec.fromMs);
    const slot = d.getUTCHours() * 2 + (d.getUTCMinutes() >= 30 ? 1 : 0);
    const same = rows
      .filter((r) => {
        const rd = new Date(r.ms);
        return rd.getUTCHours() * 2 + (rd.getUTCMinutes() >= 30 ? 1 : 0) === slot;
      })
      .map((r) => r.a);
    if (same.length < MIN_SLOT_SAMPLES) return null;
    projected = mean(same);
    // Widen for small samples: the sigma of n points understates the spread of
    // the next draw by roughly sqrt(1 + 1/n).
    sigma = stdev(same) * Math.sqrt(1 + 1 / same.length);
    basis = `no published forecast; same-slot n=${same.length}`;
  }

  if (!Number.isFinite(projected) || !Number.isFinite(sigma)) return null;

  // The residual sigma above is measured across whatever lead times the recent
  // history happens to contain — mostly short. A forecast 30+ hours out is
  // materially less accurate than that average, so widen with horizon. Without
  // lead-time-tagged residuals this cannot be measured exactly, so it is
  // deliberately conservative rather than tuned.
  const horizonH = Math.max(0, (spec.fromMs - now) / 3600e3);
  sigma *= Math.sqrt(1 + horizonH / 24);
  sigma = Math.max(sigma, MIN_SIGMA);

  const pOver = pAbove(spec.threshold, projected, sigma);
  // Never report certainty: settlement risk (oracle misread, revised data,
  // broken feed) is irreducible and is not in any of the numbers above.
  const pYes = clamp01(spec.aboveWins ? pOver : 1 - pOver);

  const probs = [];
  probs[spec.yesIdx] = pYes;
  probs[1 - spec.yesIdx] = 1 - pYes;

  return {
    probs,
    source: spec.source,
    note: `${basis} projected=${projected.toFixed(1)} sigma=${sigma.toFixed(1)} ` +
          `threshold=${spec.threshold} ${spec.aboveWins ? 'above' : 'below'}-wins-yes`,
  };
}
