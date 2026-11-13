// Solana primitives for the Solana wallet (what on_chain does for cw_solana):
// addresses, program-derived / associated token addresses, legacy and v0
// messages, the System / SPL Token / Associated Token Account instructions,
// ed25519 signing, and the Metaplex metadata layout.

import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { base58 } from '@scure/base';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
/** SolanaTokenAccountUtils.accountSize: the rent buffer every send keeps */
export const TOKEN_ACCOUNT_SIZE = 165;

export function decodeAddress(a: string): Uint8Array {
  const b = base58.decode(a.trim());
  if (b.length !== 32) throw new Error('Invalid Solana address');
  return b;
}

export const encodeAddress = (b: Uint8Array): string => base58.encode(b);

export function isValidSolAddress(a: string): boolean {
  try {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a.trim()) && decodeAddress(a).length === 32;
  } catch {
    return false;
  }
}

/** a point of the ed25519 curve (wallets) rather than a program-derived address */
export function isOnCurve(b: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(b, true);
    return true;
  } catch {
    return false;
  }
}

export function publicKeyOf(seed: Uint8Array): string {
  return encodeAddress(ed25519.getPublicKey(seed));
}

export function findProgramAddress(seeds: Uint8Array[], programId: string): { address: string; bump: number } {
  const pid = decodeAddress(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(concatBytes(...seeds, Uint8Array.of(bump), pid, utf8ToBytes('ProgramDerivedAddress')));
    if (!isOnCurve(h)) return { address: encodeAddress(h), bump };
  }
  throw new Error('Unable to find a viable program address');
}

export function associatedTokenAddress(owner: string, mint: string, tokenProgram = TOKEN_PROGRAM): string {
  return findProgramAddress([decodeAddress(owner), decodeAddress(tokenProgram), decodeAddress(mint)], ATA_PROGRAM).address;
}

export function metadataAddress(mint: string): string {
  return findProgramAddress([utf8ToBytes('metadata'), decodeAddress(METADATA_PROGRAM), decodeAddress(mint)], METADATA_PROGRAM).address;
}

// -------------------------------------------------------------- messages --

export interface AccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface Instruction {
  programId: string;
  keys: AccountMeta[];
  data: Uint8Array;
}

/** compact-u16 ("shortvec") length prefix */
export function shortvec(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return Uint8Array.from(out);
    }
    out.push(b | 0x80);
  }
}

export function u64le(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
}

/** Message.compile: fee payer first, then writable signers, readonly signers, writable and readonly accounts */
export function compileMessage(instructions: Instruction[], payer: string, recentBlockhash: string, version: 'legacy' | 0 = 'legacy'): { bytes: Uint8Array; keys: string[] } {
  const metas = new Map<string, { signer: boolean; writable: boolean }>();
  const order: string[] = [];
  const add = (k: string, signer: boolean, writable: boolean) => {
    const e = metas.get(k);
    if (e) {
      e.signer ||= signer;
      e.writable ||= writable;
    } else {
      metas.set(k, { signer, writable });
      order.push(k);
    }
  };
  add(payer, true, true);
  for (const ix of instructions) {
    add(ix.programId, false, false);
    for (const m of ix.keys) add(m.pubkey, m.isSigner, m.isWritable);
  }
  const rank = (k: string) => {
    const m = metas.get(k)!;
    return m.signer ? (m.writable ? 0 : 1) : m.writable ? 2 : 3;
  };
  const keys = [payer, ...order.slice(1).sort((a, b) => rank(a) - rank(b))];
  const signers = keys.filter((k) => metas.get(k)!.signer);
  const header = Uint8Array.of(signers.length, signers.filter((k) => !metas.get(k)!.writable).length, keys.filter((k) => !metas.get(k)!.signer && !metas.get(k)!.writable).length);
  const index = new Map(keys.map((k, i) => [k, i]));
  const ixBytes = instructions.map((ix) => concatBytes(Uint8Array.of(index.get(ix.programId)!), shortvec(ix.keys.length), Uint8Array.from(ix.keys.map((m) => index.get(m.pubkey)!)), shortvec(ix.data.length), ix.data));
  const body = concatBytes(header, shortvec(keys.length), ...keys.map(decodeAddress), decodeAddress(recentBlockhash), shortvec(instructions.length), ...ixBytes);
  return { bytes: version === 0 ? concatBytes(Uint8Array.of(0x80), body, shortvec(0)) : body, keys };
}

/** a compact-u16 ("shortvec") at `at`: its value and byte length */
export function readShortvec(b: Uint8Array, at: number): [number, number] {
  let v = 0;
  for (let i = 0; i < 3; i++) {
    const x = b[at + i];
    if (x === undefined) throw new Error('Invalid transaction');
    v |= (x & 0x7f) << (7 * i);
    if (!(x & 0x80)) return [v, i + 1];
  }
  throw new Error('Invalid transaction');
}

