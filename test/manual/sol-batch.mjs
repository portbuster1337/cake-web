// How do public Solana RPC nodes treat batched getTransaction calls over Tor?
//   node test/manual/sol-batch.mjs [address]
import { TorClient, storage } from 'tor-js/wasm-file';

const addr = process.argv[2] || 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk';
const nodes = ['https://api.mainnet-beta.solana.com', 'https://solana-rpc.publicnode.com'];
const c = new TorClient({ storage: new storage.MemoryStorage() });
await c.ready();
let n = 0;
async function rpc(url, body, key) {
  const t0 = Date.now();
  const r = await c.fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'User-Agent': 'Dart/3.11 (dart:io)' }, anonOptions: { isolationKey: key }, signal: AbortSignal.timeout(90000) });
  const text = await r.text();
  return { status: r.status, ms: Date.now() - t0, text };
}
for (const url of nodes) {
  const key = `k${n++}`;
  const s = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress', params: [addr, { limit: 60 }] }, key);
  const sigs = JSON.parse(s.text).result.map((x) => x.signature);
  console.log(url, 'signatures', s.status, s.ms, 'ms', sigs.length);
  for (let i = 0; i < 50; i += 10) {
    const batch = sigs.slice(i, i + 10).map((sig, j) => ({ jsonrpc: '2.0', id: j, method: 'getTransaction', params: [sig, { encoding: 'json', maxSupportedTransactionVersion: 0 }] }));
    try {
      const r = await rpc(url, batch, key);
      let ok = 0;
      let err = '';
      try {
        const arr = JSON.parse(r.text);
        for (const x of Array.isArray(arr) ? arr : [arr]) {
          if (x.result) ok++;
          else err = JSON.stringify(x.error ?? x).slice(0, 90);
        }
      } catch {
        err = r.text.slice(0, 90);
      }
      console.log(`  batch ${i / 10}: HTTP ${r.status} ${r.ms} ms, ${ok}/10 ok ${err}`);
    } catch (e) {
      console.log(`  batch ${i / 10}: ERR ${e.message.slice(0, 100)}`);
    }
  }
}
c.close();
process.exit(0);
