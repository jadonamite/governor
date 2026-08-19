/**
 * Sell out of a held position before settlement. Spends gas; moves money.
 *
 *   node --env-file=.env scripts/exit.mjs <marketId> [fraction]
 *
 * Re-prices first and REFUSES if our own forecast still supports holding —
 * an exit is only correct when the book pays more than we now believe the
 * position is worth.
 */
import { DelphiVenue } from '../src/delphi-venue.js';
import { forecastFor } from '../src/forecasters/index.js';

const [, , marketId, fracArg] = process.argv;
if (!marketId) { console.error('usage: exit.mjs <marketId> [fraction]'); process.exit(1); }
const fraction = Number(fracArg ?? 1);

const venue = new DelphiVenue();
await venue.init();
const before = await venue.balance();

const pos = venue.held.get(marketId) ?? venue.held.get(marketId.toLowerCase());
if (!pos) { console.error('no open position in that market'); process.exit(1); }

const m = await venue.client.getMarket({ id: marketId, pricesAndImpliedProbabilities: true });
const snap = {
  id: m.id, question: m.metadata?.question, dataSources: m.dataSources, metadata: m.metadata,
  outcomes: (m.metadata?.outcomes ?? []).map((n, i) => ({ idx: i, name: n, price: m.spotImpliedProbabilities?.[i] })),
  closesInMs: new Date(m.resolvesAt).getTime() - Date.now(),
};
const fc = await forecastFor(snap, Date.now());

const price = m.spotImpliedProbabilities?.[pos.outcomeIdx];
const q = fc?.probs?.[pos.outcomeIdx];

console.log(m.metadata?.question);
console.log(`  holding ${(Number(pos.shares) / 1e18).toFixed(2)} shares of outcome ${pos.outcomeIdx}`);
console.log(`  market ${price?.toFixed(4)}   our q ${q === undefined ? 'n/a' : q.toFixed(4)}`);

if (q !== undefined && q > price) {
  console.error(`REFUSING: our forecast (${q.toFixed(4)}) is still above the market (${price.toFixed(4)}) — holding is correct`);
  process.exit(1);
}

const out = await venue.exit(marketId, fraction);
if (!out) { console.error('no fill — depth refused every size'); process.exit(1); }

console.log(`SOLD ${out.shares.toFixed(4)} shares for ${out.got.toFixed(4)} TST (avg ${(out.got / out.shares).toFixed(4)})`);
const after = await venue.balance();
console.log(`balance ${before.toFixed(4)} → ${after.toFixed(4)} TST  (delta +${(after - before).toFixed(4)})`);
