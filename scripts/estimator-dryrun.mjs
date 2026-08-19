/**
 * Read-only. Runs the current estimator against the live market set and reports
 * what it would actually deploy. No trades, no signing beyond address lookup.
 *   node --env-file=.env scripts/estimator-dryrun.mjs
 */
import { DelphiVenue } from '../src/delphi-venue.js';
import { estimate } from '../src/estimator.js';

const FLOOR_MAX_PER_POSITION = 25; // as configured in runner.js
const START_BALANCE = 1000;        // every entrant starts here

const venue = new DelphiVenue();
await venue.init();
const markets = await venue.markets(Date.now());

let deployed = 0, bets = 0;
const skips = {};

for (const m of markets) {
  const binary = m.outcomes.length === 2;
  if (!binary) { skips['non-binary (estimator cannot price)'] = (skips['non-binary (estimator cannot price)'] ?? 0) + 1; continue; }

  const d = estimate({
    id: m.id,
    yesPrice: m.outcomes[0].price,
    closesInMs: m.closesInMs,
  });

  if (d.action === 'skip') {
    skips[d.reason] = (skips[d.reason] ?? 0) + 1;
    continue;
  }
  const stake = +(FLOOR_MAX_PER_POSITION * d.stakeFrac).toFixed(2);
  deployed += stake;
  bets++;
  console.log(`BET  ${stake.toFixed(2)} TST  ${d.side}  edge=${d.edge.toFixed(4)}  ${m.question.slice(0, 70)}`);
}

console.log(`\nmarkets seen        ${markets.length}`);
console.log(`bets                ${bets}`);
console.log(`capital deployed    ${deployed.toFixed(2)} TST of ${START_BALANCE} (${(deployed / START_BALANCE * 100).toFixed(2)}%)`);
console.log(`\nskip reasons:`);
for (const [r, n] of Object.entries(skips).sort((a, b) => b[1] - a[1])) console.log(`  ${n}×  ${r}`);

const maxWin = deployed * 0.03 / 0.85; // assumed 3% edge realised on favorites
console.log(`\nif every bet won at the assumed edge: ~+${maxWin.toFixed(2)} TST`);
console.log(`top-3 bar on the live leaderboard:     +1163 TST`);
