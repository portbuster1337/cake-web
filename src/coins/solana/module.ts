// CoinModule for Solana (cw_solana/lib/solana_wallet_service.dart): BIP39
// 12/24 words with the key at m/44'/501'/0'/0', or a private key (a base58
// 64-byte keypair, else a 32-byte hex seed).

import { bytesToHex } from '@noble/hashes/utils.js';
import type { CoinModule, NewWalletOptions, RestoreKeysOptions, RestoreSeedOptions } from '../module.ts';
import { newWalletId } from '../module.ts';
import type { WalletInfo, WalletSecrets } from '../../core/wallet.ts';
import { generateBip39, validateBip39 } from '../seeds/bip39.ts';
import { isValidSolAddress, publicKeyOf } from './sol.ts';
import { SOL_PATH, SolanaWallet, parseSolanaPrivateKey, solanaSeed } from './wallet.ts';

function info(name: string, isRecovery: boolean, address: string, seed: boolean): WalletInfo {
  return {
    id: newWalletId(),
    name,
    type: 'solana',
    isRecovery,
    restoreHeight: 0,
    date: Date.now(),
    address,
    derivationInfo: { derivationType: 'bip39', derivationPath: SOL_PATH },
    seedType: seed ? 'bip39' : undefined,
    isNonSeedWallet: isRecovery && !seed,
  };
}

export const solanaModule: CoinModule = {
  type: 'solana',
  seedTypes: () => [{ id: 'bip39', label: 'BIP39' }],
  seedWordCounts: () => [12, 24],
  validateMnemonic: (m) => validateBip39(m.trim()),
  validateAddress: (a) => isValidSolAddress(a),
  keysFields: () => ['privateKey'],

  async createWallet(o: NewWalletOptions) {
    const secrets: WalletSecrets = { mnemonic: o.mnemonic ?? generateBip39(o.wordCount === 24 ? 24 : 12), passphrase: o.passphrase || undefined };
    return { info: info(o.name, false, publicKeyOf(await solanaSeed(secrets)), true), secrets };
  },

  async restoreFromSeed(o: RestoreSeedOptions) {
    const m = o.mnemonic.trim().split(/\s+/).join(' ');
    if (!validateBip39(m)) throw new Error('Solana mnemonic has incorrect format. Mnemonic should contain 12 or 24 words separated by space.');
    const secrets: WalletSecrets = { mnemonic: m, passphrase: o.passphrase || undefined };
    return { info: info(o.name, true, publicKeyOf(await solanaSeed(secrets)), true), secrets };
  },

  async restoreFromKeys(o: RestoreKeysOptions) {
    const seed = parseSolanaPrivateKey(o.privateKey ?? '');
    return { info: info(o.name, true, publicKeyOf(seed), false), secrets: { privateKey: bytesToHex(seed) } };
  },

  async open(i: WalletInfo, s: WalletSecrets) {
    const w = new SolanaWallet(i, s);
    await w.init();
    return w;
  },
};
