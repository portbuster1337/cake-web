// Bitcoin Cash transactions: legacy serialization, P2PKH inputs signed with
// SIGHASH_ALL|SIGHASH_FORKID (0x41) over the BIP143-style digest that BCH
// adopted at the fork (replay protection).

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hex } from '@scure/base';
import { addressToScript, hash160, NETWORKS } from './networks.ts';
import type { SpendInput, SpendOutput } from './txbuilder.ts';

const SIGHASH_ALL_FORKID = 0x41;

const dsha = (b: Uint8Array) => sha256(sha256(b));

class W {
  parts: number[] = [];
  u8(v: number) {
    this.parts.push(v & 0xff);
  }
  u32(v: number) {
    for (let i = 0; i < 4; i++) this.parts.push((v >>> (8 * i)) & 0xff);
  }
  u64(v: bigint) {
    for (let i = 0n; i < 8n; i++) this.parts.push(Number((v >> (8n * i)) & 0xffn));
  }
  varint(n: number) {
    if (n < 0xfd) this.u8(n);
    else if (n <= 0xffff) {
      this.u8(0xfd);
      this.u8(n & 0xff);
      this.u8(n >> 8);
    } else {
      this.u8(0xfe);
      this.u32(n);
    }
  }
  bytes(b: Uint8Array) {
    for (const x of b) this.parts.push(x);
  }
  varbytes(b: Uint8Array) {
    this.varint(b.length);
    this.bytes(b);
  }
  out(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

const txidLE = (txid: string) => hex.decode(txid).reverse();

export function bchSighash(inputs: { txid: string; vout: number; sequence: number; value: bigint; scriptCode: Uint8Array }[], outputs: { script: Uint8Array; value: bigint }[], index: number, version: number, locktime: number, hashType = SIGHASH_ALL_FORKID): Uint8Array {
  const prev = new W();
  for (const i of inputs) {
    prev.bytes(txidLE(i.txid));
    prev.u32(i.vout);
  }
  const seq = new W();
  for (const i of inputs) seq.u32(i.sequence);
  const outs = new W();
  for (const o of outputs) {
    outs.u64(o.value);
    outs.varbytes(o.script);
  }
  const me = inputs[index];
  const w = new W();
  w.u32(version);
  w.bytes(dsha(prev.out()));
  w.bytes(dsha(seq.out()));
  w.bytes(txidLE(me.txid));
  w.u32(me.vout);
  w.varbytes(me.scriptCode);
  w.u64(me.value);
  w.u32(me.sequence);
  w.bytes(dsha(outs.out()));
  w.u32(locktime);
  w.u32(hashType);
  return dsha(w.out());
}

export function buildBchTransaction(inputs: SpendInput[], outputs: SpendOutput[], opts: { locktime: number }): { hex: string; txid: string; vsize: number } {
  const version = 2;
  const sequence = opts.locktime > 0 ? 0xfffffffe : 0xffffffff;
  const outs = outputs.map((o) => ({ script: addressToScript(NETWORKS.bch, o.address), value: o.value }));
  const ins = inputs.map((i) => {
    const h = hash160(i.pubkey);
    const scriptCode = Uint8Array.from([0x76, 0xa9, 0x14, ...h, 0x88, 0xac]);
    return { txid: i.txid, vout: i.vout, sequence, value: i.value, scriptCode };
  });
  const scriptSigs = inputs.map((inp, idx) => {
    const digest = bchSighash(ins, outs, idx, version, opts.locktime);
    const sig = secp256k1.sign(digest, inp.privkey, { prehash: false, lowS: true, format: 'der' });
    const s = new W();
    s.varbytes(Uint8Array.from([...sig, SIGHASH_ALL_FORKID]));
    s.varbytes(inp.pubkey);
    return s.out();
  });
  const w = new W();
  w.u32(version);
  w.varint(ins.length);
  ins.forEach((i, idx) => {
    w.bytes(txidLE(i.txid));
    w.u32(i.vout);
    w.varbytes(scriptSigs[idx]);
    w.u32(i.sequence);
  });
  w.varint(outs.length);
  for (const o of outs) {
    w.u64(o.value);
    w.varbytes(o.script);
  }
  w.u32(opts.locktime);
  const raw = w.out();
  return { hex: hex.encode(raw), txid: hex.encode(dsha(raw).reverse()), vsize: raw.length };
}
