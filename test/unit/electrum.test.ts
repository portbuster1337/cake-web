import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex } from '@noble/hashes/utils.js';
import { electrumMnemonicToSeed, generateElectrumMnemonic, isElectrumSeed, prefixMatches, normalizeText } from '../../src/coins/seeds/electrum.ts';

// electrum/tests/test_mnemonic.py
const WORDS = 'wild father tree among universe such mobile favorite target dynamic credit identify';

test('electrum segwit seed version', () => {
  assert.equal(prefixMatches(WORDS, ['100'])[0], true);
  assert.equal(isElectrumSeed(WORDS), true);
  assert.equal(isElectrumSeed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'), false);
});

test('electrum seed -> bip32 seed (Electrum test vector)', async () => {
  assert.equal(bytesToHex(await electrumMnemonicToSeed(WORDS)), 'aac2a6302e48577ab4b46f23dbae0774e2e62c796f797d0a1b5faeb528301e3064342dafb79069e7c4c6b8c38ae11d7a973bec0d4f70626f8cc5184a8d0b0756');
  assert.equal(bytesToHex(await electrumMnemonicToSeed(WORDS, 'Did you ever hear the tragedy of Darth Plagueis the Wise?')), '4aa29f2aeb0127efb55138ab9e7be83b36750358751906f86c662b21a1ea1370f949e6d1a12fa56d3d93cadda93038c76ac8118597364e46f5156fde6183c82f');
});

test('generated Cake electrum seeds: 24 words, segwit prefix', () => {
  for (let i = 0; i < 5; i++) {
    const m = generateElectrumMnemonic();
    assert.equal(m.split(' ').length, 24);
    assert.equal(prefixMatches(m, ['100'])[0], true);
  }
});

test('normalizeText keeps Cake quirks', () => {
  assert.equal(normalizeText('  Wild FATHER '), 'wild father');
});
