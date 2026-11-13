// Sustained getTransaction rate over Tor against Solana's public RPC: single
// calls on a few circuits ("lanes"), a new circuit + backoff on HTTP 429.
//   node test/manual/sol-rate.mjs [lanes] [count] [address]
import { TorClient, storage } from 'tor-js/wasm-file';

const lanes = Number(process.argv[2] || 3);
const count = Number(process.argv[3] || 40);
const addr = process.argv[4] || 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const url = 'https://api.mainnet-beta.solana.com';
const c = new TorClient({ storage: new storage.MemoryStorage() });
await c.ready();
const salt = Array.from({ length: lanes }, () => Math.random().toString(36).slice(2));
async function call(body, lane) {
  const r = await c.fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'User-Agent': 'Dart/3.11 (dart:io)' }, anonOptions: { isolationKey: `lane${lane}-${salt[lane]}` }, signal: AbortSignal.timeout(60000) });
  const text = await r.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch { /* html */ }
  return { status: r.status, j };
}
const sigRes = await call({ jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [addr, { limit: count }] }, 0);
const sigs = (sigRes.j?.result ?? []).map((x) => x.signature);
console.log('signatures', sigs.length);
const t0 = Date.now();
let next = 0;
let limited = 0;
let ok = 0;
let failed = 0;
await Promise.all(Array.from({ length: lanes }, async (_, lane) => {
  while (next < sigs.length) {
    const sig = sigs[next++];
    let done = false;
    for (let attempt = 0; attempt < 6 && !done; attempt++) {
      try {
        const r = await call({ jsonrpc: '2.0', id: 1, method: 'getTransaction', params: [sig, { encoding: 'json', maxSupportedTransactionVersion: 0 }] }, lane);
        if (r.status === 429 || r.j?.error?.code === 429) {
          limited++;
          salt[lane] = Math.random().toString(36).slice(2);
          await new Promise((ok2) => setTimeout(ok2, Math.min(8000, 1000 * 2 ** attempt)));
          continue;
        }
        if (r.j && 'result' in r.j) {
          ok++;
          done = true;
        } else {
          salt[lane] = Math.random().toString(36).slice(2);
        }
      } catch {
        salt[lane] = Math.random().toString(36).slice(2);
      }
    }
    if (!done) failed++;
  }
}));
const s = (Date.now() - t0) / 1000;
console.log(`lanes ${lanes}: ${ok} ok, ${failed} failed, ${limited} x 429, ${s.toFixed(1)} s, ${(ok / s).toFixed(2)} tx/s`);
c.close();
process.exit(0);
