import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundToChain, detectAddress, evaluate, isAliasInput, rawInputOf, requestFromPaymentRequest, requestFromRaw, resolveTokenAmount, swapIntent, type Snapshot } from '../../src/app/anypay.ts';
import type { WalletInfo } from '../../src/core/wallet.ts';

const XMR = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
const BTC = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const ETH = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const USDT_ETH = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const USDT_POL = '0xc2132d05d31c914a87c6611c10748aeb04b58e8f';
const info = (id: string, type: WalletInfo['type']): WalletInfo => ({ id, name: id, type, isRecovery: false, restoreHeight: 0, date: 0, address: '' });
const wallets = [info('btc', 'bitcoin'), info('eth', 'ethereum'), info('pol', 'polygon'), info('xmr1', 'monero'), info('xmr2', 'monero')];
const snap = (type: WalletInfo['type'], currentChainId: number | null = null): Snapshot => ({ type, currentChainId, wallets });

test('AnyPay: addresses and URIs detected by scheme, then by form', () => {
  assert.deepEqual([detectAddress(BTC).walletType, detectAddress(BTC).currency], ['bitcoin', 'btc']);
  assert.equal(detectAddress(XMR).walletType, 'monero');
  assert.equal(detectAddress(ETH).walletType, 'ethereum');
  assert.equal(detectAddress('ltc1qg82tdxa6x7rp7mmvlw0ajkd3ffkvjwyrkx8x6s').walletType, 'litecoin');
  assert.equal(detectAddress('TLsV52sRDL79HXGGm9yzwKibb6BeruhUzy').walletType, 'tron');
  assert.equal(detectAddress('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk').walletType, 'solana');
  assert.equal(detectAddress(`monero:${XMR}?tx_amount=1`).walletType, 'monero');
  assert.equal(detectAddress(`bitcoin:${BTC}?amount=0.1`).currency, 'btc');
  const pol = detectAddress(`ethereum:${ETH}@137?value=1e18`);
  assert.deepEqual([pol.walletType, pol.chainId], ['polygon', 137]);
  // an unknown chain counts as Ethereum (and is then refused by the router)
  assert.equal(detectAddress(`ethereum:${ETH}@10`).walletType, 'ethereum');
  assert.equal(detectAddress('lnbc2500u1pvjluezpp5').walletType, 'bitcoin');
  assert.equal(detectAddress('not an address').isValid, false);
  assert.equal(detectAddress('').isValid, false);
});

test('AnyPay: requests keep the chain binding; a request rebuilt from its fields reads the same', () => {
  assert.deepEqual(requestFromRaw(`ethereum:${ETH}@8453`).binding, { kind: 'explicit', chainId: 8453 });
  assert.deepEqual(requestFromRaw(`ethereum:${ETH}`).binding, { kind: 'chainless' });
  assert.deepEqual(requestFromRaw(`polygon:${ETH}`).binding, { kind: 'explicit', chainId: 137 });
  assert.deepEqual(requestFromRaw(`bitcoin:${BTC}`).binding, { kind: 'none' });
  const r = requestFromRaw(`ethereum:${USDT_POL}@137/transfer?address=${ETH}&uint256=2500000`);
  assert.deepEqual([r.pr.contract, r.pr.address, r.pr.rawTokenAmount, r.pr.chainId], [USDT_POL, ETH, '2500000', 137]);
  const again = requestFromPaymentRequest(r.pr);
  assert.equal(again.rawInput, rawInputOf(r.pr));
  assert.deepEqual([again.pr.contract, again.pr.address, again.detection.walletType], [USDT_POL, ETH, 'polygon']);
  assert.equal(rawInputOf({ address: BTC, amount: '0.1', note: '', scheme: 'bitcoin' }), `bitcoin:${BTC}?amount=0.1`);
  assert.equal(rawInputOf({ address: ETH, amount: '', note: '', scheme: '' }), ETH);
  assert.ok(isAliasInput(requestFromRaw('alice@example.com')));
  assert.ok(!isAliasInput(requestFromRaw(`ethereum:${ETH}@1`)));
});

test('AnyPay: token amounts in the token\'s decimals (old 18-decimal QRs too)', () => {
  const pr = (o: object) => ({ address: ETH, amount: '', note: '', scheme: 'ethereum', ...o });
  assert.equal(resolveTokenAmount(pr({ amount: '5' }), 6), '5');
  assert.equal(resolveTokenAmount(pr({ rawTokenAmount: '2500000' }), 6), '2.5');
  assert.equal(resolveTokenAmount(pr({ rawTokenAmount: '2500000000000000000' }), 6), '2.5');
  assert.equal(resolveTokenAmount(pr({ rawTokenAmount: '1000000' }), 6), '1');
  assert.equal(resolveTokenAmount(pr({}), 6), undefined);
});

