/**
 * US Treasury daily par yield curve forecaster (CMT yield vs threshold).
 *
 * Markets ask whether the Daily Treasury Par Yield Curve Rate for a stated
 * maturity, on a stated business date, is above a stated percentage.
 *
 * THE DECOMPOSITION — this is the whole edge, and it is a timing edge.
 *
 * The settlement figure is ADMINISTRATIVE: Treasury computes it from end-of-day
 * bid yields and publishes it in an Atom feed, once, after the bond market
 * closes — typically hours AFTER the market's own resolution timestamp. So at
 * decision time the settling number does not exist yet and cannot be looked up.
 *
 * But the underlying quantity is observable continuously. CBOE publishes the
 * 10-year note yield index (^TNX) intraday, and measured against Treasury's own
 * published series over the last year it tracks the CMT to within a basis point
 * (mean spread +0.5bp, sd 1.0bp). That gives an anchor that is up to a full
 * business day fresher than the last published figure.
 *
 * Freshness is the entire game here, because the horizon enters as sqrt(h):
 * daily changes in the 10-year run ~4bp, so a two-business-day horizon carries
 * ~5.7bp of uncertainty and a one-day horizon ~4bp. On a threshold sitting a
 * couple of basis points from spot, that difference moves the probability by
 * ten points or more. A participant anchoring on the last PUBLISHED figure and
 * pricing it as one day out is answering a different question than the market
 * settles on. Reading the live quote and counting the business days properly is
 * the information the posted price may not carry.
 *
 * ROUNDING IS NOT COSMETIC. Treasury publishes to two decimals and the criteria
 * compare the published figure exactly. "Strictly greater than 4.68" therefore
 * needs a published 4.69, i.e. a true yield of 4.685 or more. Comparing against
 * 4.68 instead shifts the cutoff by half a basis point — an eighth of a daily
 * sigma, and it always shifts in the direction of overstating our edge.
 *
 * NO DRIFT. Daily changes are modelled as mean-zero even though the trailing
 * year has a small positive mean. Extrapolating that drift is the `crypto-close`
 * mistake in another costume: it is a statistic every participant can compute,
 * it carries no information the price lacks, and at these horizons it is well
 * inside the noise.
 *
 * Fails closed: an unnamed field code, a maturity we cannot map, a stale live
 * quote, a thin history, or a target date more than a few business days out all
 * return null.
 */

'use strict';

import { clamp01, mean, pAbove, stdev, fetchRetry, fetchRetryText } from './stats.js';

const TREASURY_XML =
  'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml' +
  '?data=daily_treasury_yield_curve&field_tdr_date_value_month=';

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const UA = 'governor-agent/0.1 (delphi competition; contact via github.com/jadonamite/governor)';

// Field code → the live index that tracks it. Only maturities with a public
// intraday proxy are priceable at all; anything else has no anchor fresher than
// the published series and is therefore not our market.
const PROXY = {
  BC_10YEAR: '%5ETNX',
  BC_30YEAR: '%5ETYX',
  BC_5YEAR: '%5EFVX',
  BC_13WEEK: '%5EIRX',
};

const MIN_SPREAD_DAYS = 15;   // overlapping CMT/proxy closes needed to trust the spread
const MIN_CHANGE_DAYS = 20;   // daily changes needed to trust sigma
const MAX_ANCHOR_AGE_D = 5;   // a proxy quote older than this is a broken feed, not data
const MAX_HORIZON_D = 6;      // beyond this the sqrt-time band is wider than the question
const TICK = 0.01;            // the published series is quoted to two decimals

const monthKey = (ms) => new Date(ms).toISOString().slice(0, 7).replace('-', '');
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

