/**
 * Read-only. Dumps full metadata for open markets — including the settlement
 * data sources and oracle prompt context, which decide how a question actually
 * resolves. Filter with a substring:
 *   node --env-file=.env scripts/market-detail.mjs earthquake
 */
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';

const needle = (process.argv[2] ?? '').toLowerCase();

const client = new DelphiClient({
  network: process.env.DELPHI_NETWORK ?? 'competition-testnet',
  signerType: 'private_key',
  privateKey: process.env.WALLET_PRIVATE_KEY,
  apiKey: process.env.DELPHI_API_ACCESS_KEY,
});

const { markets } = await client.listMarkets({
  status: 'open', limit: 100, pricesAndImpliedProbabilities: true,
});

for (const m of markets ?? []) {
  const q = m.metadata?.question ?? '';
  if (needle && !q.toLowerCase().includes(needle)) continue;
  console.log('='.repeat(78));
  console.log(q);
  console.log(`  id          ${m.id}`);
  console.log(`  resolvesAt  ${m.resolvesAt}   settlesAt ${m.settlesAt}`);
  console.log(`  verifiable  ${m.verifiable}   fee ${m.tradingFee}`);
  console.log(`  outcomes    ${JSON.stringify(m.metadata?.outcomes)}`);
  console.log(`  probs       ${JSON.stringify(m.spotImpliedProbabilities)}`);
  console.log(`  dataSources ${JSON.stringify(m.dataSources, null, 2)}`);
  console.log(`  model       ${JSON.stringify(m.metadata?.model, null, 2)}`);
}
