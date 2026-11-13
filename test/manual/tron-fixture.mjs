// Captures real Tron transactions (raw_data + the network's raw_data_hex and txID)
// as a fixture for the protobuf encoder test.
//   node test/manual/tron-fixture.mjs [address] > test/unit/fixtures/tron-txs.json
import { TorClient, storage } from 'tor-js/wasm-file';

const addrs = process.argv.slice(2).length ? process.argv.slice(2) : ['TV6MuMXfmLbBqPZvBHdwFsDnQeVfnmiuSi', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'];
const c = new TorClient({ storage: new storage.MemoryStorage() });
await c.ready();
const txs = [];
for (const addr of addrs) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await c.fetch(`https://api.trongrid.io/v1/accounts/${addr}/transactions?only_confirmed=true&limit=50`, { headers: { Accept: 'application/json', 'User-Agent': 'Dart/3.11 (dart:io)' }, anonOptions: { isolationKey: `fx${addr}${attempt}` }, signal: AbortSignal.timeout(60000) });
      const j = await r.json();
      if (!j.data) throw new Error(JSON.stringify(j).slice(0, 120));
      txs.push(...j.data);
      break;
    } catch (e) {
      console.error('retry', e.message);
    }
  }
}
const pick = (type, pred = () => true) => txs.find((t) => t.raw_data?.contract?.[0]?.type === type && t.raw_data_hex && pred(t));
const out = [pick('TransferContract'), pick('TriggerSmartContract', (t) => String(t.raw_data.contract[0].parameter.value.data ?? '').startsWith('a9059cbb'))]
  .filter(Boolean)
  .map((t) => ({ txID: t.txID, raw_data: t.raw_data, raw_data_hex: t.raw_data_hex, signature: t.signature }));
console.log(JSON.stringify(out, null, 1));
c.close();
process.exit(0);
