/**
 * Estimator v0 — the offence. The pacer only decides HOW MUCH may be in
 * flight; this decides WHETHER a given market is worth a position at all.
 *
 * Doctrine (inherited): the estimator is a PURE FUNCTION of a market
 * snapshot. No I/O, no clocks, no state. Same snapshot → same decision,
 * forever replayable. Abstention ("skip") is a first-class output.
 *
 * v0 edge — favorite-longshot bias. Documented for a century across betting
 * markets: longshots are systematically overpriced and heavy favorites
 * underpriced, because bettors overpay for lottery-shaped payoffs. In a
 * testnet arena full of reckless free-money agents, that skew should be
 * *stronger* than in real markets. So v0 buys well-priced favorites and
 * refuses lottery tickets. Deliberately boring; survives 14 days.
 *
 * Δ = q − p. No gap, no bet.
 */

'use strict';

/**
 * @typedef {object} MarketSnapshot
 * @property {string} id
 * @property {number} yesPrice     current price of YES, in (0,1)
 * @property {number} [liquidity]  optional depth signal
 * @property {number} [closesInMs] time to market close
 *
 * @typedef {object} Decision
 * @property {'bet'|'skip'} action
 * @property {'YES'|'NO'}   [side]
 * @property {number}       [edge]      q − p on the chosen side
 * @property {number}       [stakeFrac] fraction of maxPerPosition to use (0..1]
 * @property {string}       reason
 */

export const DEFAULTS = {
  favThreshold: 0.80,   // a side priced ≥ this is a "favorite"
  extremeCap: 0.97,     // beyond this there is no room left — skip
  biasEdge: 0.03,       // assumed underpricing of favorites (the documented skew)
  minEdge: 0.02,        // Δ floor: below this, no bet
  minCloseMs: 10 * 60e3,        // too close to resolution → adverse-selection risk
  maxCloseMs: 5 * 24 * 3600e3,  // too far out → capital parked, latency ruins pacing
};

/**
 * @param {MarketSnapshot} m
 * @param {typeof DEFAULTS} [cfg]
 * @returns {Decision}
 */
export function estimate(m, cfg = DEFAULTS) {
  const p = m.yesPrice;
  if (!(p > 0 && p < 1)) return { action: 'skip', reason: 'bad-price' };

  if (m.closesInMs !== undefined) {
    if (m.closesInMs < cfg.minCloseMs) return { action: 'skip', reason: 'too-close-to-resolution' };
    if (m.closesInMs > cfg.maxCloseMs) return { action: 'skip', reason: 'too-far-out' };
  }

  // Which side (if either) is the favorite?
  const side = p >= cfg.favThreshold ? 'YES' : (1 - p) >= cfg.favThreshold ? 'NO' : null;
  if (!side) return { action: 'skip', reason: 'no-favorite' };

  const price = side === 'YES' ? p : 1 - p;
  if (price > cfg.extremeCap) return { action: 'skip', reason: 'no-room-left' };

  // q = price + assumed favorite underpricing; Δ = q − p on the chosen side.
  const q = Math.min(0.995, price + cfg.biasEdge);
  const edge = q - price;
  if (edge < cfg.minEdge) return { action: 'skip', reason: 'edge-below-floor' };

  // Stake sizing: quarter-Kelly on the assumed edge, capped at 1.
  // Kelly for binary at price `price` with belief `q`: f* = (q − price) / (1 − price)
  const kelly = edge / (1 - price);
  const stakeFrac = Math.min(1, Math.max(0.05, kelly * 0.25));

  return { action: 'bet', side, edge, stakeFrac, reason: `favorite-${side}@${price.toFixed(2)}` };
}
