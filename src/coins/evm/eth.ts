// Ethereum primitives for the EVM wallets (what web3dart does for cw_evm):
// RLP, EIP-55 addresses, EIP-155 legacy and EIP-1559 (type 2) transactions,
// personal_sign messages, and the ERC-20 calls Cake uses.

import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';

export const hex = (b: Uint8Array): string => `0x${bytesToHex(b)}`;

export function unhex(s: string): Uint8Array {
  const h = s.startsWith('0x') || s.startsWith('0X') ? s.slice(2) : s;
  return hexToBytes(h.length % 2 ? `0${h}` : h);
}

export const keccak = (b: Uint8Array): Uint8Array => keccak_256(b);

/** minimal big-endian bytes (0 -> empty), as RLP wants integers */
export function bigBytes(n: bigint): Uint8Array {
  if (n < 0n) throw new Error('negative integer');
  if (n === 0n) return new Uint8Array(0);
  let h = n.toString(16);
  if (h.length % 2) h = `0${h}`;
  return hexToBytes(h);
}

export function toQuantity(n: bigint | number): string {
  return `0x${BigInt(n).toString(16)}`;
}

export function fromQuantity(q: string | null | undefined): bigint {
  if (!q || q === '0x') return 0n;
  return BigInt(q);
}

// ------------------------------------------------------------------- RLP --

export type RlpItem = Uint8Array | RlpItem[];

function rlpLength(len: number, offset: number): Uint8Array {
  if (len < 56) return Uint8Array.of(offset + len);
  const l = bigBytes(BigInt(len));
  return concatBytes(Uint8Array.of(offset + 55 + l.length), l);
}

export function rlpEncode(x: RlpItem): Uint8Array {
  if (x instanceof Uint8Array) {
    if (x.length === 1 && x[0] < 0x80) return x;
    return concatBytes(rlpLength(x.length, 0x80), x);
  }
  const body = concatBytes(...x.map(rlpEncode));
  return concatBytes(rlpLength(body.length, 0xc0), body);
}

export function rlpDecode(data: Uint8Array): RlpItem {
  const [item, rest] = decodeOne(data);
  if (rest.length) throw new Error('RLP: trailing bytes');
  return item;
}

function decodeOne(d: Uint8Array): [RlpItem, Uint8Array] {
  const p = d[0];
  if (p === undefined) throw new Error('RLP: empty input');
  const num = (b: Uint8Array) => b.reduce((a, x) => a * 256 + x, 0);
  if (p < 0x80) return [d.subarray(0, 1), d.subarray(1)];
  if (p < 0xb8) return [d.subarray(1, 1 + p - 0x80), d.subarray(1 + p - 0x80)];
  if (p < 0xc0) {
    const ll = p - 0xb7;
    const len = num(d.subarray(1, 1 + ll));
    return [d.subarray(1 + ll, 1 + ll + len), d.subarray(1 + ll + len)];
  }
  let len: number;
  let start: number;
  if (p < 0xf8) {
    len = p - 0xc0;
    start = 1;
  } else {
    const ll = p - 0xf7;
    len = num(d.subarray(1, 1 + ll));
    start = 1 + ll;
  }
  let body = d.subarray(start, start + len);
  const items: RlpItem[] = [];
  while (body.length) {
    const [it, rest] = decodeOne(body);
    items.push(it);
    body = rest;
  }
  return [items, d.subarray(start + len)];
}

// ------------------------------------------------------------- addresses --

export function isHexAddress(a: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(a.trim());
}

