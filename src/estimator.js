/**
 * Estimator v1 — the offence. The pacer only decides HOW MUCH may be in
 * flight; this decides WHETHER a market is worth a position at all.
 *
 * Doctrine (unchanged): the estimator is a PURE FUNCTION of a market snapshot
 * and a forecast. No I/O, no clocks, no state. Same inputs → same decision,
 * forever replayable. Abstention ("skip") is a first-class output, and every
 * skip carries a named reason.
 *
 * WHAT CHANGED FROM v0, AND WHY
 * -----------------------------
 * v0 assumed an edge: the favorite-longshot bias, a documented tendency for
 * bettors to overpay for lottery-shaped payoffs. Measured against the live
 * competition set it produced 3 bets on 14 markets and deployed 0.41% of the
 * stack — best case +0.14 tokens against a top-3 bar of +1,163. The premise
 * did not survive contact: these prices cluster near 0.50 because the
 * questions are genuinely uncertain 24-48h events, not because a crowd is
 * mispricing tails.
 *
 * v1 assumes nothing. `q` is supplied by a forecaster that reads the SAME
 * source the market's own oracle uses to settle (every market publishes
 * `dataSources` and a `prompt_context` naming its resolution feed). If no
 * forecaster can price a market, the answer is `skip`, not a guess.
 *
 * The competition runs LMSR, so a winning share pays EXACTLY 1 token and the
 * quoted price IS the implied probability. That collapses expected value to a
 * subtraction:
 *
 *     EV per share = q − price
 *
 * with the 0.5% trading fee folded into the cost side.
 */

'use strict';

/**
 * @typedef {object} Outcome
 * @property {number} idx
 * @property {string} name
 * @property {number} price   implied probability, (0,1); outcomes sum to 1
 *
 * @typedef {object} MarketSnapshot
 * @property {string} id
 * @property {Outcome[]} outcomes
 * @property {number} [closesInMs]
 *
 * @typedef {object} Forecast
 * @property {number[]} probs   our probability per outcome, same order/length
 * @property {string}   source  what produced it — goes in the audit log
 * @property {string}   [note]
 *
 * @typedef {object} Decision
 * @property {'bet'|'skip'} action
 * @property {number} [outcomeIdx]
 * @property {string} [side]      outcome name, for humans reading the log
 * @property {number} [q]         our probability
 * @property {number} [price]     market's
 * @property {number} [edge]      q − cost, after fee
 * @property {number} [bankrollFrac] fraction of BANKROLL to stake (0..1]
 * @property {number} [kellyFull]    the un-scaled Kelly fraction, for the log
 * @property {string} reason
 *
 * NOTE ON SIZING. `bankrollFrac` is a fraction of the bankroll, which is what
 * Kelly is defined over — it is NOT a fraction of the per-position floor. The
 * caller takes `min(bankrollFrac × bankroll, maxPerPosition)`. Multiplying it
 * by the floor instead applies the shrink twice and silently under-deploys by
 * roughly the ratio between them.
 */

export const DEFAULTS = {
  feeRate: 0.005,        // 0.5% per trade, charged on every competition market
  minEdge: 0.025,        // below this the edge is inside our own model error

  // TOURNAMENT MODE — the objective is P(finish top-3), not expected log wealth.
  //
  // Only the top 3 of ~128 are paid. Finishing with 600 TST pays exactly what
  // finishing with 0 pays: nothing. So ruin is not a cost here, and the usual
  // Kelly reasoning — which maximises E[log W] and treats bankruptcy as
  // infinitely bad — is optimising a utility function we do not have.
  //
  // For a step-function payoff at a target far above current wealth, the
  // optimal policy is BOLD PLAY: overbet past Kelly and prefer high-variance
  // outcomes. Kelly growth-optimality is irrelevant when the median outcome
  // pays zero either way.
  //
  // kellyFraction > 1 is therefore deliberate, not a mistake. It lowers
  // expected log wealth and raises P(reaching target), which is the trade we
  // actually want.
  kellyFraction: 1.6,

  // Target equity for the tournament objective. Sizing scales up the further
  // below this we are — bold play means betting harder when further behind.
  targetEquity: 3800,

  // Preference for high-payoff (low-price) outcomes. Among outcomes that clear
  // minEdge, a longshot at 0.15 paying 6.7x delivers the variance a step-payoff
  // needs; a 0.90 favourite paying 1.1x cannot get us from 600 to 3800 no
  // matter how often it wins. Weight = edge x (payoff multiple)^varianceBias.
  varianceBias: 0.6,

  maxStakeFrac: 1,
  minCloseMs: 20 * 60e3,        // inside this, we cannot get filled and out cleanly
  maxCloseMs: 6 * 24 * 3600e3,  // beyond this, capital is parked past the window
  maxCost: 0.97,         // nothing left to win; also where LMSR depth gets ugly
  sumTolerance: 0.01,    // LMSR prices must sum to 1 — otherwise wrong network
};

