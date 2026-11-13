// Cake's vulnerable-seed check (DashboardViewModel.checkAffectedWallets, vulnerable_seeds_popup.dart): a Bitcoin
// wallet whose recovery phrase hashes (SHA-256) to an entry of the list Cake ships of seeds made by a faulty
// generator. The list is one of this site's own files; nothing leaves the browser.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export const WEAK_SEEDS_FILE = './cake/text/cakewallet_weak_bitcoin_seeds_hashed_sorted_version1.txt';

export function seedHash(mnemonic: string): string {
  return bytesToHex(sha256(utf8ToBytes(mnemonic)));
}

/** the list's hashes (its last line is out of order, so it is not searched as a sorted list) */
export function parseWeakSeeds(text: string): Set<string> {
  return new Set(text.split('\n').map((l) => l.trim().toLowerCase()).filter((l) => /^[0-9a-f]{64}$/.test(l)));
}

export function isWeakSeed(list: Set<string>, mnemonic: string): boolean {
  return list.has(seedHash(mnemonic));
}

/** VulnerableSeedsPopup's text */
export function weakSeedsNotice(names: string[]): string {
  return `Your Bitcoin wallet(s) below use a legacy seed format that is vulnerable, which MAY result in you losing money from these wallet(s) if no action is taken.\nWe recommend that you IMMEDIATELY create wallet(s) in Cake Wallet and immediately transfer the funds to these wallet(s).\nVulnerable wallet name(s):\n\n[${names.join(', ')}]\n\nFor assistance, please use the in-app support or email support@cakewallet.com`;
}
