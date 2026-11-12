// Electrum v2 ("segwit", prefix 100) seeds exactly as Cake Wallet makes and
// reads them (cw_bitcoin/lib/bitcoin_mnemonic.dart, cw_core/lib/utils/text_normalizer.dart):
// 24 words from the BIP39 English list, HMAC-SHA512("Seed version") prefix
// check, PBKDF2-HMAC-SHA512(mnemonic, "electrum" + passphrase, 2048).
// Cake's normalizer quirks are reproduced on purpose, so keys match.

import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';

export const SEGWIT_PREFIX = '100';
export const MWEB_PREFIX = 'eb';

// Single code points from Cake's COMBININGCODEPOINTS (its range entries are
// skipped by a bug in combiningcodepoints(), so only these are removed).
const COMBINING_SINGLE = new Set(
  ('300:34e|350:36f|483:487|591:5bd|5bf|5c1|5c2|5c4|5c5|5c7|610:61a|64b:65f|670|6d6:6dc|6df:6e4|6e7|6e8|6ea:6ed|711|730:74a|7eb:7f3|816:819|81b:823|825:827|' +
    '829:82d|859:85b|8d4:8e1|8e3:8ff|93c|94d|951:954|9bc|9cd|a3c|a4d|abc|acd|b3c|b4d|bcd|c4d|c55|c56|cbc|ccd|d4d|dca|e38:e3a|e48:e4b|eb8|eb9|ec8:ecb|f18|f19|' +
    'f35|f37|f39|f71|f72|f74|f7a:f7d|f80|f82:f84|f86|f87|fc6|1037|1039|103a|108d|135d:135f|1714|1734|17d2|17dd|18a9|1939:193b|1a17|1a18|1a60|1a75:1a7c|1a7f|' +
    '1ab0:1abd|1b34|1b44|1b6b:1b73|1baa|1bab|1be6|1bf2|1bf3|1c37|1cd0:1cd2|1cd4:1ce0|1ce2:1ce8|1ced|1cf4|1cf8|1cf9|1dc0:1df5|1dfb:1dff|20d0:20dc|20e1|' +
    '20e5:20f0|2cef:2cf1|2d7f|2de0:2dff|302a:302f|3099|309a|a66f|a674:a67d|a69e|a69f|a6f0|a6f1|a806|a8c4|a8e0:a8f1|a92b:a92d|a953|a9b3|a9c0|aab0|aab2:aab4|' +
    'aab7|aab8|aabe|aabf|aac1|aaf6|abed|fb1e|fe20:fe2f|101fd|102e0|10376:1037a|10a0d|10a0f|10a38:10a3a|10a3f|10ae5|10ae6|11046|1107f|110b9|110ba|11100:11102|' +
    '11133|11134|11173|111c0|111ca|11235|11236|112e9|112ea|1133c|1134d|11366:1136c|11370:11374|11442|11446|114c2|114c3|115bf|115c0|1163f|116b6|116b7|1172b|11c3f|' +
    '16af0:16af4|16b30:16b36|1bc9e|1d165:1d169|1d16d:1d172|1d17b:1d182|1d185:1d18b|1d1aa:1d1ad|1d242:1d244|1e000:1e006|1e008:1e018|1e01b:1e021|1e023|1e024|' +
    '1e026:1e02a|1e8d0:1e8d6|1e944:1e94a')
    .split('|')
    .filter((e) => !e.includes(':'))
    .map((h) => parseInt(h, 16)),
);

const CJK: [number, number][] = [
  [0x4e00, 0x9fff], [0x3400, 0x4dbf], [0x20000, 0x2a6df], [0x2a700, 0x2b73f], [0x2b740, 0x2b81f], [0xf900, 0xfaff], [0x2f800, 0x2fa1d],
  [0x3190, 0x319f], [0x2e80, 0x2eff], [0x2f00, 0x2fdf], [0x31c0, 0x31ef], [0x2ff0, 0x2fff], [0xe0100, 0xe01ef], [0x3100, 0x312f],
  [0x31a0, 0x31bf], [0xff00, 0xffef], [0x3040, 0x309f], [0x30a0, 0x30ff], [0x31f0, 0x31ff], [0x1b000, 0x1b0ff], [0xac00, 0xd7af],
  [0x1100, 0x11ff], [0xa960, 0xa97f], [0xd7b0, 0xd7ff], [0x3130, 0x318f], [0xa4d0, 0xa4ff], [0x16f00, 0x16f9f], [0xa000, 0xa48f], [0xa490, 0xa4cf],
];

