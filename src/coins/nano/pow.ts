// Nano proof of work on this device: one worker per CPU core, each from a
// random start; the first valid work wins and the others are stopped.
// Expected effort: 2^29 hashes for send/change blocks, 2^23 for receive/open
// blocks (about 6 million hashes per second per core).

import { hexToBytes } from '@noble/hashes/utils.js';
import { workDifficulty } from './nano.ts';

function randomStart(): bigint {
  return new DataView(crypto.getRandomValues(new Uint8Array(8)).buffer).getBigUint64(0, true);
}

export function computeWork(rootHex: string, threshold: bigint, signal?: AbortSignal): Promise<string> {
  const root = hexToBytes(rootHex);
  if (root.length !== 32) return Promise.reject(new Error('Invalid work root'));
  const n = Math.max(1, Math.min(navigator.hardwareConcurrency || 2, 16));
  return new Promise<string>((resolve, reject) => {
    const workers: Worker[] = [];
    let failed = 0;
    let done = false;
    const finish = () => {
      done = true;
      for (const w of workers) w.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (done) return;
      finish();
      reject(new DOMException('Proof of work cancelled', 'AbortError'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module', name: 'nano-pow' });
      workers.push(w);
      w.onmessage = (e: MessageEvent<{ work: bigint }>) => {
        if (done) return;
        const work = e.data.work.toString(16).padStart(16, '0');
        if (workDifficulty(rootHex, work) < threshold) return;
        finish();
        resolve(work);
      };
      w.onerror = (e) => {
        e.preventDefault();
        if (done || ++failed < n) return;
        finish();
        reject(new Error(`Proof of work failed: ${e.message || 'worker error'}`));
      };
      w.postMessage({ root, threshold, start: randomStart() });
    }
  });
}
