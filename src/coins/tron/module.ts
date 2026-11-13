// CoinModule for Tron (cw_tron/lib/tron_wallet_service.dart): BIP39 12/24
// words with the key at m/44'/195'/0'/0/0, or a hex private key.

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import type { CoinModule, NewWalletOptions, RestoreKeysOptions, RestoreSeedOptions } from '../module.ts';
import { newWalletId } from '../module.ts';
import type { WalletInfo, WalletSecrets } from '../../core/wallet.ts';
import { generateBip39, validateBip39 } from '../seeds/bip39.ts';
import { addressFromPrivateKey, isValidTronAddress } from './tron.ts';
import { TRON_PATH, TronWallet, tronPrivateKey } from './wallet.ts';

function info(name: string, isRecovery: boolean, address: string, seed: boolean): WalletInfo {
  return {
    id: newWalletId(),
    name,
    type: 'tron',
    isRecovery,
    restoreHeight: 0,
    date: Date.now(),
    address,
    derivationInfo: { derivationType: 'bip39', derivationPath: TRON_PATH },
    seedType: seed ? 'bip39' : undefined,
    isNonSeedWallet: isRecovery && !seed,
  };
}

export const tronModule: CoinModule = {
  type: 'tron',
  seedTypes: () => [{ id: 'bip39', label: 'BIP39' }],
  seedWordCounts: () => [12, 24],
  validateMnemonic: (m) => validateBip39(m.trim()),
  validateAddress: (a) => isValidTronAddress(a),
  keysFields: () => ['privateKey'],

  async createWallet(o: NewWalletOptions) {
    const secrets: WalletSecrets = { mnemonic: o.mnemonic ?? generateBip39(o.wordCount === 24 ? 24 : 12), passphrase: o.passphrase || undefined };
    return { info: info(o.name, false, addressFromPrivateKey(await tronPrivateKey(secrets)), true), secrets };
  },

  async restoreFromSeed(o: RestoreSeedOptions) {
    const m = o.mnemonic.trim().split(/\s+/).join(' ');
    if (!validateBip39(m)) throw new Error('Tron mnemonic has incorrect format. Mnemonic should contain 12 or 24 words separated by space.');
    const secrets: WalletSecrets = { mnemonic: m, passphrase: o.passphrase || undefined };
    return { info: info(o.name, true, addressFromPrivateKey(await tronPrivateKey(secrets)), true), secrets };
  },

  async restoreFromKeys(o: RestoreKeysOptions) {
    const raw = (o.privateKey ?? '').trim().replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{64}$/.test(raw) || !secp256k1.utils.isValidSecretKey(hexToBytes(raw))) throw new Error('invalid tron private key');
    const key = hexToBytes(raw);
    return { info: info(o.name, true, addressFromPrivateKey(key), false), secrets: { privateKey: bytesToHex(key) } };
  },

  async open(i: WalletInfo, s: WalletSecrets) {
    const w = new TronWallet(i, s);
    await w.init();
    return w;
  },
};
