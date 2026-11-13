import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { groupIdentifierOf, hashedWalletIdentifier, isBip39Wallet, joinableGroups, walletGroupKey, walletGroups } from '../../src/app/groups.ts';
import type { WalletInfo } from '../../src/core/wallet.ts';

const MN = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const info = (id: string, type: WalletInfo['type'], extra: Partial<WalletInfo> = {}): WalletInfo => ({ id, name: id, type, isRecovery: false, restoreHeight: 0, date: 0, address: `addr-${id}`, ...extra });

test('hashed wallet identifiers: salted sha256 of the seed, else the address', () => {
  assert.equal(hashedWalletIdentifier(MN), bytesToHex(sha256(new TextEncoder().encode(`cake-web.wallet-group.${MN}`))));
  const a = info('a', 'bitcoin');
  assert.equal(groupIdentifierOf(a, { mnemonic: MN }), groupIdentifierOf(info('b', 'ethereum'), { mnemonic: MN }));
  assert.notEqual(groupIdentifierOf(a, { mnemonic: MN }), groupIdentifierOf(a, {}));
  assert.equal(groupIdentifierOf(a, {}), hashedWalletIdentifier('addr-a'));
  assert.equal(groupIdentifierOf({ ...a, address: '' }, {}), hashedWalletIdentifier('a'));
  assert.equal(groupIdentifierOf(a, { hexSeed: 'ff' }), hashedWalletIdentifier('ff'));
});

test('groups: by identifier (else the parent address, the address, the id), in list order', () => {
  const g = walletGroups([info('a', 'bitcoin', { hashedWalletIdentifier: 'h1' }), info('b', 'monero'), info('c', 'ethereum', { hashedWalletIdentifier: 'h1' }), info('d', 'tron', { parentAddress: 'addr-b' })]);
  assert.deepEqual(g.map((x) => [x.key, x.wallets.map((w) => w.id)]), [['h1', ['a', 'c']], ['addr-b', ['b', 'd']]]);
  assert.equal(walletGroupKey(info('e', 'nano', { address: '' })), 'e');
});

test('joinable groups: BIP39 seed wallets only, one wallet of each type per group', () => {
  assert.ok(isBip39Wallet('monero') && isBip39Wallet('tron') && !isBip39Wallet('wownero') && !isBip39Wallet('haven'));
  const list = [
    info('btc', 'bitcoin', { hashedWalletIdentifier: 'g1', derivationInfo: { derivationType: 'bip39' } }),
    info('eth', 'ethereum', { hashedWalletIdentifier: 'g1' }),
    info('xmr', 'monero', { hashedWalletIdentifier: 'g2' }),
    info('xmr39', 'monero', { hashedWalletIdentifier: 'g3', derivationInfo: { derivationType: 'bip39' } }),
    info('ele', 'bitcoin', { hashedWalletIdentifier: 'g4', derivationInfo: { derivationType: 'electrum' } }),
    info('keys', 'solana', { hashedWalletIdentifier: 'g5', isNonSeedWallet: true }),
    info('xpub', 'litecoin', { hashedWalletIdentifier: 'g6', isWatchOnly: true }),
    info('nano', 'nano', { hashedWalletIdentifier: 'g7', derivationInfo: { derivationType: 'nano' } }),
    info('ltc', 'litecoin', { hashedWalletIdentifier: 'g8', derivationInfo: { derivationType: 'bip39' } }),
  ];
  // a new Solana wallet: the BTC+ETH group, Monero from BIP39 and the BIP39 Litecoin wallet
  const sol = joinableGroups(list, 'solana');
  assert.deepEqual(sol.multi.map((g) => g.key), ['g1']);
  assert.deepEqual(sol.single.map((w) => w.id), ['xmr39', 'ltc']);
  // a new Ethereum wallet: not the group that already has one
  const eth = joinableGroups(list, 'ethereum');
  assert.deepEqual(eth.multi.map((g) => g.key), []);
  assert.deepEqual(eth.single.map((w) => w.id), ['xmr39', 'ltc']);
  // a new Litecoin wallet: not the Litecoin wallets themselves
  assert.deepEqual(joinableGroups(list, 'litecoin').single.map((w) => w.id), ['xmr39']);
  assert.deepEqual(joinableGroups([], 'bitcoin'), { multi: [], single: [] });
});
