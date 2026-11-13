// BIP-352 silent payments, the sending side (bitcoin_base's silent payment
// builder, as Cake's ElectrumWallet uses it): an sp1… address is decoded to its
// scan and spend keys, and each output key is derived from the transaction's
// inputs — so the outputs can only be made once the inputs are chosen.

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import { bech32m } from '@scure/base';

const Point = secp256k1.Point;
const N = Point.Fn.ORDER;
const mod = (a: bigint) => ((a % N) + N) % N;
const toBig = (b: Uint8Array) => BigInt(`0x${bytesToHex(b) || '0'}`);

const taggedHash = (tag: string, ...data: Uint8Array[]) => schnorr.utils.taggedHash(tag, concatBytes(...data));

export interface SilentAddress {
  scan: Uint8Array;
  spend: Uint8Array;
}

/** sp1… (mainnet) / tsp1… (testnet): version 0, the 33-byte scan key and the 33-byte spend key */
export function decodeSilentAddress(address: string, testnet = false): SilentAddress | null {
  try {
    const a = address.trim().toLowerCase();
    const { prefix, words } = bech32m.decode(a as `${string}1${string}`, 1023);
    if (prefix !== (testnet ? 'tsp' : 'sp') || !words.length) return null;
    const version = words[0];
    if (version === 31) return null;
    const data = bech32m.fromWords(words.slice(1));
    // future versions may append data; version 0 is exactly 66 bytes
    if (version === 0 && data.length !== 66) return null;
    if (data.length < 66) return null;
    const scan = data.slice(0, 33);
    const spend = data.slice(33, 66);
    Point.fromBytes(scan);
    Point.fromBytes(spend);
    return { scan, spend };
  } catch {
    return null;
  }
}

export const isSilentAddress = (address: string, testnet = false) => decodeSilentAddress(address, testnet) !== null;

export function encodeSilentAddress(scan: Uint8Array, spend: Uint8Array, testnet = false): string {
  return bech32m.encode(testnet ? 'tsp' : 'sp', [0, ...bech32m.toWords(concatBytes(scan, spend))], 1023);
}

export interface SilentInput {
  /** display (big-endian) txid */
  txid: string;
  vout: number;
  privkey: Uint8Array;
  /** P2TR key-path inputs use the x-only key with even y; P2WPKH, P2SH-P2WPKH and P2PKH their compressed key */
  taproot: boolean;
  /** inputs of other kinds (P2WSH…) still count for the smallest outpoint, not for the key sum */
  eligible?: boolean;
}

/** outpoint as serialized in a transaction: the txid little-endian, then the vout (4 bytes, little-endian) */
function outpointBytes(i: { txid: string; vout: number }): Uint8Array {
  const out = new Uint8Array(36);
  out.set(hexToBytes(i.txid).reverse(), 0);
  new DataView(out.buffer).setUint32(32, i.vout, true);
  return out;
}

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/**
 * The x-only output keys for the silent payment recipients, in recipient order. Recipients with the same scan key
 * share a shared secret and count k up; every input must be eligible (the wallet's inputs are).
 */
export function silentPaymentOutputs(inputs: SilentInput[], recipients: SilentAddress[]): Uint8Array[] {
  const eligible = inputs.filter((i) => i.eligible !== false);
  if (!eligible.length) throw new Error('Silent payments need at least one eligible input');
  let a = 0n;
  for (const i of eligible) {
    let d = toBig(i.privkey);
    if (i.taproot && Point.BASE.multiply(d).toAffine().y % 2n === 1n) d = N - d;
    a = mod(a + d);
  }
  if (a === 0n) throw new Error('Silent payments: the input keys sum to zero');
  const A = Point.BASE.multiply(a);
  const smallest = inputs.map(outpointBytes).sort(compare)[0];
  const inputHash = mod(toBig(taggedHash('BIP0352/Inputs', smallest, A.toBytes(true))));
  if (inputHash === 0n) throw new Error('Silent payments: invalid input hash');
  const counters = new Map<string, number>();
  const secrets = new Map<string, Uint8Array>();
  return recipients.map((r) => {
    const key = bytesToHex(r.scan);
    let ecdh = secrets.get(key);
    if (!ecdh) {
      ecdh = Point.fromBytes(r.scan).multiply(mod(inputHash * a)).toBytes(true);
      secrets.set(key, ecdh);
    }
    const k = counters.get(key) ?? 0;
    counters.set(key, k + 1);
    const kb = new Uint8Array(4);
    new DataView(kb.buffer).setUint32(0, k, false);
    const tk = mod(toBig(taggedHash('BIP0352/SharedSecret', ecdh, kb)));
    if (tk === 0n) throw new Error('Silent payments: invalid tweak');
    const P = Point.fromBytes(r.spend).add(Point.BASE.multiply(tk));
    return P.toBytes(true).slice(1);
  });
}

