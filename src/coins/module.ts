// Per-coin modules (lazy loaded): creation/restoration of wallets and the
// engine that runs them. Mirrors Cake's WalletService per wallet type.

import type { WalletType } from './types.ts';
import type { WalletBase, WalletInfo, WalletSecrets } from '../core/wallet.ts';

export interface NewWalletOptions {
  name: string;
  /** seed type id (electrum/bip39 for BTC, legacy/polyseed/bip39 for XMR, …) */
  seedType?: string;
  passphrase?: string;
  /** seed language (Monero legacy/polyseed) */
  language?: string;
  /** reuse an existing BIP39 mnemonic (wallet groups) */
  mnemonic?: string;
  /** 12 or 24 words */
  wordCount?: number;
  network?: string;
}

export interface RestoreSeedOptions {
  name: string;
  mnemonic: string;
  passphrase?: string;
  height?: number;
  derivationType?: string;
  derivationPath?: string;
  network?: string;
}

export interface RestoreKeysOptions {
  name: string;
  address?: string;
  viewKey?: string;
  spendKey?: string;
  privateKey?: string;
  hexSeed?: string;
  height?: number;
  network?: string;
}

export interface DerivationCandidate {
  derivationType: string;
  derivationPath?: string;
  scriptType?: string;
  description: string;
  address: string;
  balance?: string;
  txCount?: number;
}

export interface CoinModule {
  type: WalletType;
  /** seed types offered on the advanced settings page, first = default */
  seedTypes(): { id: string; label: string }[];
  createWallet(o: NewWalletOptions): Promise<{ info: WalletInfo; secrets: WalletSecrets }>;
  restoreFromSeed(o: RestoreSeedOptions): Promise<{ info: WalletInfo; secrets: WalletSecrets }>;
  restoreFromKeys?(o: RestoreKeysOptions): Promise<{ info: WalletInfo; secrets: WalletSecrets }>;
  /** BTC/LTC/Nano/EVM: which derivations hold funds (WalletRestoreChooseDerivationPage) */
  findDerivations?(mnemonic: string, passphrase?: string): Promise<DerivationCandidate[]>;
  validateMnemonic(mnemonic: string): boolean;
  /** word counts accepted on the restore page */
  seedWordCounts(): number[];
  open(info: WalletInfo, secrets: WalletSecrets): Promise<WalletBase>;
  validateAddress(address: string): boolean;
  /** restore-from-keys field set */
  keysFields?(): ('address' | 'viewKey' | 'spendKey' | 'privateKey' | 'hexSeed' | 'height')[];
}

const loaders: Partial<Record<WalletType, () => Promise<CoinModule>>> = {};

export function registerCoin(t: WalletType, loader: () => Promise<CoinModule>): void {
  loaders[t] = loader;
}

const cache = new Map<WalletType, Promise<CoinModule>>();

export function coinModule(t: WalletType): Promise<CoinModule> {
  let p = cache.get(t);
  if (!p) {
    const l = loaders[t];
    if (!l) return Promise.reject(new Error(`${t} is not supported yet`));
    p = l();
    cache.set(t, p);
  }
  return p;
}

export function isCoinSupported(t: WalletType): boolean {
  return !!loaders[t];
}

export function newWalletId(): string {
  return crypto.randomUUID();
}
