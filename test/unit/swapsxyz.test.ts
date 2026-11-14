import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setRouter } from '../../src/net/http.ts';
import { settings } from '../../src/app/settings.ts';
import { builtin } from '../../src/exchange/currency.ts';
import { STATES, TradeNotCreatedError } from '../../src/exchange/types.ts';
import { fromUnits, methodSelector, registerSwapsXyzTx, resetSwapsXyzCache, swapsXyz, toUnits, ZERO_ADDRESS } from '../../src/exchange/providers/swapsxyz.ts';

const USDC_ARB = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const USDT_ETH = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const ROUTER = '0x1111111111111111111111111111111111111111';

/** the stand-in API: what was asked, and Swaps.XYZ-shaped answers */
const asked: { path: string; q: Record<string, string>; key?: string; body?: string }[] = [];
let action: Record<string, unknown> = {};
const json = (o: unknown, status = 200) => ({ status, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(o)), via: 'tor' as const });
setRouter({
  async request(req: { url: string; headers?: Record<string, string>; body?: unknown }) {
    const u = new URL(req.url);
    const q = Object.fromEntries(u.searchParams);
    asked.push({ path: u.pathname, q, key: req.headers?.['x-api-key'], body: typeof req.body === 'string' ? req.body : undefined });
    switch (u.pathname) {
      case '/api/getChainList':
        return json([{ chainId: 1, name: 'Ethereum', vmId: 'evm' }, { chainId: 42161, name: 'Arbitrum', vmId: 'evm' }, { chainId: 8253038, name: 'Bitcoin', vmId: 'alt-vm' }]);
      case '/api/getPaths':
        if (q.srcToken === ZERO_ADDRESS && !q.dstChainId) {
          return q.srcChainId === '1'
            ? json({ srcToken: { symbol: 'eth', isNative: true, decimals: 18 }, paths: [{ chainId: 42161, tokens: [{ symbol: 'USDC', address: USDC_ARB, decimals: 6 }] }, { chainId: 1, tokens: [{ symbol: 'USDT', address: USDT_ETH, decimals: 6 }] }] })
            : json({ srcToken: { symbol: 'ETH', isNative: true, decimals: 18 }, paths: [{ chainId: 1, tokens: 'all' }] });
        }
        return json({ paths: [{ chainId: Number(q.dstChainId), supportsExactAmountIn: true, supportsExactAmountOut: false, amountLimits: { minAmount: '0.001', maxAmount: '10' }, tokens: [{ symbol: 'USDC', address: USDC_ARB, minAmount: '5', maxAmount: '50000' }] }] });
      case '/api/getQuote':
        return json({ exchangeRate: 3012.5 });
      case '/api/getAction':
        return json(action);
      case '/api/getStatus':
        return json({ txId: q.txId, status: 'SUCCESS', sender: '0xsender', srcTx: { toAddress: ROUTER, txHash: '0xhash', timestamp: '1700000000n', paymentToken: { symbol: 'USDT', decimals: 6, amount: '2500000n' } }, dstTx: { toAddress: '0xrecipient', paymentToken: { symbol: 'USDC', decimals: 6, amount: '2490000n' } } });
      case '/api/registerTxs':
        return json([{ success: true }]);
    }
    return json({}, 404);
  },
  rotateIsolation() {},
} as never);

const usdcArb = { ...builtin('usdcArb') };
const eth = builtin('eth');
const usdt = builtin('usdterc20');

test('Swaps.XYZ: amounts in base units (Cake\'s AmountConverter), selectors', () => {
  assert.equal(toUnits('1.5', 6), '1500000');
  assert.equal(toUnits('0.0000001', 18), '100000000000');
  assert.equal(toUnits('2', 0), '2');
  assert.throws(() => toUnits('1e-7', 18));
  assert.equal(fromUnits('2500000', 6), '2.5');
  assert.equal(fromUnits('5', 6), '0.000005');
  assert.equal(fromUnits('7', 0), '7');
  assert.equal(methodSelector('0x9be111d1abcdef'), '0x9be111d1');
  assert.equal(methodSelector('0x12'), '');
});