export function match(market) {
  const sources = Array.isArray(market.dataSources) ? market.dataSources : [];
  const hasTreasury = sources.some(
    (s) => typeof s === 'string' &&
      s.includes('home.treasury.gov') &&
      s.includes('daily_treasury_yield_curve'),
  );
  if (!hasTreasury) return null;

  const text = `${market.metadata?.model?.prompt_context ?? ''}\n${market.question ?? market.metadata?.question ?? ''}`;

  // The field code is binding and is named explicitly in the criteria. Do NOT
  // infer the maturity from the question text: the nominal curve, the real
  // (inflation-indexed) curve and the bill curve are separate series that the
  // criteria go out of their way to distinguish, and they differ by whole
  // percentage points.
  const field = Object.keys(PROXY).find((f) => text.includes(f));
  if (!field) return null;
  if (/\breal\s+(?:\(inflation[^)]*\)\s+)?(?:yield|curve|rate)/i.test(text) &&
      !/not the real/i.test(text)) return null;

  const m = text.match(
    /\b(strictly greater than|greater than or equal to|greater than|at or above|above|at or below|less than or equal to|less than|below)\s+([\d.]+)\s*(?:percent|%)/i,
  );
  if (!m) return null;
  const threshold = Number(m[2]);
  if (!Number.isFinite(threshold)) return null;

  const cmp = m[1].toLowerCase();
  const aboveWins = /greater|above/.test(cmp);
  const strict = !/or equal to|at or/.test(cmp);

  const d = text.match(/business date\s+(\d{4}-\d{2}-\d{2})/i) ??
            text.match(/\bfor\s+(\d{4}-\d{2}-\d{2})\b/);
  if (!d) return null;
  const targetDate = d[1];
  const targetMs = Date.parse(`${targetDate}T00:00:00Z`);
  if (!Number.isFinite(targetMs)) return null;

  const outcomes = market.metadata?.outcomes ?? [];
  if (outcomes.length !== 2) return null;
  const yesIdx = outcomes.findIndex((o) => /^yes$/i.test(String(o).trim()));
  if (yesIdx === -1) return null;

  return {
    field, proxy: PROXY[field], threshold, aboveWins, strict,
    targetDate, targetMs, yesIdx, source: `treasury-yield:${field}`,
  };
}

/** Parse the Atom feed into { 'YYYY-MM-DD': rate } for one field code. */
function parseFeed(xml, field) {
  const out = {};
  const entries = xml.split(/<entry\b/i).slice(1);
  const re = new RegExp(`<d:${field}[^>]*>([^<]+)<`, 'i');
  for (const e of entries) {
    const dm = e.match(/<d:NEW_DATE[^>]*>(\d{4}-\d{2}-\d{2})/i);
    const vm = e.match(re);
    if (!dm || !vm) continue;
    const v = parseFloat(vm[1]);
    if (Number.isFinite(v)) out[dm[1]] = v;      // a blank cell is skipped, never zeroed
  }
  return out;
}

/** Business days strictly after `fromDay`, up to and including `toDay`. */
function businessDaysBetween(fromDay, toDay) {
  let n = 0;
  let t = Date.parse(`${fromDay}T00:00:00Z`) + 864e5;
  const end = Date.parse(`${toDay}T00:00:00Z`);
  while (t <= end) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
    t += 864e5;
  }
  return n;
}

