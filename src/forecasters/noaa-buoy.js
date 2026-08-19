/**
 * NOAA NDBC buoy forecaster — significant wave height (WVHT).
 *
 * Markets ask whether the MAX WVHT inside a stated UTC hour-window on a stated
 * day clears a threshold. The criteria pin the station, the field position, the
 * hours, and that 'MM' means "no reading" and must be skipped rather than
 * treated as zero — all of which are honoured here exactly.
 *
 * Method. At a ~30h lead we cannot run a wave model, but wave height is
 * strongly autocorrelated, so the useful question is: given the sea state now,
 * what has the window-max historically been about a day and a half later?
 * That persistence coefficient is REGRESSED from this buoy's own record rather
 * than assumed — a guessed decay constant is exactly the kind of invented edge
 * that sinks a forecaster.
 *
 * Data: https://www.ndbc.noaa.gov/data/realtime2/<station>.txt — fixed-width
 * text, ~45 days, newest row first, two '#' header lines. Fields 1-5 are
 * YY MM DD hh mm (UTC); WVHT is field 9 (index 8).
 */

'use strict';

import { mean, stdev, phi, clamp01 } from './stats.js';

const NDBC = 'https://www.ndbc.noaa.gov/data/realtime2';
const MIN_DAYS = 20;
const MIN_ROWS = 500;

export function match(market) {
  const sources = Array.isArray(market.dataSources) ? market.dataSources : [];
  const src = sources.find((s) => typeof s === 'string' && /ndbc\.noaa\.gov\/data\/realtime2\/\w+\.txt/.test(s));
  if (!src) return null;
  const station = src.match(/realtime2\/(\w+)\.txt/)?.[1];
  if (!station) return null;

  const ctx = market.metadata?.model?.prompt_context ?? '';
  const q = market.metadata?.question ?? '';
  const text = `${ctx}\n${q}`;

  // Threshold + direction.
  const t = text.match(/\b(above|greater than|below|less than)\s+([\d.]+)\s*m\b/i);
  if (!t) return null;
  const threshold = Number(t[2]);
  if (!Number.isFinite(threshold)) return null;
  const aboveWins = /above|greater than/i.test(t[1]);

  // Target day and hour window, e.g. "18:00 through 23:50 UTC on 2026-08-18".
  const d = text.match(/(\d{4})-(\d{2})-(\d{2})/);
  const hrs = text.match(/hour field is ([\d,\s and]+)/i);
  if (!d) return null;
  const [, yyyy, mm, dd] = d.map(Number);
  let hours;
  if (hrs) {
    hours = hrs[1].split(/[^\d]+/).filter(Boolean).map(Number);
  } else {
    const w = text.match(/(\d{2}):(\d{2})\s*(?:through|to|-|–)\s*(\d{2}):(\d{2})\s*UTC/);
    if (!w) return null;
    hours = [];
    for (let h = Number(w[1]); h <= Number(w[3]); h++) hours.push(h);
  }
  if (!hours.length) return null;

  const windowStartMs = Date.UTC(yyyy, mm - 1, dd, Math.min(...hours), 0, 0);

  const outcomes = market.metadata?.outcomes ?? [];
  if (outcomes.length !== 2) return null;
  const yesIdx = outcomes.findIndex((o) => /^yes$/i.test(String(o).trim()));
  if (yesIdx === -1) return null;

  return { station, threshold, aboveWins, hours, windowStartMs, yesIdx, source: `ndbc:${station}` };
}

/** Parse the fixed-width realtime2 record into {ms, wvht} rows. */
function parse(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.trim().split(/\s+/);
    if (f.length < 9) continue;
    const [Y, M, D, h, m] = f.slice(0, 5).map(Number);
    const raw = f[8];
    if (raw === 'MM') continue;                 // sensor reported nothing — skip, never zero
    const wvht = Number(raw);
    if (!Number.isFinite(Y) || !Number.isFinite(wvht) || wvht <= 0) continue;
    const ms = Date.UTC(Y, M - 1, D, h, m, 0);
    if (!Number.isFinite(ms)) continue;
    out.push({ ms, wvht });
  }
  return out.sort((a, b) => a.ms - b.ms);
}

