import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58 } from '@scure/base';
import { slip10Ed25519 } from '../../src/coins/seeds/slip10.ts';
import { bip39Seed } from '../../src/coins/seeds/bip39.ts';
import { associatedTokenAddress, compileMessage, decodeAddress, findProgramAddress, isOnCurve, isValidSolAddress, publicKeyOf, shortvec, signMessage, signText, systemTransfer, verifyText, SYSTEM_PROGRAM, TOKEN_PROGRAM } from '../../src/coins/solana/sol.ts';

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('SLIP-0010 ed25519 test vector 1', () => {
  const seed = hexToBytes('000102030405060708090a0b0c0d0e0f');
  const m = slip10Ed25519(seed, 'm');
  assert.equal(bytesToHex(m.key), '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7');
  assert.equal(bytesToHex(m.chainCode), '90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb');
  assert.equal(bytesToHex(ed25519.getPublicKey(m.key)), 'a4b2856bfec510abab89753fac1ac0e1112364e7d250545963f135f2a33188ed');
  const c = slip10Ed25519(seed, "m/0'");
  assert.equal(bytesToHex(c.key), '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3');
  assert.equal(bytesToHex(c.chainCode), '8b59aa11380b624e81507a27fedda59fea6d0b779a778918a2fd3590e16e9c69');
  assert.throws(() => slip10Ed25519(seed, 'm/0'));
});

test("Solana m/44'/501'/0'/0' of abandon…about (Cake's key)", async () => {
  const { key } = slip10Ed25519(await bip39Seed(M), "m/44'/501'/0'/0'");
  assert.equal(bytesToHex(key), '37df573b3ac4ad5b522e064e25b63ea16bcbe79d449e81a0268d1047948bb445');
  assert.equal(publicKeyOf(key), 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
  // base58 64-byte keypair import (seed || public key)
  assert.equal(base58.encode(new Uint8Array([...key, ...ed25519.getPublicKey(key)])), '27npWoNE4HfmLeQo1TyWcW7NEA28qnsnDK7kcttDQEWrCWnro83HMJ97rMmpvYYZRwDAvG4KRuB7hTBacvwD7bgi');
});

test('addresses, PDAs and associated token accounts', () => {
  assert.ok(isValidSolAddress('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk'));
  assert.ok(!isValidSolAddress('0x9858EfFD232B4033E47d90003D41EC34EcaEda94'));
  assert.ok(isOnCurve(decodeAddress('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk')));
  const ata = associatedTokenAddress('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.ok(isValidSolAddress(ata));
  assert.ok(!isOnCurve(decodeAddress(ata)));
  // a PDA is found at the first bump (from 255 down) that lands off the curve
  const pda = findProgramAddress([new TextEncoder().encode('x')], TOKEN_PROGRAM);
  assert.ok(pda.bump <= 255 && !isOnCurve(decodeAddress(pda.address)));
});

test('legacy and v0 messages, signatures', () => {
  assert.deepEqual([...shortvec(0)], [0]);
  assert.deepEqual([...shortvec(127)], [0x7f]);
  assert.deepEqual([...shortvec(128)], [0x80, 0x01]);
  assert.deepEqual([...shortvec(16384)], [0x80, 0x80, 0x01]);
  const seed = hexToBytes('37df573b3ac4ad5b522e064e25b63ea16bcbe79d449e81a0268d1047948bb445');
  const from = publicKeyOf(seed);
  const to = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
  const bh = 'EETubP5AKHgjPAhzPAFcb8BAY1hMH639CWCFTqi3hq1k';
  const { bytes, keys } = compileMessage([systemTransfer(from, to, 1_000_000n)], from, bh);
  assert.deepEqual(keys, [from, to, SYSTEM_PROGRAM]);
  assert.deepEqual([...bytes.subarray(0, 4)], [1, 0, 1, 3]);
  // instruction: program index 2, accounts [0, 1], data = u32 2 + u64 lamports
  const ix = bytes.subarray(4 + 3 * 32 + 32);
  assert.deepEqual([...ix.subarray(0, 6)], [1, 2, 2, 0, 1, 12]);
  assert.equal(Buffer.from(ix.subarray(6)).toString('hex'), '0200000040420f0000000000');
  const v0 = compileMessage([systemTransfer(from, to, 1_000_000n)], from, bh, 0);
  assert.equal(v0.bytes[0], 0x80);
  assert.equal(v0.bytes[v0.bytes.length - 1], 0);
  assert.deepEqual([...v0.bytes.subarray(1, v0.bytes.length - 1)], [...bytes]);
  const { tx, signature } = signMessage(bytes, seed);
  assert.equal(tx[0], 1);
  assert.ok(ed25519.verify(tx.subarray(1, 65), bytes, decodeAddress(from)));
  assert.equal(base58.encode(tx.subarray(1, 65)), signature);
  const s = signText('hello', seed);
  assert.ok(verifyText('hello', s, from));
  assert.ok(!verifyText('hello!', s, from));
});