export async function forecast(market, now = Date.now()) {
  const spec = match(market);
  if (!spec) return null;

  // Treasury publishes the figure well after the market's resolution time; once
  // the target business day is a day behind us the question is settled fact and
  // not ours to forecast.
  if (now > spec.targetMs + 2 * 864e5) return null;
  if (businessDaysBetween(isoDay(now), spec.targetDate) > MAX_HORIZON_D) return null;

  // 1. Published CMT series. Two months so the change and spread samples
  //    survive the first days of a month.
  const prevMonthMs = Date.parse(`${spec.targetDate.slice(0, 7)}-01T00:00:00Z`) - 864e5;
  let published = {};
  try {
    const feeds = await Promise.all([
      fetchRetryText(TREASURY_XML + monthKey(prevMonthMs)),
      fetchRetryText(TREASURY_XML + monthKey(spec.targetMs)),
    ]);
    for (const xml of feeds) Object.assign(published, parseFeed(xml, spec.field));
  } catch { return null; }

  const pubDays = Object.keys(published).sort();
  if (pubDays.length < MIN_CHANGE_DAYS + 1) return null;

  // Already published? Then there is nothing to forecast — read it off. Still
  // clamped: the oracle can misread a feed we read correctly.
  const settledValue = published[spec.targetDate];

  // 2. Daily-change sigma, measured on the settling series itself. Mean-zero by
  //    construction — see the header on drift.
  const changes = [];
  for (let i = 1; i < pubDays.length; i++) changes.push(published[pubDays[i]] - published[pubDays[i - 1]]);
  const sigmaDaily = stdev(changes);
  if (!Number.isFinite(sigmaDaily) || sigmaDaily <= 0) return null;

  // 3. Live proxy: daily closes for the spread, plus the intraday quote itself.
  let proxyCloses = {};
  let liveLevel = NaN;
  let liveMs = NaN;
  if (settledValue === undefined) {
    try {
      const j = await fetchRetry(`${YAHOO}${spec.proxy}?range=6mo&interval=1d`, { headers: { 'User-Agent': UA } });
      const r = j?.chart?.result?.[0];
      const ts = r?.timestamp ?? [];
      const close = r?.indicators?.quote?.[0]?.close ?? [];
      ts.forEach((t, i) => {
        const v = close[i];
        if (Number.isFinite(v)) proxyCloses[isoDay(t * 1000)] = v;
      });
      liveLevel = r?.meta?.regularMarketPrice;
      liveMs = Number(r?.meta?.regularMarketTime) * 1000;
    } catch { /* fall back to the published anchor below */ }
  }

  // 4. Spread between the settling series and the proxy, measured on matching
  //    days. Measured, never assumed — the two are different instruments.
  const spreads = [];
  for (const d of pubDays) {
    if (proxyCloses[d] !== undefined) spreads.push(published[d] - proxyCloses[d]);
  }
  const spreadMean = mean(spreads);
  const spreadSd = stdev(spreads);
  const proxyUsable =
    Number.isFinite(liveLevel) && liveLevel > 0 &&
    Number.isFinite(liveMs) &&
    spreads.length >= MIN_SPREAD_DAYS &&
    Number.isFinite(spreadMean) && Number.isFinite(spreadSd) &&
    now - liveMs < MAX_ANCHOR_AGE_D * 864e5;

  // 5. Pick the freshest defensible anchor and count the horizon FROM IT.
  const lastPubDay = pubDays[pubDays.length - 1];
  let anchor;
  let anchorDay;
  let convVar = 0;
  let anchorKind;
  if (proxyUsable && isoDay(liveMs) >= lastPubDay) {
    anchor = liveLevel + spreadMean;
    anchorDay = isoDay(liveMs);
    convVar = spreadSd ** 2;                    // converting proxy → CMT is itself noisy
    anchorKind = `proxy@${new Date(liveMs).toISOString().slice(0, 16)}Z`;
  } else {
    anchor = published[lastPubDay];
    anchorDay = lastPubDay;
    anchorKind = `published@${lastPubDay}`;
  }
  if (!Number.isFinite(anchor)) return null;

  let pTrue;
  let horizon = 0;
  let sigma = 0;
  // The cutoff on the TRUE yield that makes the PUBLISHED (2dp) figure win.
  // Strict ">4.68" needs a printed 4.69, so the true level must reach 4.685.
  const cutoff = spec.strict ? spec.threshold + TICK / 2 : spec.threshold - TICK / 2;

  if (settledValue !== undefined) {
    const won = spec.strict ? settledValue > spec.threshold : settledValue >= spec.threshold;
    pTrue = won ? 1 : 0;
    anchorKind = `settled@${spec.targetDate}`;
    anchor = settledValue;
  } else {
    horizon = businessDaysBetween(anchorDay, spec.targetDate);
    if (horizon < 0 || horizon > MAX_HORIZON_D) return null;
    // Anchor taken during the target session itself: only the rest of that
    // session is still unknown. Half a day is the conservative read — it is
    // wider than the truth late in the session and never narrower than zero.
    const effective = horizon === 0 ? 0.5 : horizon;
    sigma = Math.sqrt(effective * sigmaDaily ** 2 + convVar);
    if (!(sigma > 0)) return null;
    pTrue = pAbove(cutoff, anchor, sigma);
  }

  // Holidays are not modelled: business days are counted Mon–Fri, so a bank
  // holiday inside the horizon overstates it by one day. That widens sigma and
  // pulls the probability toward 0.5, which is the safe direction to be wrong.
  const pAboveCut = pTrue;
  const pYes = clamp01(spec.aboveWins ? pAboveCut : 1 - pAboveCut);

  const probs = [];
  probs[spec.yesIdx] = pYes;
  probs[1 - spec.yesIdx] = 1 - pYes;

  return {
    probs,
    source: spec.source,
    note: `anchor=${anchor.toFixed(4)} (${anchorKind}) cutoff=${cutoff.toFixed(3)} ` +
          `h=${horizon}bd sigmaDaily=${sigmaDaily.toFixed(4)} sigma=${sigma.toFixed(4)} ` +
          `spread=${Number.isFinite(spreadMean) ? spreadMean.toFixed(4) : 'n/a'}` +
          `±${Number.isFinite(spreadSd) ? spreadSd.toFixed(4) : 'n/a'} nSpread=${spreads.length} ` +
          `nChanges=${changes.length} pAbove=${pAboveCut.toFixed(4)}`,
  };
}
