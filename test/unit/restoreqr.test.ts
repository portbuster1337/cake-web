import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractAddress, extractSeedPhrase, extractWalletType, parseRestoreQr } from '../../src/app/restoreQr.ts';

const ABANDON = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const XMR = '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

test('restore QR: the wallet type from the code (longest name), xpub/zpub, Monero view-only JSON', () => {
  assert.equal(extractWalletType('monero-wallet:?seed=x'), 'monero');
  assert.equal(extractWalletType('bitcoincash-wallet:?seed=x'), 'bitcoinCash');
  assert.equal(extractWalletType('BITCOIN_WALLET:?seed=x'), 'bitcoin');
  assert.equal(extractWalletType('tron-wallet:?private_key=1'), 'tron');
  assert.equal(extractWalletType('xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz'), 'bitcoin');
  assert.equal(extractWalletType(JSON.stringify({ version: 0, primaryAddress: XMR, privateViewKey: 'ab', restoreHeight: 1 })), 'monero');
  assert.equal(extractWalletType(JSON.stringify({ version: 0, primaryAddress: XMR })), null);
  assert.equal(extractWalletType('ethereum:0xabc'), null);
  assert.equal(extractWalletType(ABANDON), null);
});

test('restore QR: seed phrases in text — whole runs, then Cake\'s search', () => {
  assert.equal(extractSeedPhrase(`seed: ${ABANDON}.`), ABANDON);
  assert.equal(extractSeedPhrase(words(25)), words(25));
  assert.equal(extractSeedPhrase(`x, ${words(16)}; y`), words(16));
  // a 30-word run: the first 12 words, as Cake finds them
  assert.equal(extractSeedPhrase(words(30)), words(12));
  assert.equal(extractSeedPhrase(words(11)), null);
  assert.equal(extractSeedPhrase('a+b+c'), null);
});

test('restore QR: addresses found in the raw text', () => {
  assert.equal(extractAddress(`monero_wallet:${XMR}?spend_key=1`, 'monero'), XMR);
  assert.equal(extractAddress('bitcoin:bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu?amount=1', 'bitcoin'), 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
  assert.equal(extractAddress('nothing here', 'bitcoin'), null);
});

test('restore QR: Cake\'s export and other codes give the restore form', () => {
  // WalletKeysViewModel.getUrl: scheme, seed, height, passphrase (spaces as +)
  const xmr = parseRestoreQr(`monero-wallet:?seed=${encodeURIComponent(words(25)).replace(/%20/g, '+')}&height=3100000&passphrase=`, 'monero');
  assert.deepEqual([xmr.mode, xmr.seed, xmr.height, xmr.passphrase], ['seed', words(25), '3100000', '']);
  const btc = parseRestoreQr(`[My wallet]bitcoin-wallet:?seed=${ABANDON.replace(/ /g, '+')}&passphrase=secret`, 'bitcoin');
  assert.deepEqual([btc.mode, btc.seed, btc.passphrase], ['seed', ABANDON, 'secret']);
  assert.throws(() => parseRestoreQr('bitcoin-wallet:?seed=hello+world+foo+bar+baz+qux+one+two+three+four+five+six', 'bitcoin'), /mnemonic_seed is invalid/);
  assert.throws(() => parseRestoreQr(`ethereum-wallet:?seed=${'abandon+'.repeat(11)}abandon`, 'ethereum'), /invalid checksum/);
  const evm = parseRestoreQr('ethereum-wallet:?private_key=0x0123', 'ethereum');
  assert.deepEqual([evm.mode, evm.privateKey], ['keys', '0x0123']);
  // keys with the address in the path
  const keys = parseRestoreQr(`monero_wallet:${XMR}?spend_key=aa&view_key=bb&height=5`, 'monero');
  assert.deepEqual([keys.mode, keys.address, keys.spendKey, keys.viewKey, keys.height], ['keys', XMR, 'aa', 'bb', '5']);
  assert.throws(() => parseRestoreQr('monero-wallet:?spend_key=&view_key=', 'monero'), /spend_key or view_key is invalid/);
  // xpub as the view key; Monero's view-only JSON
  const xpub = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
  const x = parseRestoreQr(xpub, 'bitcoin');
  assert.deepEqual([x.mode, x.viewKey], ['keys', xpub]);
  const vo = parseRestoreQr(JSON.stringify({ version: 0, primaryAddress: XMR, privateViewKey: 'cc', restoreHeight: 42, label: 'View' }), 'monero');
  assert.deepEqual([vo.mode, vo.address, vo.viewKey, vo.height, vo.name], ['keys', XMR, 'cc', '42', 'View']);
  assert.throws(() => parseRestoreQr(JSON.stringify({ version: 1, primaryAddress: XMR, privateViewKey: 'cc', restoreHeight: 42 }), 'monero'), /unsupported version/);
  // Nano's hex seed; tx-id restores are not supported
  const nano = parseRestoreQr('nano-wallet:?hexSeed=ABCDEF', 'nano');
  assert.deepEqual([nano.mode, nano.seed], ['seed', 'ABCDEF']);
  assert.throws(() => parseRestoreQr('monero-wallet:?tx_payment_id=abc', 'monero'), /txids/);
  assert.throws(() => parseRestoreQr('litecoin-wallet:?label=x', 'litecoin'), /restore params are invalid/);
});

test('restore QR: a type picked by hand reads only a seed phrase or an xpub', () => {
  const r = parseRestoreQr(`my backup: ${ABANDON}`, 'bitcoin', true);
  assert.deepEqual([r.type, r.mode, r.seed], ['bitcoin', 'seed', ABANDON]);
  const x = parseRestoreQr('xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz', 'bitcoin', true);
  assert.equal(x.mode, 'keys');
  assert.throws(() => parseRestoreQr('just a few words', 'bitcoin', true), /Failed to determine valid seed phrase/);
});