test('Swaps.XYZ: needs the key; chains and tokens from its paths; limits and a floating quote', async () => {
  resetSwapsXyzCache();
  settings.value = { ...settings.value, apiKeys: {} };
  assert.equal(await swapsXyz.fetchRate(eth, usdcArb, 1, false, false), 0);
  await assert.rejects(() => swapsXyz.fetchLimits(eth, usdcArb, false));
  settings.value = { ...settings.value, apiKeys: { swapsxyz: 'test-key' } };
  asked.length = 0;
  assert.deepEqual(await swapsXyz.fetchLimits(eth, usdcArb, false), { min: 0.001, max: 10 });
  const paths = asked.filter((a) => a.path === '/api/getPaths');
  assert.deepEqual(paths.at(-1)!.q, { srcChainId: '1', srcToken: ZERO_ADDRESS, dstChainId: '42161', dstToken: USDC_ARB });
  assert.ok(asked.every((a) => a.key === 'test-key'));
  // fixed: the route takes no exact output
  await assert.rejects(() => swapsXyz.fetchLimits(eth, usdcArb, true), /exact-amount-out/);
  assert.equal(await swapsXyz.fetchRate(eth, usdcArb, 0.5, false, false), 3012.5);
  assert.deepEqual(asked.at(-1)!.q, { swapDirection: 'exact-amount-in', srcToken: ZERO_ADDRESS, dstToken: USDC_ARB, srcChainId: '1', dstChainId: '42161', amount: '500000000000000000' });
  // an exact output where the route has none: no quote
  assert.equal(await swapsXyz.fetchRate(eth, usdcArb, 10, false, true), 0);
  // Solana and BNB Smart Chain are not quoted
  assert.equal(await swapsXyz.fetchRate(builtin('sol'), eth, 1, false, false), 0);
  assert.equal(await swapsXyz.fetchRate(builtin('bnb'), eth, 1, false, false), 0);
  assert.equal(swapsXyz.supportsFixedRate, false);
});

test('Swaps.XYZ: the trade from getAction (the router call kept), unsupported calls refused, the status, registration', async () => {
  settings.value = { ...settings.value, apiKeys: { swapsxyz: 'test-key' } };
  const request = { fromCurrency: usdt, toCurrency: usdcArb, toAddress: '0xrecipient', refundAddress: '0xsender', fromAmount: '2.5', toAmount: '2.49', toAddressExtraId: '', isFixedRate: false };
  action = { txId: 'tx-1', vmId: 'evm', tx: { to: ROUTER, data: '0x9be111d1' + '00'.repeat(64), value: '0', chainId: 1 }, amountIn: { address: USDT_ETH, decimals: 6, amount: '2500000n' }, requiresTokenApproval: true, bridgeIds: ['across'] };
  const t = await swapsXyz.createTrade(request, false, false);
  assert.deepEqual([t.id, t.inputAddress, t.router, t.providerId, t.sourceTokenAddress, t.sourceTokenAmountRaw, t.sourceTokenDecimals, t.requiresTokenApproval, t.needToRegisterInSwapXyz, t.routerValue, t.stateRaw], ['tx-1', ROUTER, '1', 'evm', USDT_ETH, '2500000', 6, true, false, '0', STATES.created.raw]);
  const q = asked.at(-1)!.q;
  assert.deepEqual([q.actionType, q.sender, q.recipient, q.srcToken, q.dstToken, q.amount, q.slippage, q.swapDirection], ['swap-action', '0xsender', '0xrecipient', USDT_ETH, USDC_ARB, '2500000', '300', 'exact-amount-in']);
  // an alt-VM route is registered after the broadcast
  action = { txId: 'tx-2', vmId: 'alt-vm', tx: { to: 'bc1qdeposit', chainId: 8253038 }, amountIn: {} };
  const alt = await swapsXyz.createTrade(request, false, false);
  assert.deepEqual([alt.needToRegisterInSwapXyz, alt.routerData, alt.inputAddress], [true, undefined, 'bc1qdeposit']);
  action = { txId: 'tx-3', tx: { to: ROUTER, data: '0x095ea7b3' + '00'.repeat(64) } };
  await assert.rejects(() => swapsXyz.createTrade(request, false, false), (e: unknown) => e instanceof TradeNotCreatedError && /method selector/.test((e as Error).message));
  const s = await swapsXyz.findTradeById('tx-1');
  assert.deepEqual([s.stateRaw, s.txId, s.receiveAmount, s.amount, s.createdAt, s.inputAddress], [STATES.finished.raw, '0xhash', '2.49', '2.5', 1_700_000_000_000, ROUTER]);
  assert.equal(await registerSwapsXyzTx({ txId: 'tx-2', txHash: '0xabc', chainId: 8253038, vmId: 'alt-vm' }), true);
  assert.deepEqual(JSON.parse(asked.at(-1)!.body!), { txId: 'tx-2', vmId: 'alt-vm', txHash: '0xabc', chainId: 8253038 });
  assert.equal(swapsXyz.trackUrl({ ...t }), 'https://scan.swaps.xyz/transactions/tx-1');
});

