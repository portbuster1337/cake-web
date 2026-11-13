// Captures real Nano blocks (contents, hash, subtype) and the rpc.nano.to
// representative list format, as fixtures for the Nano primitives test.
//   node test/manual/nano-fixture.mjs [account] > test/unit/fixtures/nano-blocks.json
import { TorClient, storage } from 'tor-js/wasm-file';

const account = process.argv[2] || 'nano_3i1aq1cchnmbn9x5rsbap8b15akfh7wj7pwskuzi7ahz8oq6cobd99d4r3b7';
const node = 'https://rpc.nano.to';
const c = new TorClient({ storage: new storage.MemoryStorage() });
await c.ready();
async function rpc(url, body, key) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await c.fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'User-Agent': 'Dart/3.11 (dart:io)', 'nano-app': 'cake-wallet' }, anonOptions: { isolationKey: `${key}${i}` }, signal: AbortSignal.timeout(60000) });
      return await r.json();
    } catch (e) {
      if (i === 3) throw e;
    }
  }
}
const hist = await rpc(node, { action: 'account_history', account, count: '8' }, 'h');
const blocks = [];
for (const h of hist.history ?? []) {
  const info = await rpc(node, { action: 'block_info', json_block: 'true', hash: h.hash }, `b${h.hash}`);
  if (info?.contents?.type !== 'state') continue;
  blocks.push({ hash: h.hash, subtype: info.subtype, contents: info.contents });
}
const reps = await rpc('https://rpc.nano.to', { action: 'reps' }, 'r');
const repSample = Array.isArray(reps) ? reps.slice(0, 2) : reps;
console.log(JSON.stringify({ account, blocks, repSample }, null, 1));
c.close();
process.exit(0);
