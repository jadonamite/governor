/**
 * Federal Register document-count forecaster.
 *
 * Markets ask whether N+ documents of a given type publish inside a date
 * window. These are unusually tractable late in the window, because the count
 * so far is DIRECTLY OBSERVABLE from the same API the oracle settles against —
 * the only unknown is how many more arrive in the days remaining.
 *
 * Method:
 *   needed    = threshold − count already published
 *   remaining = publishing days left in the window (the Federal Register does
 *               not publish on weekends, so those are excluded, not counted)
 *   P(Yes)    = P(sum of `remaining` daily counts >= needed)
 *
 * That last probability is taken from the EMPIRICAL distribution of daily
 * counts over ~6 months, convolved over the remaining days — not a Poisson fit.
 * Presidential documents arrive in batches (the observed histogram has a long
 * tail out to 9 in a day against a mean near 1), and a Poisson assumption
 * would badly understate exactly the tail these markets are asking about.
 *
 * Fails closed on unparseable criteria or a short history.
 */

'use strict';

import { clamp01, fetchRetry } from './stats.js';

const FR = 'https://www.federalregister.gov/api/v1/documents.json';
const HISTORY_DAYS = 200;
const MIN_HISTORY_DAYS = 90;

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

export function match(market) {
  const sources = Array.isArray(market.dataSources) ? market.dataSources : [];
  const src = sources.find((s) => typeof s === 'string' && s.includes('federalregister.gov/api/v1/documents.json'));
  if (!src) return null;

  let url;
  try { url = new URL(src); } catch { return null; }
  const p = url.searchParams;
  const docType = p.get('conditions[type][]');
  const gte = p.get('conditions[publication_date][gte]');
  const lte = p.get('conditions[publication_date][lte]');
  if (!docType || !gte || !lte) return null;

  const text = `${market.metadata?.model?.prompt_context ?? ''}\n${market.metadata?.question ?? ''}`;
  const m = text.match(/is\s+(\d+)\s+or\s+(greater|more)/i) ?? text.match(/publish\s+(\d+)\+/i);
  if (!m) return null;
  const threshold = Number(m[1]);
  if (!Number.isFinite(threshold) || threshold <= 0) return null;

  const outcomes = market.metadata?.outcomes ?? [];
  if (outcomes.length !== 2) return null;
  const yesIdx = outcomes.findIndex((o) => /^yes$/i.test(String(o).trim()));
  if (yesIdx === -1) return null;

  return { docType, gte, lte, threshold, yesIdx, source: `federalregister:${docType}` };
}

async function countBetween(docType, gte, lte, extra = {}) {
  const q = new URLSearchParams({
    'conditions[type][]': docType,
    'conditions[publication_date][gte]': gte,
    'conditions[publication_date][lte]': lte,
    per_page: '1000',
    'fields[]': 'publication_date',
    ...extra,
  });
  return fetchRetry(`${FR}?${q}`);
}

export async function forecast(market, now = Date.now()) {
  const spec = match(market);
  if (!spec) return null;

  // 1. How many are already in, and how many days can still deliver?
  let sofar;
  try { sofar = await countBetween(spec.docType, spec.gte, spec.lte); } catch { return null; }
  const have = Number(sofar?.count);
  if (!Number.isFinite(have)) return null;

  const needed = spec.threshold - have;

  const endMs = Date.parse(`${spec.lte}T23:59:59Z`);
  let remainingDays = 0;
  for (let t = now; t <= endMs; t += 864e5) {
    const dow = new Date(t).getUTCDay();
    if (dow >= 1 && dow <= 5) remainingDays++;      // no weekend publication
  }

  if (needed <= 0) {
    // Already decided in favour of Yes — the count cannot go down.
    const probs = [];
    probs[spec.yesIdx] = clamp01(1);
    probs[1 - spec.yesIdx] = clamp01(0);
    return { probs, source: spec.source, note: `have=${have} threshold=${spec.threshold} ALREADY MET` };
  }
  if (remainingDays === 0) {
    const probs = [];
    probs[spec.yesIdx] = clamp01(0);
    probs[1 - spec.yesIdx] = clamp01(1);
    return { probs, source: spec.source, note: `have=${have} need=${needed} but no publishing days remain` };
  }

  // 2. Empirical daily-count distribution over ~6 months of weekdays.
  let hist;
  try {
    hist = await countBetween(spec.docType, iso(now - HISTORY_DAYS * 864e5), iso(now - 864e5));
  } catch { return null; }

  const byDate = {};
  for (const r of hist?.results ?? []) {
    if (r?.publication_date) byDate[r.publication_date] = (byDate[r.publication_date] ?? 0) + 1;
  }

  const daily = [];
  for (let t = now - HISTORY_DAYS * 864e5; t < now; t += 864e5) {
    const dow = new Date(t).getUTCDay();
    if (dow < 1 || dow > 5) continue;
    daily.push(byDate[iso(t)] ?? 0);
  }
  if (daily.length < MIN_HISTORY_DAYS) return null;

  // 3. Convolve the empirical distribution over the remaining days.
  const maxN = Math.max(...daily);
  const pmf = Array.from({ length: maxN + 1 }, (_, k) => daily.filter((d) => d === k).length / daily.length);

  let dist = [1];
  for (let d = 0; d < remainingDays; d++) {
    const next = new Array(dist.length + maxN).fill(0);
    for (let i = 0; i < dist.length; i++) {
      if (!dist[i]) continue;
      for (let k = 0; k <= maxN; k++) next[i + k] += dist[i] * pmf[k];
    }
    dist = next;
  }

  const pYes = clamp01(dist.slice(needed).reduce((a, b) => a + b, 0));

  const probs = [];
  probs[spec.yesIdx] = pYes;
  probs[1 - spec.yesIdx] = 1 - pYes;

  return {
    probs,
    source: spec.source,
    note: `have=${have} need=${needed} remainingWeekdays=${remainingDays} ` +
          `histDays=${daily.length} mean=${(daily.reduce((a, b) => a + b, 0) / daily.length).toFixed(2)}/d ` +
          `empiricalP=${pYes.toFixed(4)}`,
  };
}
