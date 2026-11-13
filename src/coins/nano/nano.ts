// Nano primitives for the Nano wallet (what nanoutil / nanodart do for
// cw_nano): nano_ accounts (base32 + Blake2b-40 checksum), standard
// (Blake2b) and HD (SLIP-10 m/44'/165'/i') keys, Ed25519 with Blake2b-512,
// state block hashes and signatures, message signing, and the
// proof-of-work thresholds.

import { blake2b } from '@noble/hashes/blake2.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { eddsa } from '@noble/curves/abstract/edwards.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { slip10Ed25519 } from '../seeds/slip10.ts';
import { bip39Seed, bip39ToEntropy, entropyToBip39 } from '../seeds/bip39.ts';

export type NanoDerivation = 'nano' | 'bip39';

const ALPHABET = '13456789abcdefghijkmnopqrstuwxyz';

/** the default representative of new accounts (pref default_nano_representative) */
export const DEFAULT_REPRESENTATIVE = 'nano_38713x95zyjsqzx6nm1dsom1jmm668owkeb9913ax6nfgj15az3nu8xkx579';
/** link_as_account of a change block (an all-zero link) */
export const ZERO_LINK_ACCOUNT = 'nano_1111111111111111111111111111111111111111111111111111hifc8npp';
export const ZERO_HASH = '0'.repeat(64);
/** proof-of-work thresholds (epoch 2): send and change blocks, receive and open blocks */
export const SEND_THRESHOLD = 0xfffffff800000000n;
export const RECEIVE_THRESHOLD = 0xfffffe0000000000n;

/** Nano's Ed25519: SHA-512 replaced by BLAKE2b-512 */
const nacl = eddsa(ed25519.Point, blake2b as never, {
  adjustScalarBytes: (b: Uint8Array) => {
    b[0] &= 248;
    b[31] &= 127;
    b[31] |= 64;
    return b;
  },
} as never);

// -------------------------------------------------------------- accounts --

function encode(bytes: Uint8Array, bits: number): string {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  const s = v.toString(2).padStart(bits, '0');
  let out = '';
  for (let i = 0; i < bits; i += 5) out += ALPHABET[parseInt(s.slice(i, i + 5), 2)];
  return out;
}

function decode(s: string): bigint {
  let v = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error('Invalid Nano address');
    v = (v << 5n) | BigInt(i);
  }
  return v;
}

const checksum = (pub: Uint8Array) => encode(blake2b(pub, { dkLen: 5 }).reverse(), 40);

export function publicKeyToAddress(pub: Uint8Array): string {
  return `nano_${encode(pub, 260)}${checksum(pub)}`;
}

/** NanoAccounts.extractPublicKey (no checksum check) */
export function addressToPublicKey(address: string): Uint8Array {
  const m = /^(?:nano|xrb)_([13456789abcdefghijkmnopqrstuwxyz]{60})$/.exec(address.trim());
  if (!m) throw new Error('Invalid Nano address');
  const v = decode(m[1].slice(0, 52));
  if (v >> 256n) throw new Error('Invalid Nano address');
  return hexToBytes(v.toString(16).padStart(64, '0'));
}

/** NanoAccounts.isValid: the account pattern and its checksum */
export function isValidNanoAddress(address: string): boolean {
  const a = address.trim();
  if (!/^(xrb|nano)_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/.test(a)) return false;
  try {
    return checksum(addressToPublicKey(a)) === a.slice(-8);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ keys --

/** NanoKeys.seedToPrivate: Blake2b-256(seed || index, big-endian) */
export function standardSeedToPrivate(seedHex: string, index: number): string {
  const i = new Uint8Array(4);
  new DataView(i.buffer).setUint32(0, index, false);
  return bytesToHex(blake2b(concatBytes(hexToBytes(seedHex), i), { dkLen: 32 })).toUpperCase();
}

/** NanoDerivations.hdSeedToPrivate: SLIP-10 ed25519 m/44'/165'/index' */
export function hdSeedToPrivate(seedHex: string, index: number): string {
  return bytesToHex(slip10Ed25519(hexToBytes(seedHex), `m/44'/165'/${index}'`).key);
}

export function privateToPublic(privHex: string): Uint8Array {
  return nacl.getPublicKey(hexToBytes(privHex));
}

export const standardSeedToMnemonic = (seedHex: string): string => entropyToBip39(hexToBytes(seedHex));
export const standardMnemonicToSeed = (mnemonic: string): string => bytesToHex(bip39ToEntropy(mnemonic)).toUpperCase();

export function generateStandardSeed(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32))).toUpperCase();
}

