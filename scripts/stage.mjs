/**
 * READ-ONLY. Prices every open market, runs the estimator, and quotes the
 * intended size against live LMSR depth. Executes nothing.
 *
 *   node --env-file=.env scripts/stage.mjs [stakeTokens]
 *
 * `quoteBuy` is an eth_call, so this works with a zero balance — which is the
 * point: the position can be composed and checked before funding lands.
 */
import { DelphiVenue } from '../src/delphi-venue.js';
import { forecastFor } from '../src/forecasters/index.js';
import { estimate } from '../src/estimator.js';

const STAKE = Number(process.argv[2] ?? 25);        // phase-0 floor: maxPerPosition
const BANKROLL = Number(process.argv[3] ?? 1000);   // starting balance every entrant gets

const venue = new DelphiVenue();
const { address, tokenDp } = await venue.init();
console.log(`wallet ${address}  ·  token ${tokenDp}dp  ·  maxPerPosition ${STAKE} TST  ·  bankroll ${BANKROLL} TST\n`);

const now = Date.now();
const markets = await venue.markets(now);

const bets = [];
const skips = {};

for (const m of markets) {
  const fc = await forecastFor(m, now);
  const d = estimate(m, fc);

  if (d.action === 'skip') {
    skips[d.reason] = (skips[d.reason] ?? 0) + 1;
    continue;
  }

  // Kelly is a fraction of bankroll; the floor is a separate, absolute cap.
  const wanted = d.bankrollFrac * BANKROLL;
  const stake = +Math.min(wanted, STAKE).toFixed(2);
  bets.push({ m, d, fc, stake });

  console.log('='.repeat(76));
  console.log(m.question);
  console.log(`  BUY   ${d.side}  (outcome ${d.outcomeIdx})`);
  console.log(`  q     ${d.q.toFixed(4)}   market ${d.price.toFixed(4)}   edge ${d.edge.toFixed(4)}`);
  console.log(`  kelly ${d.kellyFull.toFixed(3)} full → scaled ${d.bankrollFrac.toFixed(3)} of bankroll = ${wanted.toFixed(2)} TST`);
  console.log(`  stake ${stake} TST${wanted > STAKE ? `   (floor-capped from ${wanted.toFixed(2)})` : ''}`);
  console.log(`  src   ${fc.source}`);
  if (fc.note) console.log(`  note  ${fc.note}`);
  console.log(`  resolves ${new Date(m.resolvesAtMs).toISOString()}  (${(m.closesInMs / 3600e3).toFixed(1)}h)`);

  // Depth probe: what does the curve actually charge for the size we want?
  const wantShares = stake / d.price;
  console.log(`  depth probe (target ${wantShares.toFixed(2)} shares):`);
  for (const f of [1, 0.5, 0.25, 0.1]) {
    const shares = wantShares * f;
    const sharesOut = BigInt(Math.round(shares * 1e6)) * (10n ** 12n);
    try {
      const { tokensIn } = await venue.client.quoteBuy({
        marketAddress: m.id, outcomeIdx: d.outcomeIdx, sharesOut,
      });
      const cost = Number(tokensIn) / 10 ** tokenDp;
      const avg = cost / shares;
      const slip = (avg / d.price - 1) * 100;
      console.log(`    ${String(shares.toFixed(2)).padStart(8)} sh → ${cost.toFixed(4)} TST  avg ${avg.toFixed(4)}  slip ${slip >= 0 ? '+' : ''}${slip.toFixed(2)}%`);
    } catch (e) {
      console.log(`    ${String(shares.toFixed(2)).padStart(8)} sh → REVERTS (depth) — ${String(e.message ?? e).slice(0, 60)}`);
    }
  }
}

console.log('\n' + '='.repeat(76));
console.log(`markets ${markets.length}  ·  staged bets ${bets.length}  ·  capital ${bets.reduce((a, b) => a + b.stake, 0).toFixed(2)} TST`);
console.log('skips:');
for (const [r, n] of Object.entries(skips).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(2)}×  ${r}`);