test('AnyPay: decisions — this wallet, another network\'s wallets, an EVM network to pick, unsupported', () => {
  // a Bitcoin address in a Bitcoin wallet
  assert.equal(evaluate(requestFromRaw(BTC), snap('bitcoin')).kind, 'current');
  // a Monero address in a Bitcoin wallet: the two Monero wallets, swappable
  const xmr = evaluate(requestFromRaw(XMR), snap('bitcoin'));
  assert.equal(xmr.kind, 'crossChain');
  if (xmr.kind === 'crossChain') assert.deepEqual([xmr.targetWalletType, xmr.wallets.map((w) => w.id), xmr.canSwap], ['monero', ['xmr1', 'xmr2'], true]);
  // a silent payment address cannot be a swap's destination
  const sp = evaluate(requestFromRaw(`sp1${'q'.repeat(113)}`), snap('litecoin'));
  assert.ok(sp.kind === 'crossChain' && !sp.canSwap && sp.targetWalletType === 'bitcoin');
  // a bare 0x address: the current EVM wallet takes it; elsewhere a network is picked
  assert.equal(evaluate(requestFromRaw(ETH), snap('polygon', 137)).kind, 'current');
  assert.equal(evaluate(requestFromRaw(ETH), snap('bitcoin')).kind, 'evmChoice');
  // a chain: the same → this wallet; another → its wallets
  assert.equal(evaluate(requestFromRaw(`ethereum:${ETH}@137`), snap('polygon', 137)).kind, 'current');
  const base = evaluate(requestFromRaw(`ethereum:${ETH}@8453`), snap('ethereum', 1));
  assert.ok(base.kind === 'crossChain' && base.targetWalletType === 'base' && base.targetChainId === 8453 && base.wallets.length === 0);
  assert.deepEqual(evaluate(requestFromRaw(`ethereum:${ETH}@10`), snap('ethereum', 1)), { kind: 'unsupportedNetwork', chainId: 10 });
  // the native coin with an amount in a URI: the currency to select
  const eth = evaluate(requestFromRaw(`ethereum:${ETH}@1?value=1e17`), snap('ethereum', 1));
  assert.deepEqual(eth, { kind: 'current', fallbackCurrency: 'eth' });
  assert.equal(evaluate(requestFromRaw('   '), snap('bitcoin')).kind, 'empty');
  // an EVM network picked for a bare address
  assert.equal(evaluate(boundToChain(requestFromRaw(ETH), 137), snap('bitcoin')).kind, 'crossChain');
});

test('AnyPay: tokens — the chain\'s list, a chainless contract found on another chain, unknown ones refused', () => {
  const usdt = evaluate(requestFromRaw(`ethereum:${USDT_ETH}@1/transfer?address=${ETH}&uint256=1000000`), snap('ethereum', 1));
  assert.ok(usdt.kind === 'current' && usdt.token?.symbol === 'USDT' && usdt.amountOverride === '1');
  // no chain id, a Polygon contract: Polygon's wallets
  const pol = evaluate(requestFromRaw(`ethereum:${USDT_POL}/transfer?address=${ETH}&amount=3`), snap('ethereum', 1));
  assert.ok(pol.kind === 'crossChain' && pol.targetChainId === 137 && pol.token?.walletType === 'polygon' && pol.amountOverride === '3');
  const unknown = evaluate(requestFromRaw(`ethereum:0x${'1'.repeat(40)}@1/transfer?address=${ETH}`), snap('ethereum', 1));
  assert.equal(unknown.kind, 'unsupportedToken');
  // a wallet's own token list comes first
  const mine = evaluate(requestFromRaw(`ethereum:0x${'2'.repeat(40)}@1/transfer?address=${ETH}`), snap('ethereum', 1), (type, a) => (a === `0x${'2'.repeat(40)}` ? { walletType: type, address: a, symbol: 'MINE', name: 'Mine', decimals: 2 } : null));
  assert.ok(mine.kind === 'current' && mine.token?.symbol === 'MINE');
});

test('AnyPay: swap intents deliver the network\'s coin or the token, with the amount', () => {
  const r = requestFromRaw(`monero:${XMR}?tx_amount=0.25`);
  assert.deepEqual(swapIntent(r, 'monero'), { recipientAddress: XMR, targetWalletType: 'monero', receiveCurrency: 'xmr', token: undefined, receiveAmount: '0.25' });
  const t = requestFromRaw(`ethereum:${USDT_POL}@137/transfer?address=${ETH}&uint256=2500000`);
  const d = evaluate(t, snap('bitcoin'));
  assert.ok(d.kind === 'crossChain');
  if (d.kind === 'crossChain') {
    const i = swapIntent(t, d.targetWalletType, d.targetChainId, d.token);
    assert.deepEqual([i.receiveCurrency, i.token?.symbol, i.receiveAmount, i.recipientAddress], ['maticpoly', 'USDT', '2.5', ETH]);
  }
});
