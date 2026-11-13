import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HDKey } from '@scure/bip32';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bip39Seed } from '../../src/coins/seeds/bip39.ts';
import { addressFromPrivateKey, decodeTrc20Transfer, encodeRawData, encodeTransaction, isValidTronAddress, refBlock, signPersonalMessage, signTransaction, toBase58, toEvmAddress, trc20Transfer, txId, verifyPersonalMessage, withFeeLimit, type RawDataJson } from '../../src/coins/tron/tron.ts';

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const fixtures: { txID: string; raw_data: RawDataJson; raw_data_hex: string }[] = JSON.parse(readFileSync(new URL('./fixtures/tron-txs.json', import.meta.url), 'utf8'));

test("Tron m/44'/195'/0'/0/0 of abandon…about (Cake's key)", async () => {
  const k = HDKey.fromMasterSeed(await bip39Seed(M)).derive("m/44'/195'/0'/0/0").privateKey!;
  assert.equal(bytesToHex(k), 'b5a4cea271ff424d7c31dc12a3e43e401df7a40d7412a15750f3f0b6b5449a28');
  assert.equal(addressFromPrivateKey(k), 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
});

test('addresses: base58check, hex, validation', () => {
  assert.ok(isValidTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'));
  assert.ok(!isValidTronAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6T'));
  assert.ok(!isValidTronAddress('0x9858EfFD232B4033E47d90003D41EC34EcaEda94'));
  assert.equal(toBase58('41a614f803b6fd780986a42c78ec9c7f77e6ded13c'), 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
  assert.equal(toEvmAddress('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'), '0xa614f803b6fd780986a42c78ec9c7f77e6ded13c');
});

test('raw data encodes exactly like the network (txID = SHA-256 of it)', () => {
  assert.ok(fixtures.some((f) => f.raw_data.contract[0].type === 'TransferContract'));
  assert.ok(fixtures.some((f) => f.raw_data.contract[0].type === 'TriggerSmartContract'));
  for (const f of fixtures) {
    const raw = encodeRawData(f.raw_data);
    assert.equal(bytesToHex(raw), f.raw_data_hex, f.raw_data.contract[0].type);
    assert.equal(txId(raw), f.txID);
  }
  // fee_limit is the last field: appending it equals encoding it
  const t = fixtures.find((f) => f.raw_data.fee_limit)!;
  const { fee_limit, ...rest } = t.raw_data;
  assert.equal(bytesToHex(withFeeLimit(encodeRawData(rest as RawDataJson), BigInt(fee_limit!))), t.raw_data_hex);
});

test('TRC-20 transfer calls encode and decode', () => {
  const data = trc20Transfer('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH', 1_500_000n);
  assert.equal(data.slice(0, 8), 'a9059cbb');
  assert.deepEqual(decodeTrc20Transfer(data), { to: 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH', amount: 1_500_000n });
  const real = fixtures.find((f) => f.raw_data.contract[0].type === 'TriggerSmartContract')!;
  const d = decodeTrc20Transfer(real.raw_data.contract[0].parameter.value.data);
  assert.ok(d && isValidTronAddress(d.to) && d.amount >= 0n);
  assert.equal(decodeTrc20Transfer('095ea7b3' + '0'.repeat(128)), null);
});

test('reference block, signatures, personal messages', () => {
  const blockID = '0000000003a6a1a2d33a6b8c1b0e2d7c1f2a3b4c5d6e7f80112233445566778899';
  const r = refBlock({ blockID, block_header: { raw_data: { number: 61251970, timestamp: 1794500000000 } } });
  assert.equal(r.ref_block_bytes, BigInt(61251970).toString(16).padStart(16, '0').slice(12));
  assert.equal(r.ref_block_hash, blockID.slice(16, 32));
  const priv = hexToBytes('b5a4cea271ff424d7c31dc12a3e43e401df7a40d7412a15750f3f0b6b5449a28');
  const raw = hexToBytes(fixtures[0].raw_data_hex);
  const sig = signTransaction(raw, priv);
  assert.equal(sig.length, 65);
  assert.ok(sig[64] === 27 || sig[64] === 28);
  assert.ok(secp256k1.verify(sig.subarray(0, 64), sha256(raw), secp256k1.getPublicKey(priv), { prehash: false }));
  const tx = encodeTransaction(raw, [sig]);
  assert.equal(tx[0], 0x0a);
  const s = signPersonalMessage('hello', priv);
  assert.equal(s.length, 130);
  assert.ok(verifyPersonalMessage('hello', s, 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'));
  assert.ok(!verifyPersonalMessage('hello!', s, 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH'));
});
