/**
 * Read-only coverage probe. Never trades.
 *   node --env-file=.env scripts/probe.mjs
 *
 * Runs every registered forecaster against every OPEN market and prints belief
 * against posted price, side by side. Unlike stage.mjs it does NOT filter out
 * markets we already hold — venue.markets() hides those, which made a working
 * forecaster look like missing coverage.
 */
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';
import { forecastFor } from '../src/forecasters/index.js';

const c = new DelphiClient({
  network: process.env.DELPHI_NETWORK ?? 'competition-testnet',
  signerType: 'private_key',
  privateKey: process.env.WALLET_PRIVATE_KEY,
  apiKey: process.env.DELPHI_API_ACCESS_KEY,
});

const { markets } = await c.listMarkets({
  status: 'open', orderBy: 'settles_at', limit: 100, pricesAndImpliedProbabilities: true,
});

for (const m of markets ?? []) {
  const p = m.spotImpliedProbabilities ?? [];
  let f = null;
  try { f = await forecastFor(m); } catch (e) { f = { failed: true, reason: String(e.message ?? e) }; }
  console.log('---', (m.metadata?.question ?? '').slice(0, 95));
  const read = !f ? 'no-forecaster'
    : f.failed ? `FAILED ${f.reason}`
    : `${f.probs.map((x) => x.toFixed(3)).join('/')}  [${f.source}]`;
  console.log(`   price ${p.map((x) => x.toFixed(3)).join('/')} | fc: ${read}`);
  if (f?.note) console.log('   note ', f.note);
  if (f?.probs) {
    const edge = Math.max(...f.probs.map((q, i) => q - (p[i] ?? 1)));
    console.log(`   best edge ${edge >= 0 ? '+' : ''}${edge.toFixed(3)}`);
  }
}
