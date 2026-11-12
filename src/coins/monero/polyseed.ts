// Polyseed (tevador/polyseed, as ported by Cake in cake-tech/polyseed_dart):
// 16 words = 150-bit secret + 10-bit birthday + 5 feature bits + an 11-bit
// GF(2048) checksum; the coin is XORed into coefficient 1, so a Wownero seed
// does not decode as Monero. Spend key = PBKDF2-HMAC-SHA256(secret, salt, 10000, 32).

import { pbkdf2Async } from '@noble/hashes/pbkdf2.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';

export const NUM_WORDS = 16;
const SECRET_SIZE = 19;
const SECRET_BITS = 150;
const SHARE_BITS = 10;
const DATA_WORDS = 15;
const DATE_BITS = 10;
const FEATURE_BITS = 5;
const GF_BITS = 11;
const CLEAR_MASK = ~(((1 << 2) - 1) << 6) & 0xff; // keep the low 6 bits of the last byte
const ENCRYPTED = 16;
export const EPOCH = 1635768000;
export const TIME_STEP = 2629746;

export const PolyseedCoin = { MONERO: 0, AEON: 1, WOWNERO: 2 } as const;
export type PolyseedCoin = (typeof PolyseedCoin)[keyof typeof PolyseedCoin];

export interface PolyseedData {
  birthday: number;
  features: number;
  secret: Uint8Array; // 32-byte buffer, 19 used
  checksum: number;
}

export interface PolyseedLang {
  key: string;
  name: string;
  nameEnglish: string;
  separator: string;
  words: string[];
}

export const ENGLISH: PolyseedLang = { key: 'en', name: 'English', nameEnglish: 'English', separator: ' ', words: english };

let others: PolyseedLang[] | null = null;
export async function languages(): Promise<PolyseedLang[]> {
  if (!others) {
    const { POLYSEED_LANGS } = await import('./polyseedWords.gen.ts');
    others = Object.entries(POLYSEED_LANGS).map(([key, v]) => ({ key, ...v }));
  }
  // detection order of PolyseedLang.languages: cs, en, es, fr, it, jp, ko, pt, zh_s, zh_t
  const by = new Map(others.map((l) => [l.key, l]));
  return ['cs', 'en', 'es', 'fr', 'it', 'jp', 'ko', 'pt', 'zh_s', 'zh_t'].map((k) => (k === 'en' ? ENGLISH : by.get(k)!)).filter(Boolean);
}

export function birthdayEncode(time: number): number {
  if (time === -1 || time < EPOCH) return 0;
  return Math.floor((time - EPOCH) / TIME_STEP) & ((1 << DATE_BITS) - 1);
}

export function birthdayDecode(b: number): number {
  return EPOCH + b * TIME_STEP;
}

const MUL2 = [5, 7, 1, 3, 13, 15, 9, 11];
function mul2(x: number): number {
  if (x < 1024) return 2 * x;
  return MUL2[x % 8] + 16 * Math.floor((x - 1024) / 8);
}

function evalPoly(c: number[]): number {
  let r = c[NUM_WORDS - 1];
  for (let i = NUM_WORDS - 2; i >= 0; --i) r = mul2(r) ^ c[i];
  return r;
}

function dataToPoly(d: PolyseedData, checksum?: number): number[] {
  const c = new Array<number>(NUM_WORDS).fill(0);
  if (checksum !== undefined) c[0] = checksum;
  const extraVal = (d.features << DATE_BITS) | d.birthday;
  let extraBits = FEATURE_BITS + DATE_BITS;
  let idx = 0;
  let secretVal = d.secret[0];
  let secretBits = 8;
  let remBits = SECRET_BITS - 8;
  for (let i = 0; i < DATA_WORDS; ++i) {
    let wordBits = 0;
    let wordVal = 0;
    while (wordBits < SHARE_BITS) {
      if (secretBits === 0) {
        idx++;
        secretBits = Math.min(remBits, 8);
        secretVal = d.secret[idx];
        remBits -= secretBits;
      }
      const chunk = Math.min(secretBits, SHARE_BITS - wordBits);
      secretBits -= chunk;
      wordBits += chunk;
      wordVal = (wordVal << chunk) | ((secretVal >> secretBits) & ((1 << chunk) - 1));
    }
    wordVal <<= 1;
    extraBits--;
    wordVal |= (extraVal >> extraBits) & 1;
    c[1 + i] = wordVal;
  }
  return c;
}

function polyToData(c: number[]): PolyseedData {
  const secret = new Uint8Array(32);
  let extraVal = 0;
  let idx = 0;
  let secretBits = 0;
  for (let i = 1; i < NUM_WORDS; ++i) {
    let wordVal = c[i];
    extraVal = (extraVal << 1) | (wordVal & 1);
    wordVal >>= 1;
    let wordBits = GF_BITS - 1;
    while (wordBits > 0) {
      if (secretBits === 8) {
        idx++;
        secretBits = 0;
      }
      const chunk = Math.min(wordBits, 8 - secretBits);
      wordBits -= chunk;
      if (chunk < 8) secret[idx] = (secret[idx] << chunk) & 0xff;
      secret[idx] |= (wordVal >> wordBits) & ((1 << chunk) - 1);
      secretBits += chunk;
    }
  }
  return { birthday: extraVal & ((1 << DATE_BITS) - 1), features: extraVal >> DATE_BITS, secret, checksum: c[0] };
}

