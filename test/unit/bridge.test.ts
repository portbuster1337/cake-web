import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex } from '@noble/hashes/utils.js';
import { encodeAbi, selectorOf } from '../../src/coins/evm/eth.ts';
import { addressToBytes32, decodeMessagingFee, encodeOftSend, encodeQuoteSend, isUsdt0Token, usdt0DestinationChains, USDT0_EID } from '../../src/integrations/usdt0.ts';
import { bridgeStatusLabel, isActive, lzDelivered, lzFailed, lzMessage, type BridgeTransfer } from '../../src/integrations/bridge.ts';

const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, '0');
const words = (hex: string) => hex.match(/.{64}/g) ?? [];

test('ABI: static values inline, dynamic bytes and tuples by offset', () => {
  // f(uint256, bytes) with bytes 0x1234: head [1, 0x40], tail [len 2, data padded]
  const e = bytesToHex(encodeAbi([{ uint: 1n }, { bytes: Uint8Array.of(0x12, 0x34) }]));
  assert.deepEqual(words(e), [word(1), word(0x40), word(2), `1234${'0'.repeat(60)}`]);
  // a static tuple is inline; a tuple with bytes is dynamic
  assert.equal(bytesToHex(encodeAbi([{ tuple: [{ uint: 5n }, { bool: true }] }])), word(5) + word(1));
  const d = words(bytesToHex(encodeAbi([{ tuple: [{ uint: 7n }, { bytes: new Uint8Array() }] }, { address: '0x1111111111111111111111111111111111111111' }])));
  assert.deepEqual(d, [word(0x40), `${'0'.repeat(24)}${'11'.repeat(20)}`, word(7), word(0x40), word(0)]);
});

test('USDT0: the OFT selectors, quoteSend and send call data', () => {
  assert.equal(selectorOf('quoteSend((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),bool)'), '3b6f743b');
  assert.equal(selectorOf('send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address)'), 'c7c7f5b3');
  const to = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
  assert.equal(addressToBytes32(to), `0x${'0'.repeat(24)}9858effd232b4033e47d90003d41ec34ecaeda94`);
  const q = bytesToHex(encodeQuoteSend(30110, to, 5_000_000n));
  assert.equal(q.slice(0, 8), '3b6f743b');
  // head: the SendParam offset and payInLzToken; the SendParam: 4 words, 3 offsets, 3 empty bytes
  assert.deepEqual(words(q.slice(8)), [word(0x40), word(0), word(30110), addressToBytes32(to).slice(2), word(5_000_000n), word(0), word(0xe0), word(0x100), word(0x120), word(0), word(0), word(0)]);
  const s = bytesToHex(encodeOftSend(30101, to, 5_000_000n, 0n, { nativeFee: 123n, lzTokenFee: 0n }, to));
  assert.equal(s.slice(0, 8), 'c7c7f5b3');
  const sw = words(s.slice(8));
  // the SendParam after the 4 head words (its offset, the fee inline, the refund address)
  assert.deepEqual(sw.slice(0, 4), [word(0x80), word(123), word(0), addressToBytes32(to).slice(2)]);
  assert.equal(sw[4], word(30101));
  assert.deepEqual(decodeMessagingFee(`0x${word(42)}${word(7)}`), { nativeFee: 42n, lzTokenFee: 7n });
});

test('USDT0 chains and tokens', () => {
  assert.ok(isUsdt0Token(1, '0xDAC17F958D2EE523A2206206994597C13D831EC7'));
  assert.ok(isUsdt0Token(42161, '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'));
  assert.ok(!isUsdt0Token(8453, '0xdac17f958d2ee523a2206206994597c13d831ec7'));
  assert.ok(!isUsdt0Token(1, undefined));
  assert.deepEqual(usdt0DestinationChains(1), [137, 42161]);
  assert.deepEqual(usdt0DestinationChains(42161), [1, 137]);
  assert.deepEqual(usdt0DestinationChains(8453), [1, 137, 42161]);
  assert.equal(USDT0_EID[137], 30109);
});

test('bridge transfers: statuses, LayerZero Scan answers', () => {
  const t = (status: string) => ({ status }) as BridgeTransfer;
  assert.ok(isActive(t('submitted')) && isActive(t('initiated')) && !isActive(t('completed')) && !isActive(t('failed')));
  assert.equal(bridgeStatusLabel('initiated'), 'Bridge initiated');
  assert.equal(bridgeStatusLabel('weird'), 'weird');
  const m = { status: { name: 'DELIVERED' } };
  assert.equal(lzMessage({ data: [m] }), m);
  assert.equal(lzMessage([m]), m);
  assert.equal(lzMessage({ data: [] }), null);
  assert.ok(lzDelivered(m));
  assert.ok(lzDelivered({ destination: { status: 'SUCCEEDED' } }));
  assert.ok(lzFailed({ destination: { status: 'FAILED' } }));
  assert.ok(!lzDelivered({ status: { name: 'INFLIGHT' } }) && !lzFailed({ status: { name: 'INFLIGHT' } }));
});
