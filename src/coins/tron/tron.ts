// Tron primitives for the Tron wallet (what on_chain / blockchain_utils do for
// cw_tron): base58check addresses, the protobuf encoding of transactions (whose
// SHA-256 is the transaction id), secp256k1 signatures, TRON personal messages
// and the TRC-20 calls Cake uses.

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { createBase58check } from '@scure/base';
import { encodeCall, SELECTOR } from '../evm/eth.ts';

const b58c = createBase58check(sha256);

// -------------------------------------------------------------- addresses --

export function addressFromPublicKey(pub: Uint8Array): string {
  const full = pub.length === 65 ? pub : secp256k1.Point.fromBytes(pub).toBytes(false);
  return b58c.encode(concatBytes(Uint8Array.of(0x41), keccak_256(full.subarray(1)).subarray(12)));
}

export function addressFromPrivateKey(priv: Uint8Array): string {
  return addressFromPublicKey(secp256k1.getPublicKey(priv, false));
}

/** 21 bytes (0x41 || 20) from a base58 ("T…") or hex ("41…") address */
export function decodeTronAddress(a: string): Uint8Array {
  const v = a.trim();
  if (/^41[0-9a-fA-F]{40}$/.test(v)) return hexToBytes(v);
  const b = b58c.decode(v);
  if (b.length !== 21 || b[0] !== 0x41) throw new Error('Invalid Tron address');
  return b;
}

export function isValidTronAddress(a: string): boolean {
  try {
    return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a.trim()) && decodeTronAddress(a).length === 21;
  } catch {
    return false;
  }
}

export function toBase58(a: string): string {
  return b58c.encode(decodeTronAddress(a));
}

/** the EVM-style 20-byte address of a Tron address ("0x…"), as TRC-20 calls take it */
export function toEvmAddress(a: string): string {
  return `0x${bytesToHex(decodeTronAddress(a).subarray(1))}`;
}

// --------------------------------------------------------------- protobuf --

function varint(n: bigint): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return out;
}

const tag = (field: number, wire: number) => varint(BigInt((field << 3) | wire));

/** proto3: zero / empty values are not written */
function fInt(field: number, v: bigint | number | string | null | undefined): number[] {
  if (v === null || v === undefined || v === '') return [];
  const n = BigInt(v);
  if (n === 0n) return [];
  if (n < 0n) throw new Error('negative protobuf integer');
  return [...tag(field, 0), ...varint(n)];
}

function fBytes(field: number, b: Uint8Array | null | undefined): number[] {
  if (!b || !b.length) return [];
  return [...tag(field, 2), ...varint(BigInt(b.length)), ...b];
}

const pb = (...parts: number[][]) => Uint8Array.from(parts.flat());
const hexOpt = (h?: string | null) => (h ? hexToBytes(h.replace(/^0x/, '')) : undefined);

/** TransactionContractType values of the contracts Cake builds or reads */
export const CONTRACT_TYPES: Record<string, number> = { TransferContract: 1, TransferAssetContract: 2, TriggerSmartContract: 31 };

export interface RawContractJson {
  type: string;
  parameter: { type_url: string; value: Record<string, any> };
  Permission_id?: number;
}

export interface RawDataJson {
  ref_block_bytes: string;
  ref_block_num?: number;
  ref_block_hash: string;
  expiration: number;
  data?: string;
  contract: RawContractJson[];
  scripts?: string;
  timestamp: number;
  fee_limit?: number;
}

function contractValue(type: string, v: Record<string, any>): Uint8Array {
  const addr = (x?: string) => (x ? decodeTronAddress(x) : undefined);
  switch (type) {
    case 'TransferContract':
      return pb(fBytes(1, addr(v.owner_address)), fBytes(2, addr(v.to_address)), fInt(3, v.amount));
    case 'TriggerSmartContract':
      return pb(fBytes(1, addr(v.owner_address)), fBytes(2, addr(v.contract_address)), fInt(3, v.call_value), fBytes(4, hexOpt(v.data)), fInt(5, v.call_token_value), fInt(6, v.token_id));
    default:
      throw new Error(`Unsupported Tron contract ${type}`);
  }
}