/**
 * Sign a serialized transaction built by someone else (legacy or v0 message): our signature goes into the slot of
 * our key among the message's signers. Returns the signed transaction and its id (the first signature).
 */
export function signSerializedTransaction(tx: Uint8Array, seed: Uint8Array): { tx: Uint8Array; signature: string } {
  const [count, len] = readShortvec(tx, 0);
  const msgAt = len + 64 * count;
  const message = tx.subarray(msgAt);
  if (!message.length) throw new Error('Invalid transaction');
  let i = message[0] & 0x80 ? 1 : 0;
  const required = message[i];
  i += 3;
  const [nKeys, kl] = readShortvec(message, i);
  i += kl;
  const me = publicKeyOf(seed);
  let slot = -1;
  for (let k = 0; k < Math.min(required, nKeys); k++) {
    if (encodeAddress(message.subarray(i + 32 * k, i + 32 * k + 32)) === me) slot = k;
  }
  if (slot < 0 || slot >= count) throw new Error('This transaction is not for this wallet');
  const out = tx.slice();
  out.set(ed25519.sign(message, seed), len + 64 * slot);
  return { tx: out, signature: base58.encode(out.subarray(len, len + 64)) };
}

/** a transaction with a single signer (the fee payer) */
export function signMessage(message: Uint8Array, seed: Uint8Array): { tx: Uint8Array; signature: string } {
  const sig = ed25519.sign(message, seed);
  return { tx: concatBytes(shortvec(1), sig, message), signature: base58.encode(sig) };
}

// ---------------------------------------------------------- instructions --

export function systemTransfer(from: string, to: string, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  new DataView(data.buffer).setUint32(0, 2, true);
  data.set(u64le(lamports), 4);
  return { programId: SYSTEM_PROGRAM, keys: [{ pubkey: from, isSigner: true, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }], data };
}

export function transferChecked(o: { tokenProgram: string; source: string; mint: string; destination: string; owner: string; amount: bigint; decimals: number }): Instruction {
  return {
    programId: o.tokenProgram,
    keys: [
      { pubkey: o.source, isSigner: false, isWritable: true },
      { pubkey: o.mint, isSigner: false, isWritable: false },
      { pubkey: o.destination, isSigner: false, isWritable: true },
      { pubkey: o.owner, isSigner: true, isWritable: false },
    ],
    data: concatBytes(Uint8Array.of(12), u64le(o.amount), Uint8Array.of(o.decimals)),
  };
}

/** SPL Token CloseAccount (9): the account's lamports go to the destination */
export function closeAccount(o: { tokenProgram: string; account: string; destination: string; owner: string }): Instruction {
  return {
    programId: o.tokenProgram,
    keys: [
      { pubkey: o.account, isSigner: false, isWritable: true },
      { pubkey: o.destination, isSigner: false, isWritable: true },
      { pubkey: o.owner, isSigner: true, isWritable: false },
    ],
    data: Uint8Array.of(9),
  };
}

/** a token account's amount (the u64 after its mint and owner) */
export function tokenAccountAmount(data: Uint8Array): bigint | null {
  if (data.length < 72) return null;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(64, true);
}

/** AssociatedTokenAccountProgram.associatedTokenAccountIdempotent */
export function createAtaIdempotent(o: { payer: string; ata: string; owner: string; mint: string; tokenProgram: string }): Instruction {
  return {
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: o.payer, isSigner: true, isWritable: true },
      { pubkey: o.ata, isSigner: false, isWritable: true },
      { pubkey: o.owner, isSigner: false, isWritable: false },
      { pubkey: o.mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: o.tokenProgram, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.of(1),
  };
}

// --------------------------------------------------------- messages (sign) --

export function signText(message: string, seed: Uint8Array): string {
  return base58.encode(ed25519.sign(utf8ToBytes(message), seed));
}

export function verifyText(message: string, signature: string, address: string): boolean {
  try {
    return ed25519.verify(base58.decode(signature.trim()), utf8ToBytes(message), decodeAddress(address));
  } catch {
    return false;
  }
}

// --------------------------------------------------------------- metaplex --

/** Metaplex token metadata account: key, update authority, mint, then name / symbol / uri (borsh strings, NUL-padded) */
export function parseMetadataAccount(data: Uint8Array): { name: string; symbol: string; uri: string; mint: string } | null {
  try {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let off = 1 + 32;
    const mint = encodeAddress(data.subarray(off, off + 32));
    off += 32;
    const str = () => {
      const len = dv.getUint32(off, true);
      off += 4;
      const s = new TextDecoder().decode(data.subarray(off, off + len)).replace(/\0/g, '').trim();
      off += len;
      return s;
    };
    const name = str();
    const symbol = str();
    const uri = str();
    return { name, symbol, uri, mint };
  } catch {
    return null;
  }
}