export const isHexSeed = (s: string): boolean => /^[0-9a-fA-F]{64}$|^[0-9a-fA-F]{128}$/.test(s.trim());

/**
 * NanoWallet.init: the hex seed (standard: the mnemonic's entropy, uppercase; BIP39: its BIP39 seed
 * without passphrase, lowercase) and the keys of an account index.
 */
export async function nanoKeys(s: { mnemonic?: string; hexSeed?: string }, type: NanoDerivation, index = 0): Promise<{ hexSeed: string; privateKey: string; publicKey: Uint8Array; address: string }> {
  let hexSeed = s.hexSeed;
  if (!hexSeed) {
    if (!s.mnemonic) throw new Error('No seed for this wallet');
    hexSeed = type === 'nano' ? standardMnemonicToSeed(s.mnemonic) : bytesToHex(await bip39Seed(s.mnemonic));
  }
  const privateKey = type === 'nano' ? standardSeedToPrivate(hexSeed, index) : hdSeedToPrivate(hexSeed, index);
  const publicKey = privateToPublic(privateKey);
  return { hexSeed, privateKey, publicKey, address: publicKeyToAddress(publicKey) };
}

// ---------------------------------------------------------------- blocks --

export interface StateBlock {
  type: 'state';
  account: string;
  previous: string;
  representative: string;
  balance: string;
  link: string;
  link_as_account?: string;
  signature?: string;
  work?: string;
}

/** NanoBlocks.computeStateHash */
export function stateHash(b: { account: string; previous: string; representative: string; balance: string | bigint; link: string }): string {
  const preamble = new Uint8Array(32);
  preamble[31] = 6;
  const link = isValidNanoAddress(b.link) ? addressToPublicKey(b.link) : hexToBytes(b.link.padStart(64, '0'));
  const balance = hexToBytes(BigInt(b.balance).toString(16).padStart(32, '0'));
  return bytesToHex(blake2b(concatBytes(preamble, addressToPublicKey(b.account), hexToBytes(b.previous.padStart(64, '0')), addressToPublicKey(b.representative), balance, link), { dkLen: 32 })).toUpperCase();
}

/** NanoSignatures.signBlock */
export function signHash(hashHex: string, privHex: string): string {
  return bytesToHex(nacl.sign(hexToBytes(hashHex), hexToBytes(privHex))).toUpperCase();
}

export function verifyHash(hashHex: string, signatureHex: string, address: string): boolean {
  try {
    return nacl.verify(hexToBytes(signatureHex), hexToBytes(hashHex), addressToPublicKey(address));
  } catch {
    return false;
  }
}

/** NanoSignatures.hash: Blake2b-256 of the UTF-8 message, uppercase hex */
export function messageHash(message: string): string {
  return bytesToHex(blake2b(utf8ToBytes(message), { dkLen: 32 })).toUpperCase();
}

export const signMessage = (message: string, privHex: string): string => signHash(messageHash(message), privHex);
export const verifyMessage = (message: string, signatureHex: string, address: string): boolean => verifyHash(messageHash(message), signatureHex.trim(), address);

/** difficulty of a work value: Blake2b-64 of (work, little-endian) || root, as a little-endian uint64 */
export function workDifficulty(rootHex: string, workHex: string): bigint {
  const w = new Uint8Array(8);
  new DataView(w.buffer).setBigUint64(0, BigInt(`0x${workHex}`), true);
  const h = blake2b(concatBytes(w, hexToBytes(rootHex)), { dkLen: 8 });
  return new DataView(h.buffer, h.byteOffset, 8).getBigUint64(0, true);
}
