// Probe which public HTTP APIs answer over Tor (from Node, Arti dials relays directly).
//   node test/manual/probe.mjs url1 url2 ...   (POST JSON with url|{"json":...})
import { TorClient, storage } from 'tor-js/wasm-file';
const c = new TorClient({ storage: new storage.MemoryStorage() });
await c.ready();
const urls = process.argv.slice(2);
await Promise.all(urls.map(async (spec, i) => {
  const [url, body] = spec.split('|');
  for (let a = 0; a < 3; a++) {
    const t0 = Date.now();
    try {
      const init = { anonOptions: { isolationKey: `p${i}-${a}` }, headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, signal: AbortSignal.timeout(60000) };
      if (body) { init.method = 'POST'; init.body = body; init.headers['Content-Type'] = 'application/json'; }
      const r = await c.fetch(url, init);
      const t = await r.text();
      console.log(`${r.status} ${Date.now() - t0}ms ${url} :: ${t.replace(/\s+/g, ' ').slice(0, 160)}`);
      return;
    } catch (e) { if (a === 2) console.log(`ERR ${url} :: ${e.message.slice(0, 120)}`); }
  }
}));
c.close();
process.exit(0);
