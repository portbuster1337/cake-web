// Monero end-to-end: create a Polyseed wallet, sync it through Cake's node over Tor,
// check the subaddress, keys and seed, then restore the same polyseed and compare.
import { launch } from './launch.mjs';
const URL_ = process.argv[2] || 'http://127.0.0.1:8787/';
const browser = await launch({ profile: `/tmp/opencode/cw-xmr-${Date.now()}`, width: 430, height: 900 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(`console: ${m.text()}`); });
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const click = async (sel, timeout = 30000) => { await page.waitForSelector(sel, { visible: true, timeout }); await page.click(sel); };
const pin = async (p) => { for (const d of p) await click(`#pin_code_button_${d}_key`); };
try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  await pin('1234'); await new Promise((r) => setTimeout(r, 300)); await pin('1234');
  await click('.alert .acts button');
  await click('#welcome_page_create_new_wallet_button_key');
  await click('#wallet_type_monero');
  await page.type('#new_wallet_page_wallet_name_textformfield_key', 'XMR Test');
  await click('#new_wallet_page_confirm_button_key');
  await page.waitForSelector('#pre_seed_page', { timeout: 120000 });
  step('monero wallet created');
  const info = await page.evaluate(async () => {
    const w = window.__cw.app.currentWallet.value;
    const s = await window.__cw.app.getSecrets(w.id);
    return { seedWords: s.mnemonic.split(' ').length, seed: s.mnemonic, address: w.info.address, height: w.info.restoreHeight, seedType: w.info.seedType };
  });
  step(`seed ${info.seedWords} words (${info.seedType}), primary ${info.address.slice(0, 12)}…, restore height ${info.height}`);
  await page.evaluate(() => window.__cw.nav.reset('/dashboard'));
  let synced = null;
  for (let i = 0; i < 240 && !synced; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const st = await page.evaluate(() => {
      const w = window.__cw.app.currentWallet.value;
      const s = w?.syncStatus.value;
      return { s, height: w?.height.value, recv: w?.receiveAddress.value, subs: w?.addresses.value.length, accounts: w?.accounts.value.map((a) => a.label) };
    });
    if (i % 3 === 0) {
      step(`status ${JSON.stringify(st.s)} height ${st.height}`);
      const act = await page.evaluate((since) => window.__cw.app.net().activity.filter((a) => a.at + (a.ms ?? 0) > since).map((a) => `${a.via} ${a.method} ${a.host}${a.path} ${a.status ?? ''} ${a.ms ?? ''}ms ${a.bytes ?? ''}b ${a.purpose ?? ''} ${a.error ?? ''}`), Date.now() - 15000);
      for (const a of act.slice(-12)) console.log('   ', a);
    }
    if (st.s && (st.s.kind === 'synced' || st.s.kind === 'failed')) synced = st;
  }
  step(`sync: ${JSON.stringify(synced)}`);
  const keys = await page.evaluate(async () => (await window.__cw.app.currentWallet.value.keys()).map((k) => `${k.label}=${k.value.slice(0, 8)}…`));
  step(`keys: ${keys.join(', ')}`);
  // restore the same polyseed in a second wallet: must give the same primary address
  const restored = await page.evaluate(async (seed) => {
    const info = await window.__cw.app.restoreWalletFromSeed('monero', { name: 'XMR Restored', mnemonic: seed });
    return info.address;
  }, info.seed);
  step(`restored address matches: ${restored === info.address} (${restored.slice(0, 12)}…)`);
  await page.screenshot({ path: '/tmp/opencode/cw-xmr-home.png' });
} catch (e) {
  step(`FAILED: ${e.message}`);
  await page.screenshot({ path: '/tmp/opencode/cw-xmr-fail.png' });
} finally {
  console.log('errors:', errors.slice(0, 8));
  await browser.close();
}