/** TransactionRaw.toBuffer for the transfer / smart-contract transactions this wallet signs */
export function encodeRawData(r: RawDataJson): Uint8Array {
  const contracts = r.contract.map((c) => {
    const any = pb(fBytes(1, utf8ToBytes(c.parameter.type_url)), fBytes(2, contractValue(c.type, c.parameter.value)));
    return pb(fInt(1, CONTRACT_TYPES[c.type] ?? 0), fBytes(2, any), fInt(5, c.Permission_id));
  });
  return pb(
    fBytes(1, hexOpt(r.ref_block_bytes)),
    fInt(3, r.ref_block_num),
    fBytes(4, hexOpt(r.ref_block_hash)),
    fInt(8, r.expiration),
    fBytes(10, hexOpt(r.data)),
    ...contracts.map((c) => fBytes(11, c)),
    fBytes(12, hexOpt(r.scripts)),
    fInt(14, r.timestamp),
    fInt(18, r.fee_limit),
  );
}

/** fee_limit (field 18, the last one) added to raw bytes that do not have it */
export function withFeeLimit(raw: Uint8Array, feeLimit: bigint): Uint8Array {
  return concatBytes(raw, Uint8Array.from(fInt(18, feeLimit)));
}

export const txId = (raw: Uint8Array): string => bytesToHex(sha256(raw));

/** Transaction.toBuffer: raw data + signatures */
export function encodeTransaction(raw: Uint8Array, signatures: Uint8Array[]): Uint8Array {
  return pb(fBytes(1, raw), ...signatures.map((s) => fBytes(2, s)));
}

/** the reference block of a transaction, from /wallet/getnowblock (TransactionRaw.refBlockBytes / refBlockHash) */
export function refBlock(block: { blockID: string; block_header: { raw_data: { number: number; timestamp: number } } }): { ref_block_bytes: string; ref_block_hash: string; timestamp: number } {
  const n = BigInt(block.block_header.raw_data.number).toString(16).padStart(16, '0');
  return { ref_block_bytes: n.slice(12, 16), ref_block_hash: block.blockID.slice(16, 32), timestamp: block.block_header.raw_data.timestamp };
}

// ------------------------------------------------------------- signatures --

function signDigest(digest: Uint8Array, priv: Uint8Array): Uint8Array {
  const sig = secp256k1.sign(digest, priv, { prehash: false, lowS: true, format: 'recovered' });
  return concatBytes(sig.subarray(1, 65), Uint8Array.of(sig[0] + 27));
}

/** TronPrivateKey.sign: r || s || v (27/28) over SHA-256 of the raw data */
export function signTransaction(raw: Uint8Array, priv: Uint8Array): Uint8Array {
  return signDigest(sha256(raw), priv);
}

const PERSONAL_PREFIX = '\x19TRON Signed Message:\n';

function personalDigest(message: Uint8Array): Uint8Array {
  return keccak_256(concatBytes(utf8ToBytes(`${PERSONAL_PREFIX}${message.length}`), message));
}

/** TronPrivateKey.signPersonalMessage: hex (no 0x) of r || s || v */
export function signPersonalMessage(message: string, priv: Uint8Array): string {
  return bytesToHex(signDigest(personalDigest(utf8ToBytes(message)), priv));
}

export function verifyPersonalMessage(message: string, signature: string, address: string): boolean {
  try {
    const b = hexToBytes(signature.trim().replace(/^0x/, ''));
    if (b.length !== 65) return false;
    const v = b[64] >= 27 ? b[64] - 27 : b[64];
    if (v !== 0 && v !== 1) return false;
    const pub = secp256k1.recoverPublicKey(concatBytes(Uint8Array.of(v), b.subarray(0, 64)), personalDigest(utf8ToBytes(message)), { prehash: false });
    return addressFromPublicKey(pub) === address.trim();
  } catch {
    return false;
  }
}

// ----------------------------------------------------------------- TRC-20 --

const strip0x = (b: Uint8Array) => bytesToHex(b);

export const trc20Transfer = (to: string, amount: bigint): string => strip0x(encodeCall(SELECTOR.transfer, [{ address: toEvmAddress(to) }, { uint: amount }]));
export const trc20BalanceOf = (owner: string): string => strip0x(encodeCall(SELECTOR.balanceOf, [{ address: toEvmAddress(owner) }]));
export const trc20Call = (selector: string): string => selector;

/** Value.isTrc20TransferCall / receiverAddress / txAmount (tron_transaction_model.dart) */
export function decodeTrc20Transfer(data?: string): { to: string; amount: bigint } | null {
  const d = (data ?? '').toLowerCase().replace(/^0x/, '');
  if (d.length < 136 || !d.startsWith('a9059cbb')) return null;
  return { to: b58c.encode(concatBytes(Uint8Array.of(0x41), hexToBytes(d.slice(32, 72)))), amount: BigInt(`0x${d.slice(72, 136)}`) };
}
