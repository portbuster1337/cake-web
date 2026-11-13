import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { deserializeState, formatTradeAmount, mergeTrade, STATES, type Trade } from '../../src/exchange/types.ts';
import { builtin, eqCurrency, fromToken, memoLabelType, parseSwapCurrency, swapCurrencies, titleTagEqual, walletTypeOf, chainIconOf } from '../../src/exchange/currency.ts';
import { amountOf, dartDouble, doubleToMoney, toBaseUnits, toMoney, withMaxDecimals } from '../../src/exchange/amounts.ts';
import { paymentUri } from '../../src/exchange/uri.ts';
import { compileMessage, publicKeyOf, shortvec, signSerializedTransaction, systemTransfer } from '../../src/coins/solana/sol.ts';

test('TradeState.deserialize: the switch, its aliases, and raw titles for the rest', () => {
  assert.equal(deserializeState('finished').title, 'Finished');
  assert.equal(deserializeState('inProgress'), STATES.processing);
  assert.equal(deserializeState('error'), STATES.failed);
  assert.equal(deserializeState('verifying'), STATES.confirmation);
  assert.equal(deserializeState('sending_confirmation'), STATES.sending);
  assert.equal(deserializeState('done'), STATES.success);
  assert.equal(deserializeState('NOT_FOUND').title, 'Not found');
  // not in the switch: the raw is the title
  assert.deepEqual(deserializeState('settled'), { raw: 'settled', title: 'settled' });
  assert.deepEqual(deserializeState('new'), { raw: 'new', title: 'new' });
});

test('Trade.mergeFindTradeByIdResult copies only the status fields', () => {
  const t: Trade = { id: 'a', providerRaw: 9, stateRaw: 'created', amount: '1', createdAt: 5, from: builtin('btc'), to: builtin('xmr') };
  const m = mergeTrade(t, { stateRaw: 'finished', amount: '2', createdAt: 9, from: builtin('eth'), receiveAmount: '3', outputTransaction: 'tx', id: 'b' });
  assert.equal(m.stateRaw, 'finished');
  assert.equal(m.amount, '1');
  assert.equal(m.createdAt, 5);
  assert.equal(m.from?.id, 'btc');
  assert.equal(m.id, 'a');
  assert.equal(m.receiveAmount, '3');
  assert.equal(m.outputTransaction, 'tx');
  assert.equal(mergeTrade({ ...t, createdAt: undefined }, { createdAt: 9 }).createdAt, 9);
  assert.equal(mergeTrade(t, { stateRaw: '' }).stateRaw, 'created');
});

test('formatAmount', () => {
  assert.equal(formatTradeAmount('1'), '1.00');
  assert.equal(formatTradeAmount('1.'), '1.00');
  assert.equal(formatTradeAmount('1.5'), '1.5');
});

test('swap currency lists: CryptoCurrency.all without BTT, then the tokens Cake does not already list', () => {
  const list = swapCurrencies();
  assert.equal(list[0].id, 'xmr');
  assert.ok(!list.some((c) => c.id === 'btt'));
  const tokens = list.filter((c) => c.address);
  const has = (tag: string, symbol: string) => tokens.some((c) => c.tag === tag && c.title === symbol);
  // built-ins with the same title and tag win: USDT/USDC on Ethereum, USDC.e on Polygon, USDe on Base
  assert.ok(!has('ETH', 'USDT') && !has('ETH', 'USDC') && !has('POL', 'USDC.E') && !has('BASE', 'USDE'));
  // QUIRK (_listContainsToken): a token named like a tag-less built-in is left out (Tron's BTC/ETH/DOGE tokens)
  assert.ok(!has('TRX', 'ETH') && !has('TRX', 'DOGE') && !has('SOL', 'BTC'));
  // tokens without a built-in are added once
  assert.ok(has('ARB', 'LINK'));
  assert.equal(tokens.filter((c) => c.tag === 'ARB' && c.title === 'LINK').length, 1);
  // the user's enabled tokens of every wallet
  const extra = swapCurrencies({ evm: [{ type: 'base', tokens: [{ address: '0x1234567890abcdef1234567890abcdef12345678', name: 'Test', symbol: 'tst', decimals: 9, enabled: true }] }], sol: [], trx: [] });
  assert.ok(extra.some((c) => c.title === 'TST' && c.tag === 'BASE' && c.decimals === 9));
  const off = swapCurrencies({ evm: [{ type: 'base', tokens: [{ address: '0x1234567890abcdef1234567890abcdef12345678', name: 'Test', symbol: 'tst', decimals: 9, enabled: false }] }], sol: [], trx: [] });
  assert.ok(!off.some((c) => c.title === 'TST'));
});

