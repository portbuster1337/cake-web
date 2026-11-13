import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blake2b } from '@noble/hashes/blake2.js';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { unzipSync } from 'fflate';
import { cbDecrypt, cbEncrypt, packBackupV3, sha512hex, unpackBackupV3 } from '../../src/core/cakeBackup.ts';

test('cake_backup v2 container: layout, checksum and key derivation as in lib/backup.dart', async () => {
  const pt = utf8ToBytes('hello cake backup');
  const blob = await cbEncrypt('pass', pt);
  assert.equal(blob[0], 2);
  assert.equal(blob.length, 121 + pt.length);
  const salt = blob.subarray(1, 17);
  const nonce = blob.subarray(17, 41);
  const tag = blob.subarray(41, 57);
  const sum = blob.subarray(57, 121);
  const ct = blob.subarray(121);
  const aad = utf8ToBytes('Cake Wallet backup v2');
  // checksum: BLAKE2b-512 over len(aad) || aad || version || salt || nonce || tag || ciphertext
  const expect = blake2b(new Uint8Array([aad.length, ...aad, 2, ...salt, ...nonce, ...tag, ...ct]), { dkLen: 64 });
  assert.equal(bytesToHex(sum), bytesToHex(expect));
  // key: PBKDF2-HMAC-SHA512(passphrase, salt, 120000, 32); XChaCha20-Poly1305 with the protocol string as AAD
  const key = pbkdf2(sha512, utf8ToBytes('pass'), salt, { c: 120_000, dkLen: 32 });
  assert.deepEqual(xchacha20poly1305(key, nonce, aad).decrypt(new Uint8Array([...ct, ...tag])), pt);
  assert.deepEqual(await cbDecrypt('pass', blob), pt);
  await assert.rejects(cbDecrypt('wrong', blob), /Failed to decrypt backup file/);
  const bad = blob.slice();
  bad[130] ^= 1;
  await assert.rejects(cbDecrypt('pass', bad), /BadChecksum/);
  await assert.rejects(cbDecrypt('pass', Uint8Array.of(9, ...blob.subarray(1))), /BadProtocolVersion/);
});

test('cake_backup v3 (high-entropy, one PBKDF2 iteration) decrypts too', async () => {
  const blob = await cbEncrypt('a'.repeat(64), utf8ToBytes('x'), 3);
  assert.equal(blob[0], 3);
  assert.equal(new TextDecoder().decode(await cbDecrypt('a'.repeat(64), blob)), 'x');
});

test('backup v3 file: data.bin chunks, metadata.json, README.txt', async () => {
  const payload = crypto.getRandomValues(new Uint8Array(5000));
  const file = await packBackupV3(payload, 'pw', 'Cake Wallet', '6.5.3', new Date('2026-11-12T09:05:00Z'));
  assert.equal(file[0], 0x50);
  const outer = unzipSync(file);
  assert.deepEqual(Object.keys(outer), ['data.bin', 'metadata.json', 'README.txt']);
  const meta = new TextDecoder().decode(outer['metadata.json']);
  const m = JSON.parse(meta);
  assert.equal(meta, JSON.stringify(m, null, 4));
  assert.equal(m.version, 3);
  assert.equal(m.cakeVersion, '6.5.3');
  assert.equal(m.sha512sum, sha512hex(payload));
  assert.equal(m.chunks.length, 1);
  assert.equal(m.chunks[0].length.encrypted, m.chunks[0].length.plain + 121);
  assert.equal(m.chunks[0].sha512sum.plain, sha512hex(payload));
  assert.match(new TextDecoder().decode(outer['README.txt']), /^This is a Cake Wallet backup\. Do not modify this archive\.\n\nApp version: 6\.5\.3\n/);
  assert.deepEqual(await unpackBackupV3(outer, 'pw'), payload);
  await assert.rejects(unpackBackupV3(outer, 'nope'), /Failed to decrypt/);
  const tampered = { ...outer, 'data.bin': outer['data.bin'].slice() };
  tampered['data.bin'][200] ^= 1;
  await assert.rejects(unpackBackupV3(tampered, 'pw'), /checksum mismatch/);
});