export class Polyseed {
  data: PolyseedData;

  private constructor(d: PolyseedData) {
    this.data = d;
  }

  /** Polyseed.create(): random secret, birthday = now, features 0 */
  static create(nowSec = Math.round(Date.now() / 1000), random?: Uint8Array): Polyseed {
    const secret = new Uint8Array(32);
    secret.set((random ?? crypto.getRandomValues(new Uint8Array(SECRET_SIZE))).slice(0, SECRET_SIZE));
    secret[SECRET_SIZE - 1] &= CLEAR_MASK;
    const d: PolyseedData = { birthday: birthdayEncode(nowSec), features: 0, secret, checksum: 0 };
    const c = dataToPoly(d);
    c[0] = evalPoly(c);
    d.checksum = c[0];
    return new Polyseed(d);
  }

  static async detectLanguage(phrase: string): Promise<PolyseedLang> {
    const p = phrase.trim().normalize('NFKD');
    for (const l of await languages()) {
      const words = (l.separator !== ' ' ? p.replace(/ /g, l.separator) : p).split(l.separator);
      if (words.every((w) => l.words.includes(w))) return l;
    }
    throw new Error('Unknown polyseed language');
  }

  static async isValidSeed(phrase: string): Promise<boolean> {
    try {
      const l = await Polyseed.detectLanguage(phrase);
      const p = l.separator !== ' ' ? phrase.trim().replace(/ /g, l.separator) : phrase.trim();
      return p.split(l.separator).length === NUM_WORDS;
    } catch {
      return false;
    }
  }

  static decode(phrase: string, lang: PolyseedLang, coin: PolyseedCoin = PolyseedCoin.MONERO): Polyseed {
    const p = phrase.trim().normalize('NFKD');
    const words = (lang.separator !== ' ' ? p.replace(/ /g, lang.separator) : p).split(lang.separator);
    if (words.length !== NUM_WORDS) throw new Error('A polyseed has 16 words');
    const c = words.map((w) => {
      let i = lang.words.indexOf(w);
      if (i < 0 && w.length >= 4) {
        // unambiguous 4+ letter prefix (polyseed C accepts these)
        const m = lang.words.map((x, j) => [x, j] as const).filter(([x]) => x.startsWith(w));
        if (m.length === 1) i = m[0][1];
      }
      if (i < 0) throw new Error(`Unknown word: ${w}`);
      return i;
    });
    c[1] ^= coin;
    if (evalPoly(c) !== 0) throw new Error('Polyseed checksum mismatch');
    const d = polyToData(c);
    if ((d.features & ((1 << FEATURE_BITS) - 1) & ~ENCRYPTED) !== 0) throw new Error('Unsupported polyseed features');
    return new Polyseed(d);
  }

  get isEncrypted(): boolean {
    return (this.data.features & ENCRYPTED) !== 0;
  }

  /** unix seconds */
  get birthday(): number {
    return birthdayDecode(this.data.birthday);
  }

  encode(lang: PolyseedLang = ENGLISH, coin: PolyseedCoin = PolyseedCoin.MONERO): string {
    const c = dataToPoly(this.data, this.data.checksum);
    c[1] ^= coin;
    return c.map((i) => lang.words[i]).join(lang.separator);
  }

  /** encrypt/decrypt with a passphrase (toggles the encrypted feature bit) */
  async crypt(password: string): Promise<void> {
    const salt = new Uint8Array(16);
    salt.set(new TextEncoder().encode('POLYSEED mask'), 0);
    salt[14] = 0xff;
    salt[15] = 0xff;
    const mask = await pbkdf2Async(sha256, new TextEncoder().encode(password), salt, { c: 10000, dkLen: 32 });
    for (let i = 0; i < SECRET_SIZE; i++) this.data.secret[i] ^= mask[i];
    this.data.secret[SECRET_SIZE - 1] &= CLEAR_MASK;
    this.data.features ^= ENCRYPTED;
    const c = dataToPoly(this.data);
    c[0] = evalPoly(c);
    this.data.checksum = c[0];
  }

  /** generateKey(coin, 32): the private spend key seed (reduce mod l for Monero) */
  async generateKey(coin: PolyseedCoin = PolyseedCoin.MONERO, keySize = 32): Promise<Uint8Array> {
    const salt = new Uint8Array(32);
    salt.set(new TextEncoder().encode('POLYSEED key'), 0);
    salt[13] = 0xff;
    salt[14] = 0xff;
    salt[15] = 0xff;
    const dv = new DataView(salt.buffer);
    dv.setUint32(16, coin, true);
    dv.setUint32(20, this.data.birthday, true);
    dv.setUint32(24, this.data.features, true);
    return pbkdf2Async(sha256, this.data.secret, salt, { c: 10000, dkLen: keySize });
  }

  clone(): Polyseed {
    return new Polyseed({ ...this.data, secret: this.data.secret.slice() });
  }
}

/** Monero's scalar group order l */
export const L = 2n ** 252n + 27742317777372353535851937790883648493n;

export function bytesToLE(b: Uint8Array): bigint {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]);
  return n;
}

export function leToBytes(n: bigint, len = 32): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** sc_reduce32 */
export function scReduce32(b: Uint8Array): Uint8Array {
  return leToBytes(bytesToLE(b) % L);
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