test('currency identity, wallet types, memos, chain badges', () => {
  const usdc = fromToken({ symbol: 'USDC', name: 'USD Coin', address: '0xAF88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 }, 'ARB');
  assert.ok(eqCurrency(usdc, { ...usdc, address: usdc.address!.toLowerCase() }));
  assert.ok(!eqCurrency(usdc, builtin('usdcArb')));
  assert.ok(titleTagEqual(usdc, builtin('usdcArb')));
  assert.equal(walletTypeOf(usdc), 'arbitrum');
  assert.equal(walletTypeOf(builtin('usdterc20')), 'ethereum');
  assert.equal(walletTypeOf(builtin('usdtbsc')), 'bsc');
  assert.equal(walletTypeOf(builtin('btcln')), 'bitcoin');
  assert.equal(walletTypeOf(builtin('xrp')), undefined);
  assert.equal(memoLabelType(builtin('xrp')), 'destinationTag');
  assert.equal(memoLabelType(builtin('xlm')), 'memo');
  assert.equal(memoLabelType(builtin('btc')), null);
  assert.equal(chainIconOf(builtin('usdterc20')), 'assets/new-ui/chain_badges/ethereum.svg');
  assert.equal(parseSwapCurrency('USDT', 'TRX')?.id, 'usdttrc20');
  assert.equal(parseSwapCurrency('ZANO')?.id, 'zano');
  assert.equal(parseSwapCurrency('BTC', 'lightning')?.id, 'btcln');
});

test('amounts: Money.tryParse, double.tryToMoney, withMaxDecimals, Dart double strings, base units', () => {
  const btc = { decimals: 8 };
  assert.equal(toMoney('0.0100', btc), '0.01');
  assert.equal(toMoney('1,5', btc), '1.5');
  assert.equal(toMoney('10.0', btc), '10');
  assert.equal(toMoney('.5', btc), '0.5');
  assert.equal(toMoney('0.000000001', btc), null);
  assert.equal(toMoney('abc', btc), null);
  assert.equal(doubleToMoney(0.1 * 3, btc), '0.3');
  assert.equal(doubleToMoney(1 / 3, { decimals: 30 }), '0.33333333333333331483');
  assert.equal(doubleToMoney(Infinity, btc), null);
  assert.equal(withMaxDecimals('1.23456789', 4), '1.2345');
  assert.equal(withMaxDecimals('5', 4), '5');
  assert.equal(dartDouble(1), '1.0');
  assert.equal(dartDouble(0.05), '0.05');
  assert.equal(dartDouble(1e-7), '1e-7');
  assert.equal(toBaseUnits('1.5', 8), '150000000');
  assert.equal(toBaseUnits('1.0', 6), '1000000');
  assert.throws(() => toBaseUnits('1e-7', 8));
  assert.equal(amountOf('0.123456789', 8), 12345678n);
});

test('paymentUri: schemes by the deposit currency, ERC-681 for EVM, tokens by their contract', () => {
  const t = (from: string, amount = '0.5'): Trade => ({ id: 'x', providerRaw: 9, stateRaw: 'created', amount, from: builtin(from), inputAddress: 'ADDR' });
  assert.equal(paymentUri(t('btc')), 'bitcoin:ADDR?amount=0.5');
  assert.equal(paymentUri(t('xmr')), 'monero:ADDR?tx_amount=0.5');
  assert.equal(paymentUri(t('bch')), 'ADDR?amount=0.5');
  assert.equal(paymentUri(t('doge')), 'doge:ADDR?amount=0.5');
  assert.equal(paymentUri(t('nano')), 'nano:ADDR?amount=0.5');
  assert.equal(paymentUri(t('xrp')), 'ADDR');
  assert.equal(paymentUri(t('eth')), 'ethereum:ADDR@1?value=0.5e18');
  assert.equal(paymentUri(t('eth', '2')), 'ethereum:ADDR@1?value=2.0e18');
  assert.equal(paymentUri(t('usdterc20')), 'ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7@1/transfer?address=ADDR&amount=0.5');
  assert.equal(paymentUri(t('dai')), 'ethereum:0x6b175474e89094c44da98b954eedeac495271d0f@1/transfer?address=ADDR&uint256=500000000000000000&amount=0.5');
  assert.equal(paymentUri(t('sol')), 'solana:ADDR?amount=0.5');
  assert.equal(paymentUri(t('usdcsol')), 'solana:ADDR?amount=0.5&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.equal(paymentUri(t('usdttrc20')), 'tron:ADDR?amount=0.5&token=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
  assert.equal(paymentUri(t('trx')), 'tron:ADDR?amount=0.5');
  assert.equal(paymentUri({ ...t('btc'), inputAddress: undefined }), null);
});

test('Solana: a provider-built transaction gets our signature in our signer slot (v0 and legacy)', () => {
  const seed = new Uint8Array(32).fill(7);
  const me = publicKeyOf(seed);
  const other = publicKeyOf(new Uint8Array(32).fill(9));
  for (const version of [0, 'legacy'] as const) {
    const { bytes } = compileMessage([systemTransfer(me, other, 1000n)], me, '11111111111111111111111111111111', version);
    const unsigned = new Uint8Array([...shortvec(1), ...new Uint8Array(64), ...bytes]);
    const { tx, signature } = signSerializedTransaction(unsigned, seed);
    const sig = tx.subarray(1, 65);
    assert.ok(ed25519.verify(sig, bytes, base58.decode(me)));
    assert.equal(signature, base58.encode(sig));
    assert.deepEqual(tx.subarray(65), bytes);
  }
  const { bytes } = compileMessage([systemTransfer(other, me, 1n)], other, '11111111111111111111111111111111', 0);
  assert.throws(() => signSerializedTransaction(new Uint8Array([...shortvec(1), ...new Uint8Array(64), ...bytes]), seed), /not for this wallet/);
});

test('CSV export: Cake columns, trade rows, formula neutralizing, quoting', async () => {
  const { buildCsv, csvField, CSV_COLUMNS, csvFileName } = await import('../../src/app/csv.ts');
  assert.equal(CSV_COLUMNS.length, 17);
  assert.equal(csvField('=SUM(A1)'), "'=SUM(A1)");
  assert.equal(csvField('-5'), '-5');
  assert.equal(csvField('-x'), "'-x");
  assert.equal(csvField('a,b'), '"a,b"');
  assert.equal(csvField('say "hi"'), '"say ""hi"""');
  const w = { currency: { decimals: 8 } } as any;
  const out = buildCsv(w, [
    { kind: 'tx', tx: { id: 'tx1', currency: 'btc', direction: 'outgoing', amount: 150000000n, fee: 1000n, date: Date.UTC(2026, 0, 2, 3, 4, 5), confirmations: 3, isPending: false, to: 'bc1qdest' }, amount: '1.5', symbol: 'BTC', note: 'rent' },
    { kind: 'trade', trade: { id: 'T1', providerRaw: 9, stateRaw: 'finished', amount: '1', receiveAmount: '127.5', from: builtin('btc'), to: builtin('xmr'), createdAt: Date.UTC(2026, 0, 1), payoutAddress: '4abc' } },
  ]);
  const lines = out.split('\n');
  assert.equal(lines[0], `\uFEFF${CSV_COLUMNS.join(',')}`);
  assert.equal(lines[1], 'transaction,2026-01-02T03:04:05.000Z,outgoing,1.5,BTC,0.00001,tx1,bc1qdest,confirmed,rent,,,,,,,3');
  assert.equal(lines[2], 'trade,2026-01-01T00:00:00.000Z,swap,,,,,4abc,Finished,,1,btc,127.5,xmr,T1,SwapTrade,');
  assert.match(csvFileName(new Date(2026, 10, 13, 9, 5, 7)), /^cake_wallet_export_20261113_090507\.csv$/);
});