export async function forecast(market, now = Date.now()) {
  const spec = match(market);
  if (!spec) return null;

  const leadH = (spec.windowStartMs - now) / 3600e3;
  if (leadH < -6) return null;              // window already passed
  if (leadH > 96) return null;              // past any useful persistence

  let rows;
  try {
    const res = await fetch(`${NDBC}/${spec.station}.txt`, { signal: AbortSignal.timeout(45_000) });
    if (!res.ok) throw new Error(`NDBC ${res.status}`);
    rows = parse(await res.text());
  } catch { return null; }
  if (rows.length < MIN_ROWS) return null;

  const last = rows.at(-1);
  if (now - last.ms > 6 * 3600e3) return null;   // buoy has gone quiet

  /** Max WVHT inside the market's hour-window on a given UTC day offset. */
  const windowMax = (dayMs) => {
    const vals = rows.filter((r) => {
      const d = new Date(r.ms);
      const sameDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) === dayMs;
      return sameDay && spec.hours.includes(d.getUTCHours());
    }).map((r) => r.wvht);
    return vals.length ? Math.max(...vals) : null;
  };

  /** Mean WVHT over the 12h ending `leadH` before that window. */
  const priorLevel = (windowStart) => {
    const end = windowStart - leadH * 3600e3;
    const vals = rows.filter((r) => r.ms > end - 12 * 3600e3 && r.ms <= end).map((r) => r.wvht);
    return vals.length >= 4 ? mean(vals) : null;
  };

  // Build (level-then, window-max-later) pairs from this buoy's own record.
  const pairs = [];
  const firstDay = Math.ceil(rows[0].ms / 864e5) * 864e5;
  for (let day = firstDay; day < spec.windowStartMs; day += 864e5) {
    const ws = day + Math.min(...spec.hours) * 3600e3;
    const M = windowMax(day);
    const X = priorLevel(ws);
    if (M !== null && X !== null) pairs.push({ X, M });
  }
  if (pairs.length < MIN_DAYS) return null;

  // Regress M on X. beta is the MEASURED persistence at this lead time.
  const mx = mean(pairs.map((p) => p.X));
  const my = mean(pairs.map((p) => p.M));
  const sxx = pairs.reduce((a, p) => a + (p.X - mx) ** 2, 0);
  if (!(sxx > 0)) return null;
  const sxy = pairs.reduce((a, p) => a + (p.X - mx) * (p.M - my), 0);
  const beta = sxy / sxx;
  const alpha = my - beta * mx;

  const nowLevel = mean(rows.filter((r) => r.ms > last.ms - 12 * 3600e3).map((r) => r.wvht));
  if (!Number.isFinite(nowLevel)) return null;

  const projected = alpha + beta * nowLevel;
  const resid = pairs.map((p) => p.M - (alpha + beta * p.X));
  let sigma = stdev(resid);
  if (!Number.isFinite(sigma) || sigma <= 0) return null;
  sigma *= Math.sqrt(1 + 1 / pairs.length);

  const pAboveThr = 1 - phi((spec.threshold - projected) / sigma);
  const pYes = clamp01(spec.aboveWins ? pAboveThr : 1 - pAboveThr);

  const probs = [];
  probs[spec.yesIdx] = pYes;
  probs[1 - spec.yesIdx] = 1 - pYes;

  return {
    probs,
    source: spec.source,
    note: `n=${pairs.length}d level=${nowLevel.toFixed(2)}m beta=${beta.toFixed(2)} ` +
          `projected=${projected.toFixed(2)}m sigma=${sigma.toFixed(2)} lead=${leadH.toFixed(1)}h ` +
          `threshold=${spec.threshold}m ${spec.aboveWins ? 'above' : 'below'}-wins-yes`,
  };
}
