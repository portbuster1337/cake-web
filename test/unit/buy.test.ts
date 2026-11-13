import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64 } from '@scure/base';
import { arrangeQuotes } from '../../src/buy/quotes.ts';
import { cutDigits, formatWithCommas, groupThousands } from '../../src/buy/format.ts';
import { pairCurrency } from '../../src/buy/pairs.ts';
import { paymentTypeId, samePaymentMethod, recommendationOf, type BuyProvider, type Quote } from '../../src/buy/types.ts';
import { moonpaySignature, onramperSignatureV2, onramperSigningSeed } from '../../src/buy/signing.ts';

const provider = (title: string, isAggregator = false) => ({ title, isAggregator } as unknown as BuyProvider);
const q = (p: BuyProvider, rate: number, payout: number, recommendations: Quote['recommendations'] = []): Quote => ({ rate, payout, provider: p, recommendations: [...recommendations], feeAmount: 0, networkFee: 0, transactionFee: 0, paymentType: 'all', isBuyAction: true, fiat: 'EUR', crypto: { title: 'BTC' } as any });

test('quotes: one per provider recommended by payout, Onramper first, the cheapest rate badged, the first selected', () => {
  const dfx = provider('DFX.swiss');
  const on = provider('Onramper', true);
  const mp = provider('MoonPay');
  const a = q(dfx, 60000, 0, ['lowKyc']);
  const b = q(on, 61000, 0.0019);
  const c = q(on, 60500, 0.0018, ['successRate']);
  const d = q(on, 62000, 0.0017);
  const e = q(mp, 59000, 0.00185);
  const r = arrangeQuotes([a, b, c, d, e], true);
  // by payout: b, e, c, d, a — the first of each provider: b, e, a; then Onramper's success-rate c
  assert.deepEqual(r.recommended, [b, c, e, a]);
  assert.deepEqual(r.others, [d]);
  assert.equal(r.best, b);
  assert.equal(r.selected, b);
  // buying: the lowest rate among the recommended is the best rate
  assert.deepEqual(e.recommendations, ['bestRate']);
  assert.deepEqual(a.recommendations, ['lowKyc']);
  // selling: least payout first, the highest rate badged
  const s1 = q(dfx, 1 / 60000, 0, ['lowKyc']);
  const s2 = q(mp, 1 / 59000, 5);
  const rs = arrangeQuotes([s2, s1], false);
  assert.deepEqual(rs.recommended, [s1, s2]);
  assert.deepEqual(s2.recommendations, ['bestRate']);
  assert.deepEqual(arrangeQuotes([], true), { recommended: [], others: [], best: null, selected: null });
});

test('payment methods and recommendations: provider ids, one per type (unknown ones by title)', () => {
  assert.equal(paymentTypeId('credit_debit_card'), 'creditCard');
  assert.equal(paymentTypeId('Bank'), 'bankTransfer');
  assert.equal(paymentTypeId('sepa_instant'), 'sepaInstant');
  assert.equal(paymentTypeId('PIX'), 'pixPay');
  assert.equal(paymentTypeId('mystery'), null);
  assert.ok(samePaymentMethod({ type: 'sepa', customTitle: 'A', customIconPath: '' }, { type: 'sepa', customTitle: 'B', customIconPath: '' }));
  assert.ok(!samePaymentMethod({ type: 'unknown', customTitle: 'A', customIconPath: '' }, { type: 'unknown', customTitle: 'B', customIconPath: '' }));
  assert.equal(recommendationOf('BEST RATE'), 'bestRate');
  assert.equal(recommendationOf('LowKyc'), 'lowKyc');
  assert.equal(recommendationOf('best rate'), null);
});

test('pairs: matched by title and tag against the built-in currencies', () => {
  assert.equal(pairCurrency({ title: 'USDT', tag: 'ETH' })?.key, 'usdterc20');
  assert.equal(pairCurrency({ title: 'POL', tag: 'POL' })?.key, 'maticpoly');
  assert.equal(pairCurrency({ title: 'XMR', tag: null })?.key, 'xmr');
  assert.equal(pairCurrency({ title: 'NOPE', tag: 'ETH' }), undefined);
});

