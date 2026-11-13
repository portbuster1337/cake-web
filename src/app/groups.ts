// Wallet groups (lib/entities/wallet_manager.dart, hash_wallet_identifier.dart,
// lib/view_model/wallet_groups_display_view_model.dart): wallets made from the
// same seed share a hashed identifier and show as one group; a new wallet can
// join a group by taking its recovery phrase.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { WalletType } from '../coins/types.ts';
import type { WalletInfo, WalletSecrets } from '../core/wallet.ts';

/** Cake salts the hash with a secret of its own builds; this one has its own salt */
const SALT = 'cake-web.wallet-group';

/** createHashedWalletIdentifier: sha256("<salt>.<seed, else the primary address>") */
export function hashedWalletIdentifier(seedOrAddress: string): string {
  return bytesToHex(sha256(utf8ToBytes(`${SALT}.${seedOrAddress}`)));
}

/** what a wallet's identifier is made of: its seed, else its address (or, before it has one, its id) */
export function groupIdentifierOf(info: WalletInfo, s: WalletSecrets): string {
  return hashedWalletIdentifier(s.mnemonic || s.hexSeed || info.address || info.id);
}

/** WalletManager._resolveGroupKey */
export function walletGroupKey(w: WalletInfo): string {
  return w.hashedWalletIdentifier || w.parentAddress || w.address || w.id;
}

export interface WalletGroup {
  key: string;
  wallets: WalletInfo[];
}

/** WalletManager.updateWalletGroups: the wallets by group, in list order */
export function walletGroups(list: WalletInfo[]): WalletGroup[] {
  const out: WalletGroup[] = [];
  for (const w of list) {
    const k = walletGroupKey(w);
    const g = out.find((x) => x.key === k);
    if (g) g.wallets.push(w);
    else out.push({ key: k, wallets: [w] });
  }
  return out;
}

/** isBIP39Wallet (reactions/wallet_utils.dart) */
export function isBip39Wallet(type: WalletType): boolean {
  return ['ethereum', 'polygon', 'base', 'arbitrum', 'bsc', 'robinhood', 'solana', 'tron', 'bitcoin', 'litecoin', 'bitcoinCash', 'nano', 'banano', 'monero', 'dogecoin', 'zcash', 'zano', 'decred'].includes(type);
}

/** a wallet that keeps a group from taking a new wallet of `type` */
function excludes(w: WalletInfo, type: WalletType): boolean {
  const d = w.derivationInfo?.derivationType;
  return (
    !isBip39Wallet(w.type) ||
    ((w.type === 'nano' || w.type === 'banano') && d === 'nano') ||
    ((w.type === 'bitcoin' || w.type === 'litecoin') && d === 'electrum') ||
    // a group holds one wallet of each type
    w.type === type ||
    !!w.isNonSeedWallet ||
    !!w.isWatchOnly ||
    !!w.hardwareWalletType ||
    ((w.type === 'monero' || w.type === 'zano') && d !== 'bip39') ||
    (w.type === 'decred' && d !== 'bip39' && d !== undefined && d !== 'unknown')
  );
}

/** updateWalletInfoSourceList: the groups a new wallet of `type` can join — several wallets, or a single one */
export function joinableGroups(list: WalletInfo[], type: WalletType): { multi: WalletGroup[]; single: WalletInfo[] } {
  const ok = walletGroups(list).filter((g) => !g.wallets.some((w) => excludes(w, type)));
  return { multi: ok.filter((g) => g.wallets.length > 1), single: ok.filter((g) => g.wallets.length === 1).map((g) => g.wallets[0]) };
}
