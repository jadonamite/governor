/**
 * Redeem/liquidate sweep. Converts decided positions back into TST.
 *
 *   node --env-file=.env scripts/sweep.mjs
 *
 * `settled` markets redeem at exactly 1 token per winning share. `expired` and
 * `failed` have no winning outcome — redeem() reverts on them and the
 * collateral comes back via liquidate() instead. A competition can end with a
 * lot of both, so this runs both paths, not just the happy one.
 */
import { DelphiVenue } from '../src/delphi-venue.js';

const venue = new DelphiVenue();
const info = await venue.init();
const before = await venue.balance();
console.log(`wallet ${info.address}  balance ${before} TST  positions recovered ${info.recovered}`);

const done = await venue.resolutions();
if (!done.length) {
  console.log('nothing to sweep — no position has reached a terminal state');
} else {
  for (const r of done) {
    const pnl = Number.isFinite(r.spent) ? r.ret - r.spent : null;
    console.log(`swept ${r.id.slice(0, 10)} outcome=${r.outcomeIdx} returned=${r.ret.toFixed(4)} TST` +
      (pnl === null ? '  (cost basis unknown — recovered position)' : `  pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)}`));
  }
}

const after = await venue.balance();
console.log(`balance ${before} → ${after} TST  (delta ${(after - before).toFixed(4)})`);
