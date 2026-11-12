// BIP39 exactly as Cake Wallet uses it (cw_core/lib/utils/bip39_seed.dart):
// English wordlist, standard checksum, and the seed computed WITHOUT NFKD
// normalisation: PBKDF2-HMAC-SHA512(mnemonic UTF-16 code units, "mnemonic" +
// passphrase (UTF-8), 2048, 64). Identical to BIP39 for ASCII input.

import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { generateMnemonic as scureGenerate, validateMnemonic as scureValidate, mnemonicToEntropy, entropyToMnemonic } from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';

export { english as bip39English };

/** 12 words (128 bits) or 24 words (256 bits) */
export function generateBip39(words: 12 | 24 | number = 12): string {
  return scureGenerate(english, words === 24 ? 256 : words === 18 ? 192 : 128);
}

/** bip39.validateMnemonic: single spaces, word count % 3 == 0, all words known, checksum. */
export function validateBip39(m: string): boolean {
  if (!m || m !== m.trim() || /\s{2,}/.test(m)) return false;
  const words = m.split(' ');
  if (words.length % 3 !== 0 || words.length < 12) return false;
  try {
    return scureValidate(m, english);
  } catch {
    return false;
  }
}

/** Lenient check used when the user's text has stray whitespace. */
export function normalizeMnemonicInput(m: string): string {
  return m.trim().toLowerCase().split(/\s+/).join(' ');
}

export async function bip39Seed(mnemonic: string, passphrase = ''): Promise<Uint8Array> {
  const pw = Uint8Array.from(Array.from(mnemonic, (c) => c.charCodeAt(0) & 0xff));
  // Dart String.codeUnits of ASCII words == UTF-8 bytes; non-ASCII words are not in the English list.
  const salt = utf8ToBytes(`mnemonic${passphrase}`);
  return pbkdf2Async(sha512, pw, salt, { c: 2048, dkLen: 64 });
}

export function bip39ToEntropy(m: string): Uint8Array {
  return mnemonicToEntropy(m, english);
}

export function entropyToBip39(e: Uint8Array): string {
  return entropyToMnemonic(e, english);
}

export function isBip39Word(w: string): boolean {
  return english.includes(w);
}