/**
 * @param {MarketSnapshot} m
 * @param {Forecast|null} forecast
 * @param {typeof DEFAULTS} [cfg]
 * @returns {Decision}
 */
export function estimate(m, forecast, cfg = DEFAULTS) {
  const outcomes = m.outcomes;
  if (!Array.isArray(outcomes) || outcomes.length < 2) {
    return { action: 'skip', reason: 'malformed-market' };
  }

  // No forecaster covers this market. That is the honest answer, and it is the
  // most common one — refusing to price is the point, not a failure mode.
  if (!forecast) return { action: 'skip', reason: 'no-forecaster' };

  // A forecaster matched but could not answer — a broken feed, not a market we
  // have no view on. Kept distinct so a network outage cannot masquerade as
  // deliberate abstention in the log.
  if (forecast.failed) return { action: 'skip', reason: forecast.reason ?? 'forecaster-unavailable' };

  if (!Array.isArray(forecast.probs)) return { action: 'skip', reason: 'no-forecaster' };
  if (forecast.probs.length !== outcomes.length) {
    return { action: 'skip', reason: 'forecast-shape-mismatch' };
  }

  for (const o of outcomes) {
    if (!(o.price > 0 && o.price < 1)) return { action: 'skip', reason: 'bad-price' };
  }
  // LMSR outcome prices are a softmax over supplies and must sum to 1. If they
  // do not, we are reading something other than a competition market.
  const sum = outcomes.reduce((a, o) => a + o.price, 0);
  if (Math.abs(sum - 1) > cfg.sumTolerance) return { action: 'skip', reason: 'prices-do-not-sum-to-1' };

  const qSum = forecast.probs.reduce((a, b) => a + b, 0);
  if (!(qSum > 0.98 && qSum < 1.02)) return { action: 'skip', reason: 'forecast-not-normalised' };

  if (m.closesInMs !== undefined) {
    if (m.closesInMs < cfg.minCloseMs) return { action: 'skip', reason: 'too-close-to-resolution' };
    if (m.closesInMs > cfg.maxCloseMs) return { action: 'skip', reason: 'too-far-out' };
  }

  // Best edge across outcomes. The fee lands on the cost side: we pay
  // price × (1 + fee) for something that returns 1 if it wins.
  // Among outcomes clearing the edge floor, pick by TOURNAMENT SCORE rather
  // than raw edge: edge x (payoff multiple)^varianceBias. A step-function
  // payoff needs variance, and variance lives in the low-priced outcomes.
  let best = null;
  for (const o of outcomes) {
    const cost = o.price * (1 + cfg.feeRate);
    if (cost >= cfg.maxCost) continue;
    const q = forecast.probs[o.idx];
    if (!(q >= 0 && q <= 1)) continue;
    const edge = q - cost;
    if (edge < cfg.minEdge) continue;
    const payoff = 1 / cost;                       // a winning share returns exactly 1
    const score = edge * Math.pow(payoff, cfg.varianceBias);
    if (!best || score > best.score) best = { o, q, cost, edge, score, payoff };
  }

  // Nothing cleared the floor. Report the closest miss so the log names it.
  if (!best) {
    let near = null;
    for (const o of outcomes) {
      const cost = o.price * (1 + cfg.feeRate);
      const q = forecast.probs[o.idx];
      if (!(q >= 0 && q <= 1)) continue;
      const edge = q - cost;
      if (!near || edge > near.edge) near = { edge };
    }
    return {
      action: 'skip',
      reason: near ? `edge-below-floor(${near.edge.toFixed(3)}<${cfg.minEdge})` : 'no-priceable-outcome',
    };
  }


  // Kelly for a share costing `cost` that pays 1 with probability q:
  //   f* = (q − cost) / (1 − cost)
  // Quarter-Kelly. The edge is measured rather than assumed, which is what
  // makes Kelly meaningful here at all — v0's Kelly was applied to a constant.
  const kellyFull = best.edge / (1 - best.cost);

  // Bold-play scaling: the further below target, the harder we bet. `shortfall`
  // is how many multiples of current equity we still need; it is passed in by
  // the caller (which knows equity) and defaults to 1 = at target.
  const shortfall = Number.isFinite(cfg.shortfall) ? Math.max(1, cfg.shortfall) : 1;
  const boldness = Math.min(3, 1 + Math.log(shortfall));
  const bankrollFrac = Math.min(cfg.maxStakeFrac, Math.max(0, kellyFull * cfg.kellyFraction * boldness));
  if (bankrollFrac <= 0) return { action: 'skip', reason: 'stake-rounds-to-zero' };

  return {
    action: 'bet',
    outcomeIdx: best.o.idx,
    side: best.o.name,
    q: best.q,
    price: best.o.price,
    edge: best.edge,
    kellyFull,
    bankrollFrac,
    payoff: best.payoff,
    boldness,
    reason: `${forecast.source}: q=${best.q.toFixed(3)} vs price=${best.o.price.toFixed(3)}`,
  };
}