/** EIP-55 mixed-case checksum (EthereumAddress.hexEip55) */
export function checksumAddress(a: string): string {
  const lower = a.toLowerCase().replace(/^0x/, '');
  const h = bytesToHex(keccak(utf8ToBytes(lower)));
  let out = '0x';
  for (let i = 0; i < 40; i++) out += parseInt(h[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

/** a mixed-case address must carry a valid checksum; all-lower/all-upper ones are accepted as is */
export function isValidEvmAddress(a: string): boolean {
  const s = a.trim();
  if (!isHexAddress(s)) return false;
  const body = s.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  return checksumAddress(s) === s;
}

export function addressFromPrivateKey(priv: Uint8Array): string {
  const pub = secp256k1.getPublicKey(priv, false);
  return checksumAddress(hex(keccak(pub.subarray(1)).subarray(12)));
}

export function addressFromPublicKey(pubUncompressed: Uint8Array): string {
  return checksumAddress(hex(keccak(pubUncompressed.subarray(1)).subarray(12)));
}

// ---------------------------------------------------------- transactions --

export interface EvmTxRequest {
  chainId: number;
  nonce: bigint;
  to: string;
  value: bigint;
  data: Uint8Array;
  gasLimit: bigint;
  /** legacy (EIP-155) */
  gasPrice?: bigint;
  /** EIP-1559 */
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

function sign(hash: Uint8Array, priv: Uint8Array): { r: bigint; s: bigint; recovery: number } {
  const sig = secp256k1.sign(hash, priv, { prehash: false, lowS: true, format: 'recovered' });
  return { recovery: sig[0], r: BigInt(hex(sig.subarray(1, 33))), s: BigInt(hex(sig.subarray(33, 65))) };
}

/** Signs and serializes a transaction: type 2 when maxFeePerGas is set, else legacy EIP-155. */
export function signTransaction(tx: EvmTxRequest, priv: Uint8Array): { raw: Uint8Array; hash: string } {
  const to = unhex(tx.to);
  if (tx.maxFeePerGas !== undefined) {
    const fields: RlpItem[] = [
      bigBytes(BigInt(tx.chainId)),
      bigBytes(tx.nonce),
      bigBytes(tx.maxPriorityFeePerGas ?? 0n),
      bigBytes(tx.maxFeePerGas),
      bigBytes(tx.gasLimit),
      to,
      bigBytes(tx.value),
      tx.data,
      [],
    ];
    const unsigned = concatBytes(Uint8Array.of(2), rlpEncode(fields));
    const { r, s, recovery } = sign(keccak(unsigned), priv);
    const raw = concatBytes(Uint8Array.of(2), rlpEncode([...fields, bigBytes(BigInt(recovery)), bigBytes(r), bigBytes(s)]));
    return { raw, hash: hex(keccak(raw)) };
  }
  const base: RlpItem[] = [bigBytes(tx.nonce), bigBytes(tx.gasPrice ?? 0n), bigBytes(tx.gasLimit), to, bigBytes(tx.value), tx.data];
  const unsigned = rlpEncode([...base, bigBytes(BigInt(tx.chainId)), new Uint8Array(0), new Uint8Array(0)]);
  const { r, s, recovery } = sign(keccak(unsigned), priv);
  const v = BigInt(recovery) + BigInt(tx.chainId) * 2n + 35n;
  const raw = rlpEncode([...base, bigBytes(v), bigBytes(r), bigBytes(s)]);
  return { raw, hash: hex(keccak(raw)) };
}

// --------------------------------------------------------- personal_sign --

export function personalMessageHash(message: Uint8Array): Uint8Array {
  return keccak(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${message.length}`), message));
}

/** EthPrivateKey.signPersonalMessage: r || s || v (v = 27/28); Cake shows it as hex without 0x */
export function signPersonalMessage(message: string, priv: Uint8Array): string {
  const sig = secp256k1.sign(personalMessageHash(utf8ToBytes(message)), priv, { prehash: false, lowS: true, format: 'recovered' });
  return bytesToHex(concatBytes(sig.subarray(1, 65), Uint8Array.of(27 + sig[0])));
}

export function verifyPersonalMessage(message: string, signature: string, address: string): boolean {
  try {
    const b = unhex(signature.trim().toLowerCase());
    if (b.length !== 65) return false;
    const v = b[64] < 27 ? b[64] : b[64] - 27;
    if (v !== 0 && v !== 1) return false;
    const rec = concatBytes(Uint8Array.of(v), b.subarray(0, 64));
    const pub = secp256k1.recoverPublicKey(rec, personalMessageHash(utf8ToBytes(message)), { prehash: false });
    const full = secp256k1.Point.fromBytes(pub).toBytes(false);
    return addressFromPublicKey(full).toLowerCase() === address.trim().toLowerCase();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- ERC-20 --

const pad32 = (b: Uint8Array) => {
  const out = new Uint8Array(32);
  out.set(b, 32 - b.length);
  return out;
};

export const SELECTOR = {
  balanceOf: '70a08231',
  transfer: 'a9059cbb',
  approve: '095ea7b3',
  allowance: 'dd62ed3e',
  name: '06fdde03',
  symbol: '95d89b41',
  decimals: '313ce567',
} as const;

export type AbiArg = { address: string } | { uint: bigint } | { bool: boolean } | { bytes32: string };

/** a call of static arguments (address, uintN, bool, bytes32), each one 32-byte word */
export function encodeCall(selector: string, args: AbiArg[] = []): Uint8Array {
  const parts = args.map((a) => {
    if ('address' in a) return pad32(unhex(a.address));
    if ('uint' in a) return pad32(bigBytes(a.uint));
    if ('bool' in a) return pad32(Uint8Array.of(a.bool ? 1 : 0));
    const b = unhex(a.bytes32);
    if (b.length !== 32) throw new Error('bytes32 must be 32 bytes');
    return b;
  });
  return concatBytes(hexToBytes(selector), ...parts);
}

/** the 4-byte selector of a function signature, e.g. "save(uint192,bool)" */
export function selectorOf(signature: string): string {
  return bytesToHex(keccak_256(new TextEncoder().encode(signature)).subarray(0, 4));
}

/** the n-th 32-byte word of a call result, as an unsigned integer */
export function decodeWord(result: string, n = 0): bigint {
  const b = unhex(result || '0x');
  if (b.length < 32 * (n + 1)) return 0n;
  return BigInt(hex(b.subarray(32 * n, 32 * n + 32)));
}

export const erc20Transfer = (to: string, amount: bigint) => encodeCall(SELECTOR.transfer, [{ address: to }, { uint: amount }]);
export const erc20BalanceOf = (owner: string) => encodeCall(SELECTOR.balanceOf, [{ address: owner }]);

export function decodeUint(result: string): bigint {
  const b = unhex(result || '0x');
  if (!b.length) return 0n;
  return BigInt(hex(b.subarray(0, 32)));
}

/** ABI string, or a bytes32 (old tokens such as MKR) */
export function decodeString(result: string): string {
  const b = unhex(result || '0x');
  if (b.length === 32) return new TextDecoder().decode(b).replace(/\0+$/, '');
  if (b.length < 64) return '';
  const off = Number(BigInt(hex(b.subarray(0, 32))));
  const len = Number(BigInt(hex(b.subarray(off, off + 32))));
  return new TextDecoder().decode(b.subarray(off + 32, off + 32 + len)).replace(/\0+$/, '');
}

/** "0x" + hex of the memo's UTF-16 code units (cw_evm createTransaction: hexOpReturnMemo) */
export function memoData(memo: string): Uint8Array {
  return unhex(Array.from(memo, (c) => (c.charCodeAt(0) & 0xff).toString(16).padStart(2, '0')).join(''));
}