const isCjk = (unit: number) => CJK.some(([a, b]) => unit >= a && unit <= b);

/** cw_core normalizeText(): NFKD, lowercase, drop (some) combining marks, trim, drop spaces between CJK chars. */
export function normalizeText(source: string): string {
  // Dart's String.split('') yields UTF-16 code units; mirror that.
  const units = source.normalize('NFKD').toLowerCase().split('');
  const res = units.filter((c) => !COMBINING_SINGLE.has(c.charCodeAt(0))).join('').trim();
  const s = res.split('');
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const isSpace = s[i].trim() === '';
    const prev = i !== 0 && isCjk(s[i - 1].charCodeAt(0));
    const next = i !== s.length - 1 && isCjk(s[i + 1].charCodeAt(0));
    if (!(isSpace && prev && next)) out.push(s[i]);
  }
  return out.join('');
}

export function seedVersionHex(mnemonic: string): string {
  return bytesToHex(hmac(sha512, utf8ToBytes('Seed version'), utf8ToBytes(normalizeText(mnemonic))));
}

export function prefixMatches(mnemonic: string, prefixes: string[]): boolean[] {
  const hx = seedVersionHex(mnemonic);
  return prefixes.map((p) => hx.startsWith(p.toLowerCase()));
}

/** Cake: validateMnemonic -> matchesAnyPrefix(segwit, mweb) */
export function isElectrumSeed(mnemonic: string): boolean {
  try {
    return prefixMatches(mnemonic, [SEGWIT_PREFIX, MWEB_PREFIX]).some(Boolean);
  } catch {
    return false;
  }
}

function maskBytes(bytes: Uint8Array, bits: number) {
  const skip = Math.floor(bits / 8);
  let last = (1 << bits % 8) - 1;
  for (let i = bytes.length - 1 - skip; i >= 0; i--) {
    bytes[i] &= last;
    if (last > 0) last = 0;
  }
}

function encode(data: Uint8Array): string {
  const wordBitLen = 11;
  const wordCount = Math.floor((data.length * 8) / wordBitLen);
  maskBytes(data, wordCount * wordBitLen);
  const bin = Array.from(data, (b) => b.toString(2).padStart(8, '0')).join('');
  const binStr = bin.slice(bin.length - wordCount * wordBitLen);
  const words: string[] = [];
  for (let i = 0; i < wordCount; i++) words.push(english[parseInt(binStr.slice(i * 11, (i + 1) * 11), 2)]);
  return words.join(' ');
}

/** generateElectrumMnemonic(strength: 264, prefix: segwit) -> 24 words */
export function generateElectrumMnemonic(strength = 264, prefix = SEGWIT_PREFIX): string {
  const wordCount = strength / 11;
  const byteCount = Math.ceil(Math.ceil(wordCount * 11) / 8);
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(byteCount));
    maskBytes(bytes, strength);
    const m = encode(bytes);
    if (prefixMatches(m, [prefix])[0]) return m;
  }
}

/** mnemonicToSeedBytes: PBKDF2-HMAC-SHA512(normalize(mnemonic), "electrum" + normalize(passphrase), 2048, 64) */
export async function electrumMnemonicToSeed(mnemonic: string, passphrase = ''): Promise<Uint8Array> {
  const text = normalizeText(mnemonic);
  // Dart: SecretKey(text.codeUnits) — UTF-16 code units, i.e. the low byte of each unit
  const pw = Uint8Array.from(text.split('').map((c) => c.charCodeAt(0) & 0xff));
  const salt = new Uint8Array([...utf8ToBytes('electrum'), ...utf8ToBytes(normalizeText(passphrase))]);
  return pbkdf2Async(sha512, pw, salt, { c: 2048, dkLen: 64 });
}
