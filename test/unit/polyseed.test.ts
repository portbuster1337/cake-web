import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2 } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { Polyseed, PolyseedCoin, ENGLISH, languages } from '../../src/coins/monero/polyseed.ts';

// vectors from cake-tech/polyseed_dart test/polyseed_c_test.dart (= tevador/polyseed tests.c)
const seedTime1 = 1638446400;
const randBytes1 = [0xdd, 0x76, 0xe7, 0x35, 0x9a, 0x0d, 0xed, 0x37, 0xcd, 0x0f, 0xf0, 0xf3, 0xc8, 0x29, 0xa5, 0xae, 0x01, 0x67, 0xf3];
const phraseEn1 = 'raven tail swear infant grief assist regular lamp duck valid someone little harsh puppy airport language';
const keyPw1 = 'dd76e7359a0ded37cd0ff0f3c829a5ae01673300000000000000000000000000';
const keySalt1 = '504f4c5953454544206b657900ffffff00000000010000000000000000000000';

test('polyseed encode (tests.c seed1 -> phraseEn1)', () => {
  const s = Polyseed.create(seedTime1, Uint8Array.from(randBytes1));
  assert.equal(s.encode(ENGLISH, PolyseedCoin.MONERO), phraseEn1);
  assert.ok(s.birthday <= seedTime1 && s.birthday + 2630000 > seedTime1);
});

test('polyseed decode + keygen equals PBKDF2 over the expected password/salt', async () => {
  const s = Polyseed.decode(phraseEn1, ENGLISH, PolyseedCoin.MONERO);
  const key = await s.generateKey(PolyseedCoin.MONERO, 32);
  assert.equal(hex.encode(key), hex.encode(pbkdf2(sha256, hex.decode(keyPw1), hex.decode(keySalt1), { c: 10000, dkLen: 32 })));
  assert.throws(() => Polyseed.decode(phraseEn1, ENGLISH, PolyseedCoin.AEON), /checksum/);
});

test('polyseed prefixes, language detection, encryption roundtrip', async () => {
  const short = 'rave tail swea infan grie assi regul lamp duck vali some litt hars pupp airp langua';
  assert.equal(Polyseed.decode(short, ENGLISH).encode(), phraseEn1);
  assert.equal((await Polyseed.detectLanguage(phraseEn1)).key, 'en');
  const es = (await languages()).find((l) => l.key === 'es')!;
  const s = Polyseed.decode(phraseEn1, ENGLISH);
  const esPhrase = s.encode(es);
  assert.equal((await Polyseed.detectLanguage(esPhrase)).key, 'es');
  const enc = s.clone();
  await enc.crypt('password');
  assert.ok(enc.isEncrypted);
  const k1 = await s.generateKey();
  await enc.crypt('password');
  assert.ok(!enc.isEncrypted);
  assert.equal(hex.encode(await enc.generateKey()), hex.encode(k1));
});
