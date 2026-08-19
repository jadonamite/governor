/**
 * Wikimedia pageviews forecaster.
 *
 * Prices "will article X get more than N views on day D" markets off the same
 * Pageviews API the market's oracle reads. The criteria are unusually strict —
 * project, access and agent are all binding, and the `user` series runs
 * materially below `all-agents` — so every parameter is taken from the market's
 * own declared URL rather than assumed.
 *
 * Method: daily pageviews have a strong weekday cycle and a slow-moving level.
 * Estimate a multiplicative weekday factor over a long window, deseasonalise,
 * take the recent level, then re-apply the target day's factor. Uncertainty
 * comes from the spread of recent deseasonalised residuals, widened with
 * horizon since a 5-day-ahead call is not a 1-day-ahead call.
 *
 * Fails closed: unparseable criteria, a short history, or a stale feed all
 * return null rather than a guess.
 */

'use strict';

import { mean, stdev, pAbove, fetchRetry } from './stats.js';

const API = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article';
const UA = 'governor-agent/0.1 (delphi competition; contact via github.com/jadonamite/governor)';
const HISTORY_DAYS = 120;
const MIN_HISTORY = 45;

const ymd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;

/**
 * Read every binding parameter out of the market's own dataSources URL.
 * Shape: .../per-article/{project}/{access}/{agent}/{article}/daily/{start}/{end}
 */
export function match(market) {
  const sources = Array.isArray(market.dataSources) ? market.dataSources : [];
  const src = sources.find((s) => typeof s === 'string' && s.includes('/metrics/pageviews/per-article/'));
  if (!src) return null;

  const tail = src.split('/per-article/')[1];
  if (!tail) return null;
  const parts = tail.split('/');
  if (parts.length < 7) return null;
  const [project, access, agent, article, granularity, start] = parts;
  if (granularity !== 'daily') return null;
  if (!/^\d{8}$/.test(start)) return null;

  const targetDate = `${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}`;
  const targetMs = Date.parse(`${targetDate}T00:00:00Z`);
  if (!Number.isFinite(targetMs)) return null;

  const ctx = market.metadata?.model?.prompt_context ?? '';
  const q = market.metadata?.question ?? '';
  const m = `${ctx}\n${q}`.match(/\b(greater than|more than|at least|fewer than|less than)\s+([\d,]+)/i);
  if (!m) return null;
  const threshold = Number(m[2].replace(/,/g, ''));
  if (!Number.isFinite(threshold) || threshold <= 0) return null;
  const aboveWins = /greater than|more than|at least/i.test(m[1]);

  const outcomes = market.metadata?.outcomes ?? [];
  if (outcomes.length !== 2) return null;
  const yesIdx = outcomes.findIndex((o) => /^yes$/i.test(String(o).trim()));
  if (yesIdx === -1) return null;

  return {
    project, access, agent, article, targetMs, threshold, aboveWins, yesIdx,
    source: `wikipedia:${decodeURIComponent(article)}`,
  };
}

export async function forecast(market, now = Date.now()) {
  const spec = match(market);
  if (!spec) return null;

  const end = new Date(now);
  const start = new Date(now - HISTORY_DAYS * 864e5);
  const url = `${API}/${spec.project}/${spec.access}/${spec.agent}/${spec.article}/daily/${ymd(start)}/${ymd(end)}`;

  let body;
  try { body = await fetchRetry(url, { headers: { 'User-Agent': UA } }); } catch { return null; }

  const items = (body?.items ?? [])
    .map((i) => ({ ms: Date.parse(`${i.timestamp.slice(0, 4)}-${i.timestamp.slice(4, 6)}-${i.timestamp.slice(6, 8)}T00:00:00Z`), v: Number(i.views) }))
    .filter((i) => Number.isFinite(i.ms) && Number.isFinite(i.v) && i.v > 0)
    .sort((a, b) => a.ms - b.ms);

  if (items.length < MIN_HISTORY) return null;

  const last = items.at(-1);
  const horizonDays = (spec.targetMs - last.ms) / 864e5;
  if (horizonDays < 0) return null;          // target day already published
  if (horizonDays > 14) return null;          // beyond where a level estimate means anything

  // Multiplicative weekday factors over the whole history.
  const overall = mean(items.map((i) => i.v));
  if (!(overall > 0)) return null;
  const byDow = Array.from({ length: 7 }, () => []);
  for (const i of items) byDow[new Date(i.ms).getUTCDay()].push(i.v);
  const factor = byDow.map((xs) => (xs.length >= 4 ? mean(xs) / overall : 1));

  // Deseasonalise, then take the recent level. Recent, because the series
  // drifts — the long-run base rate here is materially higher than the last
  // fortnight and using it would systematically overstate.
  const des = items.map((i) => ({ ms: i.ms, v: i.v / (factor[new Date(i.ms).getUTCDay()] || 1) }));
  const recent = des.slice(-14).map((d) => d.v);
  const level = mean(recent);
  if (!(level > 0)) return null;

  const targetDow = new Date(spec.targetMs).getUTCDay();
  const projected = level * (factor[targetDow] || 1);

  // Spread of recent deseasonalised values, widened with horizon: a 5-day-out
  // call carries more level drift than a 1-day-out call.
  let sigma = stdev(recent);
  if (!Number.isFinite(sigma) || sigma <= 0) return null;
  sigma *= Math.sqrt(1 + Math.max(0, horizonDays) / 7);

  const pOver = pAbove(spec.threshold, projected, sigma);
  const pYes = spec.aboveWins ? pOver : 1 - pOver;

  const probs = [];
  probs[spec.yesIdx] = pYes;
  probs[1 - spec.yesIdx] = 1 - pYes;

  return {
    probs,
    source: spec.source,
    note: `n=${items.length} last=${last.v}@${new Date(last.ms).toISOString().slice(0, 10)} ` +
          `level=${level.toFixed(0)} dowFactor=${(factor[targetDow] || 1).toFixed(3)} ` +
          `projected=${projected.toFixed(0)} sigma=${sigma.toFixed(0)} h=${horizonDays.toFixed(1)}d ` +
          `threshold=${spec.threshold} ${spec.aboveWins ? 'above' : 'below'}-wins-yes`,
  };
}
