/**
 * Executes ONE staged position. This is the only script in the repo that spends.
 *
 *   node --env-file=.env scripts/fire.mjs <marketId> [stakeTokens] [bankroll]
 *
 * It re-prices immediately before sending rather than trusting the numbers from
 * a staging run minutes old, and refuses if the edge has collapsed in between.
 * The market id is required so this cannot fire at something by accident.
 */
import { DelphiVenue } from '../src/delphi-venue.js';
import { forecastFor } from '../src/forecasters/index.js';
import { estimate } from '../src/estimator.js';

const [, , marketId, stakeArg, bankrollArg] = process.argv;
if (!marketId) { console.error('usage: fire.mjs <marketId> [stake] [bankroll]'); process.exit(1); }

const CAP = Number(stakeArg ?? 25);
const BANKROLL = Number(bankrollArg ?? 1000);

const venue = new DelphiVenue();
const { address } = await venue.init();
const balanceBefore = await venue.balance();
console.log(`wallet ${address}  balance ${balanceBefore} TST`);

const now = Date.now();
const markets = await venue.markets(now);
const m = markets.find((x) => x.id.toLowerCase() === marketId.toLowerCase());
if (!m) { console.error(`market ${marketId} is not in the open set — refusing`); process.exit(1); }

const fc = await forecastFor(m, now);
const d = estimate(m, fc);
if (d.action !== 'bet') { console.error(`estimator says skip: ${d.reason} — refusing`); process.exit(1); }

const stake = +Math.min(d.bankrollFrac * BANKROLL, CAP, balanceBefore).toFixed(2);

console.log(`\n${m.question}`);
console.log(`  BUY ${d.side} (idx ${d.outcomeIdx})  q=${d.q.toFixed(4)} price=${d.price.toFixed(4)} edge=${d.edge.toFixed(4)}`);
console.log(`  stake ${stake} TST\n  ${fc.note ?? ''}\n`);

const fill = await venue.stake(m.id, d.outcomeIdx, stake, d.price);
if (!fill) { console.error('no fill — depth refused every size on the ladder'); process.exit(1); }

console.log(`FILLED  ${fill.shares.toFixed(4)} shares for ${fill.spent.toFixed(4)} TST  (avg ${(fill.spent / fill.shares).toFixed(4)})`);

// Verify against chain rather than trusting the local record.
const balanceAfter = await venue.balance();
console.log(`balance ${balanceBefore} → ${balanceAfter} TST  (delta ${(balanceAfter - balanceBefore).toFixed(4)})`);

const { positions } = await venue.client.listPositions({ wallet: address, limit: 50 });
for (const p of positions ?? []) {
  console.log(`position  market=${p.marketProxy.slice(0, 10)} outcome=${p.outcomeIdx} shares=${Number(p.shares) / 1e18} status=${p.marketStatus}`);
}
console.log(`\nif ${d.side} wins: ${fill.shares.toFixed(2)} TST back, profit ${(fill.shares - fill.spent).toFixed(2)} TST`);
