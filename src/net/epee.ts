// Monero's binary RPC encoding ("epee portable storage"), used by
// /getblocks.bin and /gethashes.bin. Enough to read a message, change some
// fields and write it back (see scanPrefetch.ts).

export const T = {
  I64: 1, I32: 2, I16: 3, I8: 4, U64: 5, U32: 6, U16: 7, U8: 8,
  F64: 9, STR: 10, BOOL: 11, OBJ: 12, ARR: 13,
} as const;
const ARRAY_FLAG = 0x80;
const SIG_A = 0x01011101;
const SIG_B = 0x01020101;
const VERSION = 1;

export type Section = Map<string, Entry>;
/** type: a T code, or (T code | 0x80) for an array whose value is the element list */
export interface Entry {
  type: number;
  value: unknown;
}

const MAX_DEPTH = 64;

class Reader {
  #dv: DataView;
  #u8: Uint8Array;
  pos = 0;
  /** nested sections/arrays are walked but not kept (only array lengths) */
  #shallow: boolean;
  constructor(u8: Uint8Array, shallow = false) {
    this.#u8 = u8;
    this.#dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.#shallow = shallow;
  }
  #need(n: number) {
    if (this.pos + n > this.#u8.length) throw new Error('epee: truncated message');
  }
  get length(): number {
    return this.#u8.length;
  }
  u8(): number {
    this.#need(1);
    return this.#u8[this.pos++];
  }
  u32(): number {
    this.#need(4);
    const v = this.#dv.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  bytes(n: number): Uint8Array {
    this.#need(n);
    const v = this.#u8.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  varint(): number {
    this.#need(1);
    const mark = this.#u8[this.pos] & 3;
    let v: number;
    if (mark === 0) {
      v = this.#u8[this.pos] >>> 2;
      this.pos += 1;
    } else if (mark === 1) {
      this.#need(2);
      v = this.#dv.getUint16(this.pos, true) >>> 2;
      this.pos += 2;
    } else if (mark === 2) {
      this.#need(4);
      v = this.#dv.getUint32(this.pos, true) >>> 2;
      this.pos += 4;
    } else {
      this.#need(8);
      const big = this.#dv.getBigUint64(this.pos, true) >> 2n;
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('epee: varint too large');
      v = Number(big);
      this.pos += 8;
    }
    return v;
  }
  scalar(type: number, depth: number): unknown {
    const dv = this.#dv;
    const at = (n: number) => {
      this.#need(n);
      const p = this.pos;
      this.pos += n;
      return p;
    };
    switch (type) {
      case T.I64: return dv.getBigInt64(at(8), true);
      case T.I32: return dv.getInt32(at(4), true);
      case T.I16: return dv.getInt16(at(2), true);
      case T.I8: return dv.getInt8(at(1));
      case T.U64: return dv.getBigUint64(at(8), true);
      case T.U32: return dv.getUint32(at(4), true);
      case T.U16: return dv.getUint16(at(2), true);
      case T.U8: return dv.getUint8(at(1));
      case T.F64: return dv.getFloat64(at(8), true);
      case T.BOOL: return dv.getUint8(at(1)) !== 0;
      case T.STR: return this.bytes(this.varint());
      case T.OBJ: return this.section(depth + 1);
      case T.ARR: return this.array(this.u8(), depth + 1);
      default: throw new Error(`epee: unknown type ${type}`);
    }
  }
  array(typeWithFlag: number, depth: number): Entry {
    if (!(typeWithFlag & ARRAY_FLAG)) throw new Error('epee: expected an array');
    const elem = typeWithFlag & ~ARRAY_FLAG;
    const n = this.varint();
    if (n > this.#u8.length - this.pos) throw new Error('epee: bad array size');
    if (this.#shallow) {
      for (let i = 0; i < n; i++) this.scalar(elem, depth);
      return { type: typeWithFlag, value: { length: n } };
    }
    const out: unknown[] = new Array(n);
    for (let i = 0; i < n; i++) out[i] = this.scalar(elem, depth);
    return { type: typeWithFlag, value: out };
  }
  section(depth = 0): Section {
    if (depth > MAX_DEPTH) throw new Error('epee: too deeply nested');
    const n = this.varint();
    const keep = !(this.#shallow && depth > 0);
    const sec: Section = new Map();
    for (let i = 0; i < n; i++) {
      const nameBytes = this.bytes(this.u8());
      const type = this.u8();
      const e = type & ARRAY_FLAG ? this.array(type, depth) : { type, value: this.scalar(type, depth) };
      if (keep) sec.set(new TextDecoder().decode(nameBytes), e);
    }
    return sec;
  }
}

export function decode(buf: Uint8Array): Section {
  return read(new Reader(buf));
}

/**
 * Top-level fields only, for reading big answers: nested values are checked
 * but not built, and arrays only report their length (arrayLength works).
 */
export function decodeShallow(buf: Uint8Array): Section {
  return read(new Reader(buf, true));
}

function read(r: Reader): Section {
  if (r.u32() !== SIG_A || r.u32() !== SIG_B || r.u8() !== VERSION) throw new Error('epee: not a portable storage message');
  const sec = r.section();
  if (r.pos !== r.length) throw new Error('epee: trailing data');
  return sec;
}

class Writer {
  #chunks: Uint8Array[] = [];
  #len = 0;
  push(b: Uint8Array) {
    this.#chunks.push(b);
    this.#len += b.length;
  }
  fixed(n: number, fn: (dv: DataView) => void) {
    const b = new Uint8Array(n);
    fn(new DataView(b.buffer));
    this.push(b);
  }
  varint(v: number) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error('epee: bad varint');
    if (v <= 63) this.fixed(1, (d) => d.setUint8(0, v << 2));
    else if (v <= 16383) this.fixed(2, (d) => d.setUint16(0, (v << 2) | 1, true));
    else if (v <= 1073741823) this.fixed(4, (d) => d.setUint32(0, ((v << 2) | 2) >>> 0, true));
    else this.fixed(8, (d) => d.setBigUint64(0, (BigInt(v) << 2n) | 3n, true));
  }
  scalar(type: number, v: unknown) {
    switch (type) {
      case T.I64: return this.fixed(8, (d) => d.setBigInt64(0, BigInt(v as bigint), true));
      case T.I32: return this.fixed(4, (d) => d.setInt32(0, v as number, true));
      case T.I16: return this.fixed(2, (d) => d.setInt16(0, v as number, true));
      case T.I8: return this.fixed(1, (d) => d.setInt8(0, v as number));
      case T.U64: return this.fixed(8, (d) => d.setBigUint64(0, BigInt(v as bigint), true));
      case T.U32: return this.fixed(4, (d) => d.setUint32(0, v as number, true));
      case T.U16: return this.fixed(2, (d) => d.setUint16(0, v as number, true));
      case T.U8: return this.fixed(1, (d) => d.setUint8(0, v as number));
      case T.F64: return this.fixed(8, (d) => d.setFloat64(0, v as number, true));
      case T.BOOL: return this.fixed(1, (d) => d.setUint8(0, v ? 1 : 0));
      case T.STR: {
        const b = v as Uint8Array;
        this.varint(b.length);
        return this.push(b);
      }
      case T.OBJ: return this.section(v as Section);
      case T.ARR: {
        const e = v as Entry;
        this.push(Uint8Array.of(e.type));
        return this.array(e);
      }
      default: throw new Error(`epee: unknown type ${type}`);
    }
  }
  array(e: Entry) {
    const items = e.value as unknown[];
    this.varint(items.length);
    for (const it of items) this.scalar(e.type & ~ARRAY_FLAG, it);
  }
  section(sec: Section) {
    this.varint(sec.size);
    for (const [name, e] of sec) {
      const nb = new TextEncoder().encode(name);
      if (nb.length > 255) throw new Error('epee: name too long');
      this.push(Uint8Array.of(nb.length));
      this.push(nb);
      this.push(Uint8Array.of(e.type));
      if (e.type & ARRAY_FLAG) this.array(e);
      else this.scalar(e.type, e.value);
    }
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.#len);
    let o = 0;
    for (const c of this.#chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }
}

export function encode(sec: Section): Uint8Array {
  const w = new Writer();
  w.fixed(9, (d) => {
    d.setUint32(0, SIG_A, true);
    d.setUint32(4, SIG_B, true);
    d.setUint8(8, VERSION);
  });
  w.section(sec);
  return w.bytes();
}

// ---------------------------------------------------------------- helpers --

export function getBlob(sec: Section, name: string): Uint8Array | undefined {
  const e = sec.get(name);
  return e && e.type === T.STR ? (e.value as Uint8Array) : undefined;
}

/** Any unsigned/signed integer field as a number. */
export function getNum(sec: Section, name: string): number | undefined {
  const e = sec.get(name);
  if (!e || e.type & ARRAY_FLAG) return undefined;
  if (typeof e.value === 'bigint') return Number(e.value);
  return typeof e.value === 'number' ? e.value : undefined;
}

export function getString(sec: Section, name: string): string | undefined {
  const b = getBlob(sec, name);
  return b && new TextDecoder().decode(b);
}

export function arrayLength(sec: Section, name: string): number | undefined {
  const e = sec.get(name);
  return e && e.type & ARRAY_FLAG ? (e.value as { length: number }).length : undefined;
}

/** A copy of the section with some fields set (existing ones keep their position). */
export function withFields(sec: Section, fields: Record<string, Entry>): Section {
  const out = new Map(sec);
  for (const [k, v] of Object.entries(fields)) out.set(k, v);
  return out;
}
