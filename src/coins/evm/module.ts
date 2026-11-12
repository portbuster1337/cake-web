// CoinModule for the six EVM chains (cw_evm/lib/evm_chain_wallet_service.dart):
// BIP39 12/24 words, one key at m/44'/60'/0'/0/0, or a hex private key.

import type { CoinModule, NewWalletOptions, RestoreKeysOptions, RestoreSeedOptions } from '../module.ts';
import { newWalletId } from '../module.ts';
import type { WalletInfo, WalletSecrets } from '../../core/wallet.ts';
import type { WalletType } from '../types.ts';
import { generateBip39, validateBip39 } from '../seeds/bip39.ts';
import { addressFromPrivateKey, isValidEvmAddress, unhex } from './eth.ts';
import { EVM_PATH, EvmWallet, evmPrivateKey } from './wallet.ts';
import { bytesToHex } from '@noble/hashes/utils.js';

function info(type: WalletType, name: string, isRecovery: boolean, address: string, seed: boolean): WalletInfo {
  return {
    id: newWalletId(),
    name,
    type,
    isRecovery,
    restoreHeight: 0,
    date: Date.now(),
    address,
    derivationInfo: { derivationType: 'bip39', derivationPath: EVM_PATH },
    seedType: seed ? 'bip39' : undefined,
    isNonSeedWallet: isRecovery && !seed,
  };
}

function makeModule(type: WalletType): CoinModule {
  return {
    type,
    seedTypes: () => [{ id: 'bip39', label: 'BIP39' }],
    seedWordCounts: () => [12, 24],
    validateMnemonic: (m) => validateBip39(m.trim()),
    validateAddress: (a) => isValidEvmAddress(a),
    keysFields: () => ['privateKey'],

    async createWallet(o: NewWalletOptions) {
      const mnemonic = o.mnemonic ?? generateBip39(o.wordCount === 24 ? 24 : 12);
      const secrets: WalletSecrets = { mnemonic, passphrase: o.passphrase || undefined };
      return { info: info(type, o.name, false, addressFromPrivateKey(await evmPrivateKey(secrets)), true), secrets };
    },

    async restoreFromSeed(o: RestoreSeedOptions) {
      const m = o.mnemonic.trim().split(/\s+/).join(' ');
      if (!validateBip39(m)) throw new Error('EVM mnemonic has incorrect format. Mnemonic should contain 12 or 24 words separated by space.');
      const secrets: WalletSecrets = { mnemonic: m, passphrase: o.passphrase || undefined };
      return { info: info(type, o.name, true, addressFromPrivateKey(await evmPrivateKey(secrets)), true), secrets };
    },

    async restoreFromKeys(o: RestoreKeysOptions) {
      const raw = (o.privateKey ?? '').trim().replace(/^0x/i, '');
      if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error('Invalid private key');
      const key = unhex(raw);
      const secrets: WalletSecrets = { privateKey: bytesToHex(key) };
      return { info: info(type, o.name, true, addressFromPrivateKey(key), false), secrets };
    },

    async open(i: WalletInfo, s: WalletSecrets) {
      const w = new EvmWallet(i, s);
      await w.init();
      return w;
    },
  };
}

export const ethereumModule = makeModule('ethereum');
export const polygonModule = makeModule('polygon');
export const baseModule = makeModule('base');
export const arbitrumModule = makeModule('arbitrum');
export const bscModule = makeModule('bsc');
export const robinhoodModule = makeModule('robinhood');
