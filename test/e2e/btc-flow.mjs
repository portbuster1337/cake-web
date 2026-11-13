// End-to-end: set a PIN, create a Bitcoin wallet (BIP39), go through the seed
// backup/verification, check the dashboard + receive page, wait for the wallet
// to sync over Tor; then restore a known BIP39 wallet and check its history.
//   node test/e2e/btc-flow.mjs [--url http://127.0.0.1:8787/] [--browser chrome|firefox]
import { launch } from './launch.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const URL_ = args.url || 'http://127.0.0.1:8787/';
const browser = await launch({ browser: args.browser || 'chrome', profile: `/tmp/opencode/cw-btc-${Date.now()}`, width: 430, height: 900 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const click = async (sel, timeout = 20000) => { await page.waitForSelector(sel, { visible: true, timeout }); await page.click(sel); };
const pin = async (p) => { for (const d of p) await click(`#pin_code_button_${d}_key`); };
const shot = (n) => page.screenshot({ path: `/tmp/opencode/cw-btc-${n}.png` });
try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  await pin('1234');
  await page.waitForFunction(() => document.querySelector('#pin-title')?.textContent?.includes('again'));
  await pin('1234');
  await click('.alert .acts button');
  await click('#welcome_page_create_new_wallet_button_key');
  await click('#wallet_type_bitcoin');
  await page.waitForSelector('#new_wallet_page_wallet_name_textformfield_key');
  await page.type('#new_wallet_page_wallet_name_textformfield_key', 'Test BTC');
  await click('#new_wallet_page_confirm_button_key');
  await page.waitForSelector('#pre_seed_page', { timeout: 30000 });
  step('wallet created, pre-seed page');
  for (const i of [0, 1, 2]) await click(`#pre_seed_check_${i}`);
  await click('#pre_seed_page_button_key');
  await page.waitForSelector('#seed_grid');
  const words = await page.$$eval('.seed-word', (els) => els.map((e) => e.textContent));
  step(`seed: ${words.length} words`);
  await shot('1-seed');
  await click('#wallet_seed_page_verify_seed_button_key');
  for (let round = 0; round < 2; round++) {
    await page.waitForSelector('.seed-option');
    const q = await page.$eval('#seed_verification_page b', (e) => e.textContent);
    const pos = parseInt(q, 10) - 1;
    const opts = await page.$$('.seed-option');
    for (const o of opts) {
      if ((await o.evaluate((e) => e.textContent)) === words[pos]) { await o.click(); break; }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  await click('#seed_verified_open_wallet');
  await page.waitForSelector('#home_page', { timeout: 20000 });
  step('dashboard shown');
  // receive page
  await click('#home_receive');
  await page.waitForSelector('#receive_qr');
  const addr = await page.$eval('#receive_qr', (e) => e.getAttribute('data-qr'));
  step(`receive URI: ${addr}`);
  await shot('2-receive');
  await page.evaluate(() => window.__cw.nav.pop());
  // wait for sync over Tor
  const status = await page.waitForFunction(() => {
    const w = window.__cw.app.currentWallet.value;
    const s = w?.syncStatus.value;
    return s && (s.kind === 'synced' || s.kind === 'failed') ? JSON.stringify({ s, height: w.height.value }) : null;
  }, { timeout: 240000, polling: 2000 }).then((h) => h.jsonValue());
  step(`sync: ${status}`);
  await shot('3-home');
  // restore a known wallet with history
  await page.evaluate(() => window.__cw.nav.push('/restore_wallet', { walletType: 'bitcoin' }));
  await page.waitForSelector('#restore_seed');
  await page.type('#wallet_restore_name', 'Abandon');
  await page.type('#restore_seed', 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  await click('#wallet_restore_seed_or_key_restore_button_key');
  step('restoring (derivation scan over Tor)…');
  const which = await page.waitForFunction(() => document.querySelector('#choose_derivation_page') ? 'chooser' : window.__cw.app.currentWallet.value?.name === 'Abandon' ? 'opened' : null, { timeout: 300000, polling: 1000 }).then((h) => h.jsonValue());
  if (which === 'chooser') {
    // the derivations (the top bar's back button is not one)
    const items = await page.$$eval('#choose_derivation_page .page-body button', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').slice(0, 120)));
    step(`derivations: ${JSON.stringify(items.slice(0, 5))}`);
    await page.click('#choose_derivation_page .page-body button');
  }
  const restored = await page.waitForFunction(() => {
    const w = window.__cw.app.currentWallet.value;
    const s = w?.syncStatus.value;
    return w?.name === 'Abandon' && s && (s.kind === 'synced' || s.kind === 'failed') ? JSON.stringify({ s: s.kind, err: s.error, txs: w.transactions.value.length, bal: String(w.balances.value.btc?.full ?? 0n), addr: w.receiveAddress.value }) : null;
  }, { timeout: 600000, polling: 3000 }).then((h) => h.jsonValue());
  step(`restored wallet: ${restored}`);
  await shot('4-restored');
} catch (e) {
  step(`FAILED: ${e.message}`);
  await shot('fail');
} finally {
  console.log('page errors:', errors.slice(0, 10));
  await browser.close();
}
