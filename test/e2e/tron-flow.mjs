// Tron end-to-end over Tor: restore the "abandon … about" mnemonic through the
// UI, sync (TRX + TRC-20 balances, TronGrid history), check the assets list,
// the add-token page (on-chain name/symbol/decimals), the receive URI, the fee
// estimates, message signing, building (not sending) a TRX transfer, and the
// balance rule on a fresh wallet.
//   node test/e2e/tron-flow.mjs [--url http://127.0.0.1:8787/]
import { launch } from './launch.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const URL_ = args.url || 'http://127.0.0.1:8787/';
const browser = await launch({ profile: `/tmp/opencode/cw-trx-${Date.now()}`, width: 430, height: 900 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const click = async (sel, timeout = 30000) => { await page.waitForSelector(sel, { visible: true, timeout }); await page.click(sel); };
const pin = async (p) => { for (const d of p) await click(`#pin_code_button_${d}_key`); };
const shot = (n) => page.screenshot({ path: `/tmp/opencode/cw-trx-${n}.png` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

async function waitSynced(name, timeoutMs = 300000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const st = await page.evaluate((n) => {
      const w = window.__cw.app.currentWallet.value;
      if (!w || w.name !== n) return null;
      const s = w.syncStatus.value;
      return { kind: s.kind, error: s.error, height: w.height.value, txs: w.transactions.value.length, bal: Object.fromEntries(Object.entries(w.balances.value).map(([k, v]) => [k, String(v.available)])) };
    }, name);
    if (st && (st.kind === 'synced' || st.kind === 'failed')) return st;
    if (Date.now() > end) throw new Error(`sync timeout: ${JSON.stringify(st)}`);
    await wait(2000);
  }
}

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  await pin('1234'); await wait(300); await pin('1234');
  await click('.alert .acts button');
  await page.evaluate(() => window.__cw.nav.push('/restore_wallet', { walletType: 'tron' }));
  await page.waitForSelector('#restore_seed');
  await page.type('#wallet_restore_name', 'TRX Abandon');
  await page.type('#restore_seed', MNEMONIC);
  await click('#wallet_restore_seed_or_key_restore_button_key');
  await page.waitForFunction(() => window.__cw.app.currentWallet.value?.name === 'TRX Abandon', { timeout: 60000 });
  const addr = await page.evaluate(() => window.__cw.app.currentWallet.value.receiveAddress.value);
  step(`restored, address ${addr} (expected TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH)`);
  const st = await waitSynced('TRX Abandon');
  step(`sync: ${JSON.stringify(st)}`);
  const sample = await page.evaluate(() => window.__cw.app.currentWallet.value.transactions.value.slice(0, 5).map((x) => ({ id: x.id.slice(0, 10), dir: x.direction, cur: x.currency.slice(0, 8), amt: String(x.amount), sym: x.tokenSymbol, fee: String(x.fee), date: new Date(x.date).toISOString().slice(0, 10) })));
  step(`history sample: ${JSON.stringify(sample)}`);
  await page.waitForSelector('#assets_list', { timeout: 20000 });
  const assets = await page.$$eval('#assets_list button', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  step(`assets list (${assets.length}): ${JSON.stringify(assets)}`);
  await shot('1-home');
  // add-token page: name/symbol/decimals from the contract (JUST on Tron)
  await page.evaluate(() => window.__cw.nav.push('/edit_token', { contractAddress: 'TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9' }));
  await page.waitForSelector('#edit_token_page', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('#edit_token_symbol')?.value, { timeout: 90000 }).catch(() => {});
  const filled = await page.evaluate(() => ({ name: document.querySelector('#edit_token_name')?.value, symbol: document.querySelector('#edit_token_symbol')?.value, decimals: document.querySelector('#edit_token_decimals')?.value }));
  step(`edit token: ${JSON.stringify(filled)}`);
  await shot('2-edit-token');
  await page.evaluate(() => window.__cw.nav.reset('/dashboard'));
  await click('#home_receive');
  await page.waitForSelector('#receive_qr');
  step(`receive URI: ${await page.$eval('#receive_qr', (e) => e.getAttribute('data-qr'))}`);
  await page.evaluate(() => window.__cw.nav.pop());
  const misc = await page.evaluate(async () => {
    const w = window.__cw.app.currentWallet.value;
    const native = await w.estimateFee('medium');
    const trc20 = await w.estimateFee('medium', undefined, 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    const sig = await w.signMessage('hello from cake web');
    let built;
    try {
      const p = await w.createTransaction({ outputs: [{ address: w.receiveAddress.value, amount: 1n, sendAll: false }] });
      built = { id: p.id.slice(0, 12), fee: p.feeFormatted, hexLen: p.hex.length };
    } catch (e) {
      built = { error: e.message };
    }
    return { native: String(native), trc20: String(trc20), sig: sig.slice(0, 12), ok: await w.verifyMessage('hello from cake web', sig, w.receiveAddress.value), bad: await w.verifyMessage('hello', sig, w.receiveAddress.value), keys: (await w.keys()).map((k) => `${k.label}=${k.value.slice(0, 8)}…`), built };
  });
  step(`fee/sign/keys/build: ${JSON.stringify(misc)}`);
  const fresh = await page.evaluate(async () => {
    const info = await window.__cw.app.createWallet('tron', { name: 'TRX Fresh' });
    const w = await window.__cw.app.openWallet(info.id);
    for (let i = 0; i < 60 && w.syncStatus.value.kind !== 'synced' && w.syncStatus.value.kind !== 'failed'; i++) await new Promise((r) => setTimeout(r, 2000));
    try {
      await w.createTransaction({ outputs: [{ address: 'TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH', amount: 1000n, sendAll: false }] });
      return { status: w.syncStatus.value.kind, result: 'built (unexpected)' };
    } catch (e) {
      return { status: w.syncStatus.value.kind, result: e.message };
    }
  });
  step(`fresh wallet send: ${JSON.stringify(fresh)}`);
  await click('#home_send');
  await page.waitForSelector('#send_page');
  await click('#send_advanced');
  await wait(1500);
  await shot('3-send');
} catch (e) {
  step(`FAILED: ${e.message}`);
  await shot('fail');
} finally {
  console.log('page errors:', errors.slice(0, 10));
  await browser.close();
}
