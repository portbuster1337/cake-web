// Nano proof-of-work search in a Web Worker: runs the WebAssembly kernel from
// a start value until a work value reaches the threshold, then posts it. The
// page terminates the worker when another one found work first.

import { POW_WASM } from './powWasm.gen.ts';

const CHUNK = 1 << 20;
const bytes = Uint8Array.from(atob(POW_WASM), (c) => c.charCodeAt(0));
const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes));
const search = inst.exports.search as (start: bigint, count: number, threshold: bigint) => number;
const mem = inst.exports.memory as WebAssembly.Memory;

self.onmessage = (e: MessageEvent<{ root: Uint8Array; threshold: bigint; start: bigint }>) => {
  const { root, threshold } = e.data;
  let start = e.data.start;
  new Uint8Array(mem.buffer).set(root, 0);
  const dv = new DataView(mem.buffer);
  for (;;) {
    if (search(start, CHUNK, threshold)) {
      postMessage({ work: dv.getBigUint64(32, true) });
      return;
    }
    start = dv.getBigUint64(32, true);
  }
};
