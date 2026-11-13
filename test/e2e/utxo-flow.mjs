// Litecoin, Bitcoin Cash and Dogecoin over Tor: restore the "abandon … about"
// mnemonic for each through the app API, wait for the sync, report balance,
// history size and the nodes used.
//   node test/e2e/utxo-flow.mjs [--url http://127.0.0.1:8787/] [--types litecoin,bitcoinCash,dogecoin]
import { launch } from './launch.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const URL_ = args.url || 'http://127.0.0.1:8787/';
const TYPES = (args.types || 'litecoin,bitcoinCash,dogecoin').split(',');
const browser = await launch({ profile: `/tmp/opencode/cw-utxo-${Date.now()}`, width: 430, height: 900 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const click = async (sel) => { await page.waitForSelector(sel, { visible: true, timeout: 30000 }); await page.click(sel); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  for (const d of '1234') await click(`#pin_code_button_${d}_key`);
  await wait(300);
  for (const d of '1234') await click(`#pin_code_button_${d}_key`);
  await click('.alert .acts button');
  for (const type of TYPES) {
    const ts = Date.now();
    await page.evaluate(async (ty, m) => {
      const info = await window.__cw.app.restoreWalletFromSeed(ty, { name: `T ${ty}`, mnemonic: m });
      await window.__cw.app.openWallet(info.id);
    }, type, MNEMONIC);
    let st;
    for (;;) {
      st = await page.evaluate(() => {
        const w = window.__cw.app.currentWallet.value;
        const s = w.syncStatus.value;
        return { kind: s.kind, error: s.error, address: w.receiveAddress.value, txs: w.transactions.value.length, bal: Object.fromEntries(Object.entries(w.balances.value).map(([k, v]) => [k, String(v.full)])) };
      });
      if (st.kind === 'synced' || st.kind === 'failed' || Date.now() - ts > 300000) break;
      await wait(2000);
    }
    const hosts = await page.evaluate(() => [...new Set(window.__cw.app.net().activity.filter((a) => !/prices/.test(a.host)).slice(-40).map((a) => `${a.host} ${a.status ?? a.error ?? ''}`))].slice(0, 6));
    step(`${type}: ${st.kind}${st.error ? ` (${st.error})` : ''} in ${((Date.now() - ts) / 1000).toFixed(1)} s, ${st.address.slice(0, 16)}…, ${st.txs} txs, balance ${JSON.stringify(st.bal)}; ${JSON.stringify(hosts)}`);
  }
} catch (e) {
  step(`FAILED: ${e.message}`);
} finally {
  console.log('page errors:', errors.slice(0, 10));
  await browser.close();
}
