/**
 * Read-only status check. Never trades.
 *   node --env-file=.env scripts/status.mjs
 *
 * Answers the three questions that matter before a run:
 *   is the wallet funded, is it gassed, and what is open right now.
 */
import { DelphiClient } from '@gensyn-ai/gensyn-delphi-sdk';

const client = new DelphiClient({
  network: process.env.DELPHI_NETWORK ?? 'competition-testnet',
  signerType: 'private_key',
  privateKey: process.env.WALLET_PRIVATE_KEY,
  apiKey: process.env.DELPHI_API_ACCESS_KEY,
});

const { address } = await client.getSigner();
const eth = await client.getEthBalance();
const { balance, decimals } = await client.getErc20BalanceWithDecimals();
const tst = Number(balance) / 10 ** decimals;

console.log(`wallet   ${address}`);
console.log(`gas      ${Number(eth) / 1e18} ETH        ${eth === 0n ? '← BLOCKED: no gas' : 'ok'}`);
console.log(`balance  ${tst} TST (${decimals}dp)  ${tst === 0 ? '← BLOCKED: not funded yet' : 'ok'}`);

const { positions } = await client.listPositions({ wallet: address, limit: 100 });
const open = (positions ?? []).filter((p) => !p.redeemedOrLiquidated);
console.log(`open positions ${open.length} / ${(positions ?? []).length} total`);

const { markets } = await client.listMarkets({
  status: 'open', orderBy: 'settles_at', limit: 100,
  pricesAndImpliedProbabilities: true,
});
console.log(`\nopen markets: ${(markets ?? []).length}`);
for (const m of markets ?? []) {
  const p = m.spotImpliedProbabilities ?? [];
  console.log(
    `  ${m.resolvesAt}  [${m.category}]  ${p.map((x) => x.toFixed(3)).join(' / ')}`,
    `\n      ${m.metadata?.question}`
  );
}
