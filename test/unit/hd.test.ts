import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyTree, convertAnyToXpub, hardenedPrefix } from '../../src/coins/utxo/hd.ts';
import { bip39Seed, validateBip39 } from '../../src/coins/seeds/bip39.ts';
import { electrumMnemonicToSeed } from '../../src/coins/seeds/electrum.ts';

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

test('bip39 validation is strict like Cake (single spaces)', () => {
  assert.ok(validateBip39(M));
  assert.ok(!validateBip39(M + ' '));
  assert.ok(!validateBip39(M.replace(' ', '  ')));
  assert.ok(!validateBip39(M.replace('about', 'abandon')));
});

test('BIP44/49/84/86 vectors through the Cake key tree', async () => {
  const seed = await bip39Seed(M);
  const t = new KeyTree({ coin: 'btc', seed, derivationType: 'bip39', derivationPath: "m/84'/0'/0'" });
  const recv = (type: any) => t.address({ type, account: 0, change: false, legacy: false }, 0);
  assert.equal(recv('p2wpkh'), 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  assert.equal(t.address({ type: 'p2wpkh', account: 0, change: true, legacy: false }, 0), 'bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el');
  assert.equal(recv('p2sh'), '37VucYSaXLCAsxYyAPfbSi9eh4iEcbShgf');
  assert.equal(recv('p2pkh'), '1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA');
  assert.equal(recv('p2tr'), 'bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr');
  assert.match(recv('p2wsh'), /^bc1q[a-z0-9]{58}$/);
  // legacy chain = keys of the saved path (m/84'/0'/0'/0/i) encoded as P2PKH
  assert.notEqual(t.address({ type: 'p2pkh', account: 0, change: false, legacy: true }, 0), recv('p2pkh'));
  const k = t.keysInfo();
  assert.equal(k.xpub, 'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V');
  assert.equal(k.fingerprint, '73c5da0a');
  assert.equal(hardenedPrefix("m/84'/0'/0'/0"), "m/84'/0'/0'");
});

test('Electrum derivation: every type from m/0\'', async () => {
  // electrum/tests/test_wallet_vertical.py test_electrum_seed_segwit
  const words = 'bitter grass shiver impose acquire brush forget axis eager alone wine silver';
  const seed = await electrumMnemonicToSeed(words);
  const t = new KeyTree({ coin: 'btc', seed, derivationType: 'electrum' });
  assert.equal(t.address({ type: 'p2wpkh', account: 0, change: false, legacy: false }, 0), 'bc1q3g5tmkmlvxryhh843v4dz026avatc0zzr6h3af');
  assert.equal(t.address({ type: 'p2wpkh', account: 0, change: true, legacy: false }, 0), 'bc1qdy94n2q5qcp0kg7v9yzwe6wvfkhnvyzje7nx2p');
});

test('LTC / BCH / DOGE address formats', async () => {
  const seed = await bip39Seed(M);
  const ltc = new KeyTree({ coin: 'ltc', seed, derivationType: 'bip39' });
  assert.match(ltc.address({ type: 'p2wpkh', account: 0, change: false, legacy: false }, 0), /^ltc1q/);
  const bch = new KeyTree({ coin: 'bch', seed, derivationType: 'bip39' });
  assert.match(bch.address({ type: 'p2pkh', account: 0, change: false, legacy: false }, 0), /^bitcoincash:q/);
  const doge = new KeyTree({ coin: 'doge', seed, derivationType: 'bip39' });
  assert.match(doge.address({ type: 'p2pkh', account: 0, change: false, legacy: false }, 0), /^D/);
  console.log('ltc', ltc.address({ type: 'p2wpkh', account: 0, change: false, legacy: false }, 0), 'bch', bch.address({ type: 'p2pkh', account: 0, change: false, legacy: false }, 0), 'doge', doge.address({ type: 'p2pkh', account: 0, change: false, legacy: false }, 0));
});

test('zpub -> xpub', () => {
  const zpub = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
  assert.equal(convertAnyToXpub(zpub), 'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V');
});