test('formatting: grouping, formatWithCommas, MoneyText digits', () => {
  assert.equal(groupThousands('1000'), '1,000');
  assert.equal(groupThousands('2500000'), '2,500,000');
  assert.equal(groupThousands('1234.5678'), '1,234.5678');
  assert.equal(formatWithCommas('62398.60'), '62,398.60');
  assert.equal(formatWithCommas('482.3'), '482.30');
  assert.equal(formatWithCommas(''), '');
  assert.equal(cutDigits('0.207331232376', 8), '0.20733123');
  assert.equal(cutDigits('1.10000000009', 8), '1.1');
  assert.equal(cutDigits('5', 8), '5');
});

test('Onramper Signature V2: the canonical string, signed with Ed25519', () => {
  const seed = new Uint8Array(32).fill(3);
  const fields = { networkWallets: 'btc:bc1qexample', apiKey: 'pk_test_x' };
  const now = new Date(Date.UTC(2024, 0, 15, 10, 0, 0));
  const nonce = '550e8400-e29b-41d4-a716-446655440000';
  const s = onramperSignatureV2(fields, seed, now, nonce);
  assert.equal(s.sigV2Timestamp, '2024-01-15T10:00:00.000Z');
  assert.equal(s.sigV2Nonce, nonce);
  assert.equal(s.sigV2Fields, 'apiKey,networkWallets');
  assert.ok(s.sigV2.startsWith('v2:'));
  const canonical = ['ONRAMPER-SIG-V2', '2024-01-15T10:00:00.000Z', nonce, 'GET', '/', 'apiKey=pk_test_x&networkWallets=btc%3Abc1qexample', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'].join('\n');
  assert.ok(ed25519.verify(base64.decode(s.sigV2.slice(3)), new TextEncoder().encode(canonical), ed25519.getPublicKey(seed)));
});

test('Onramper signing keys: 32-byte hex or an Ed25519 PKCS#8 PEM', () => {
  const seed = new Uint8Array(32).fill(9);
  const der = new Uint8Array([...Buffer.from('302e020100300506032b657004220420', 'hex'), ...seed]);
  const pem = `-----BEGIN PRIVATE KEY-----\n${base64.encode(der)}\n-----END PRIVATE KEY-----`;
  assert.deepEqual(onramperSigningSeed(pem), seed);
  assert.deepEqual(onramperSigningSeed(Buffer.from(seed).toString('hex')), seed);
  assert.throws(() => onramperSigningSeed(base64.encode(new Uint8Array(48).fill(255))));
});

test('MoonPay URL signature: base64 HMAC-SHA256 of the query with its "?"', () => {
  const sig = moonpaySignature('?apiKey=pk_test_123&currencyCode=eth', 'sk_test_key');
  assert.equal(sig, base64.encode(hmac(sha256, new TextEncoder().encode('sk_test_key'), new TextEncoder().encode('?apiKey=pk_test_123&currencyCode=eth'))));
  assert.equal(moonpaySignature('apiKey=pk_test_123&currencyCode=eth', 'sk_test_key'), sig);
});

test('Bitcoin message signatures: the Signed Message hash and the recovery of the compressed key', () => {
  // the hash Cake signs (sha256 of the prefixed message, hashed again)
  const h = sha256(sha256(new Uint8Array([24, ...new TextEncoder().encode('Bitcoin Signed Message:\n'), 5, ...new TextEncoder().encode('hello')])));
  const priv = new Uint8Array(32).fill(5);
  const sig = secp256k1.sign(h, priv, { prehash: false, format: 'recovered' });
  // Cake: header = 27 + recovery + 4 (compressed), for every address type
  const header = 27 + sig[0] + 4;
  assert.ok(header >= 31 && header <= 34);
  const pub = secp256k1.recoverPublicKey(Uint8Array.from([header - 31, ...sig.slice(1)]), h, { prehash: false });
  assert.deepEqual(pub, secp256k1.getPublicKey(priv, true));
});