test('Swaps.XYZ deposit: the router call (transfer as it is; swapAndExecute after the approval, Tether reset first)', async () => {
  const { swapsXyzTransaction } = await import('../../src/exchange/send.ts');
  const { currency } = await import('../../src/coins/types.ts');
  const calls: string[] = [];
  let allowance = 5n;
  const balances: Record<string, { available: bigint }> = { eth: { available: 10n ** 18n }, [USDT_ETH]: { available: 10_000_000n } };
  const wallet = {
    type: 'ethereum',
    currency: currency('eth'),
    address: '0x2222222222222222222222222222222222222222',
    chainId: 1,
    tokens: [{ address: USDT_ETH, symbol: 'USDT', decimals: 6, enabled: true }],
    balances: { value: balances },
    defaultPriority: () => 'medium',
    async callContract() {
      return `0x${allowance.toString(16).padStart(64, '0')}`;
    },
    async createContractCall(to: string, data: Uint8Array, opts: { value?: bigint; fallbackGas?: bigint; amount?: bigint } = {}) {
      const sel = [...data.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('');
      const arg = sel === '095ea7b3' ? BigInt(`0x${[...data.slice(36, 68)].map((b) => b.toString(16).padStart(2, '0')).join('')}`) : undefined;
      calls.push(`${to === USDT_ETH ? 'usdt' : to === ROUTER ? 'router' : to}:${sel}${arg !== undefined ? `(${arg})` : ''}:value=${opts.value ?? 0n}:gas=${opts.fallbackGas ?? '-'}:amount=${opts.amount ?? '-'}`);
      return { id: `0x${calls.length}`, amount: opts.amount ?? 0n, fee: 1n, amountFormatted: '', feeFormatted: '', commit: async () => { if (arg !== undefined) allowance = arg; } };
    },
  };
  const base = { id: 't', providerRaw: 14, stateRaw: 'created', amount: '2.5', inputAddress: ROUTER, from: usdt, routerValue: '0' };
  const swap = { ...base, routerData: '0x9be111d1' + '00'.repeat(32), sourceTokenAddress: USDT_ETH, sourceTokenAmountRaw: '2500000', sourceTokenDecimals: 6 };
  await swapsXyzTransaction(wallet as never, swap);
  assert.deepEqual(calls, ['usdt:095ea7b3(0):value=0:gas=-:amount=-', 'usdt:095ea7b3(2500000):value=0:gas=-:amount=-', 'router:9be111d1:value=0:gas=300000:amount=2500000']);
  // enough allowance: straight to the call
  calls.length = 0;
  await swapsXyzTransaction(wallet as never, swap);
  assert.deepEqual(calls, ['router:9be111d1:value=0:gas=300000:amount=2500000']);
  // the coin: no approval, the call carries the value
  calls.length = 0;
  await swapsXyzTransaction(wallet as never, { ...swap, sourceTokenAddress: ZERO_ADDRESS, routerValue: '1000', from: eth });
  assert.deepEqual(calls, ['router:9be111d1:value=1000:gas=300000:amount=1000']);
  // a transfer call: no value
  calls.length = 0;
  await swapsXyzTransaction(wallet as never, { ...base, routerData: '0xa9059cbb' + '00'.repeat(64), inputAddress: USDT_ETH });
  assert.deepEqual(calls, ['usdt:a9059cbb:value=0:gas=300000:amount=-']);
  // not enough of the token; another call
  balances[USDT_ETH] = { available: 1n };
  await assert.rejects(() => swapsXyzTransaction(wallet as never, swap), /Insufficient USDT balance/);
  await assert.rejects(() => swapsXyzTransaction(wallet as never, { ...swap, routerData: '0x12345678' }), /Unsupported Swaps.xyz transaction type/);
});
