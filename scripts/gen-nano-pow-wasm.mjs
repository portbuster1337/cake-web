// Generates src/coins/nano/powWasm.gen.ts: Nano's proof-of-work search as a
// tiny WebAssembly module, assembled here byte by byte (no toolchain needed).
// Work w is valid for a root when the 8-byte BLAKE2b of (w as 8 little-endian
// bytes) || root, read as a little-endian uint64, is at least the threshold.
//
//   search(start: i64, count: i32, threshold: i64) -> i32
//     memory[0..32]  the root (written by the caller)
//     memory[32..40] the work found, or the next work to try
//     memory[40..48] the difficulty of the work found
//
//   node scripts/gen-nano-pow-wasm.mjs
import fs from 'node:fs';
import path from 'node:path';

const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];
const IV = [0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n, 0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n];
/** h0 = IV0 ^ parameter block (8-byte digest, no key, fanout and depth 1) */
const H0 = IV[0] ^ 0x01010008n;
const MASK64 = (1n << 64n) - 1n;

function uleb(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

function sleb64(v) {
  let x = BigInt.asIntN(64, BigInt(v));
  const out = [];
  for (;;) {
    const b = Number(x & 0x7fn);
    x >>= 7n;
    if ((x === 0n && !(b & 0x40)) || (x === -1n && b & 0x40)) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

const sleb32 = (v) => sleb64(BigInt(v | 0));
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, bytes) => [id, ...uleb(bytes.length), ...bytes];
const name = (s) => vec([...Buffer.from(s, 'utf8')].map((b) => [b]));

const I32 = 0x7f;
const I64 = 0x7e;
// locals: 0 start, 1 count, 2 threshold | 3 w, 4..7 m1..m4, 8..23 v0..v15, 24 d
const P_START = 0;
const P_COUNT = 1;
const P_THR = 2;
const W = 3;
const M = (i) => 3 + i; // m1..m4
const V = (i) => 8 + i;
const D = 24;

const code = [];
const op = (...b) => code.push(...b);
const get = (i) => op(0x20, ...uleb(i));
const set = (i) => op(0x21, ...uleb(i));
const c64 = (v) => op(0x42, ...sleb64(v));
const c32 = (v) => op(0x41, ...sleb32(v));
const ADD = 0x7c;
const XOR = 0x85;
const ROTR = 0x8a;
const msg = (i) => (i === 0 ? W : i <= 4 ? M(i) : undefined);

function G(a, b, c, d, x, y) {
  const mix = (m, r1, r2) => {
    get(V(a)), get(V(b)), op(ADD);
    if (m !== undefined) get(m), op(ADD);
    set(V(a));
    get(V(d)), get(V(a)), op(XOR), c64(r1), op(ROTR), set(V(d));
    get(V(c)), get(V(d)), op(ADD), set(V(c));
    get(V(b)), get(V(c)), op(XOR), c64(r2), op(ROTR), set(V(b));
  };
  mix(msg(x), 32, 24);
  mix(msg(y), 16, 63);
}

get(P_START), set(W);
for (let i = 1; i <= 4; i++) c32(0), op(0x29, 3, ...uleb((i - 1) * 8)), set(M(i)); // i64.load root words
op(0x02, 0x40); // block
op(0x03, 0x40); //   loop
get(P_COUNT), op(0x45), op(0x0d, 1); // count == 0 -> leave the block
// state: v0..v7 = h, v8..v15 = IV; byte counter 40, last block
c64(H0), set(V(0));
for (let i = 1; i < 8; i++) c64(IV[i]), set(V(i));
for (let i = 0; i < 8; i++) {
  let v = IV[i];
  if (i === 4) v ^= 40n;
  if (i === 6) v ^= MASK64;
  c64(v), set(V(8 + i));
}
for (let r = 0; r < 12; r++) {
  const s = SIGMA[r % 10];
  G(0, 4, 8, 12, s[0], s[1]);
  G(1, 5, 9, 13, s[2], s[3]);
  G(2, 6, 10, 14, s[4], s[5]);
  G(3, 7, 11, 15, s[6], s[7]);
  G(0, 5, 10, 15, s[8], s[9]);
  G(1, 6, 11, 12, s[10], s[11]);
  G(2, 7, 8, 13, s[12], s[13]);
  G(3, 4, 9, 14, s[14], s[15]);
}
c64(H0), get(V(0)), op(XOR), get(V(8)), op(XOR), set(D); // the digest's first (only) word
get(D), get(P_THR), op(0x5a); // i64.ge_u
op(0x04, 0x40); // if
c32(0), get(W), op(0x37, 3, ...uleb(32)); // i64.store work
c32(0), get(D), op(0x37, 3, ...uleb(40)); // i64.store difficulty
c32(1), op(0x0f); // return 1
op(0x0b); // end if
get(W), c64(1), op(ADD), set(W);
get(P_COUNT), c32(1), op(0x6b), set(P_COUNT); // i32.sub
op(0x0c, 0); // br loop
op(0x0b); //   end loop
op(0x0b); // end block
c32(0), get(W), op(0x37, 3, ...uleb(32));
c32(0);
op(0x0b); // end function

const body = [...vec([[...uleb(22), I64]]), ...code];
const module = [
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
  ...section(1, vec([[0x60, ...vec([[I64], [I32], [I64]]), ...vec([[I32]])]])),
  ...section(3, vec([[0]])),
  ...section(5, vec([[0x00, 0x01]])),
  ...section(7, vec([[...name('search'), 0x00, 0x00], [...name('memory'), 0x02, 0x00]])),
  ...section(10, vec([[...uleb(body.length), ...body]])),
];
const bytes = Uint8Array.from(module);
new WebAssembly.Module(bytes); // validates
const file = path.resolve('src/coins/nano/powWasm.gen.ts');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, `// GENERATED by scripts/gen-nano-pow-wasm.mjs. Do not edit.\n// Nano proof-of-work search (BLAKE2b-64 of work || root), ${bytes.length} bytes of WebAssembly.\nexport const POW_WASM = '${Buffer.from(bytes).toString('base64')}';\n`);
console.log('wrote', file, bytes.length, 'bytes of wasm');
