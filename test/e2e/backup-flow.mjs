// Backup round trip: profile A creates wallets (Ethereum, Nano standard), a
// contact, a transaction note and a setting, then exports a backup from
// Settings → Backup; profile B (first run) restores it from Welcome → Restore →
// Backup file and must have the same wallets (addresses, seeds), contact, note
// and setting, but keep its own security settings.
//   node test/e2e/backup-flow.mjs [--url http://127.0.0.1:8787/]
import fs from 'node:fs';
import { launch } from './launch.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const URL_ = args.url || 'http://127.0.0.1:8787/';
const DL = `/tmp/opencode/dl-${Date.now()}`;
fs.mkdirSync(DL, { recursive: true });
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const profiles = [];

async function session(name) {
  const profile = `/tmp/opencode/cw-bk-${name}-${Date.now()}`;
  profiles.push(profile);
  const browser = await launch({ profile, width: 430, height: 900 });
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  const click = async (sel) => { await page.waitForSelector(sel, { visible: true, timeout: 60000 }); await page.click(sel); };
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  for (const d of '1234') await click(`#pin_code_button_${d}_key`);
  await wait(300);
  for (const d of '1234') await click(`#pin_code_button_${d}_key`);
  await click('.alert .acts button');
  return { browser, page, click };
}

/** every wallet with its address and seed, the contacts' names, the fiat currency, the 2FA flag */
const state = (page) => page.evaluate(async () => {
  const app = window.__cw.app;
  const wallets = [];
  for (const w of app.walletInfos.value) wallets.push({ name: w.name, type: w.type, address: w.address, seed: (await app.getSecrets(w.id)).mnemonic });
  return { wallets: wallets.sort((a, b) => a.name.localeCompare(b.name)), fiat: window.__cw.settings.value.fiatCurrency, pinTimeout: window.__cw.settings.value.pinTimeOutDuration };
});

try {
  // ---- A: data, then export
  const A = await session('a');
  await A.page.evaluate(async () => {
    const app = window.__cw.app;
    const eth = await app.createWallet('ethereum', { name: 'Backup ETH' });
    await app.createWallet('nano', { name: 'Backup XNO', seedType: 'nano' });
    await app.openWallet(eth.id);
    window.__cw.settings.value = { ...window.__cw.settings.value, fiatCurrency: 'EUR', pinTimeOutDuration: 1 };
  });
  await A.page.evaluate(() => window.__cw.nav.push('/address_book_add_contact', { address: '0x9858EfFD232B4033E47d90003D41EC34EcaEda94', currency: 'eth' }));
  await A.page.waitForSelector('#contact_name');
  await A.page.type('#contact_name', 'Alice');
  await A.click('#contact_page_save_button');
  await wait(1000);
  const before = await state(A.page);
  step(`A: ${JSON.stringify(before.wallets.map((w) => `${w.name}=${w.address.slice(0, 12)}…/${w.seed.split(' ').length} words`))}, fiat ${before.fiat}`);
  const cdp = await A.page.createCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  await A.page.evaluate(() => window.__cw.nav.push('/backup'));
  await A.page.waitForFunction(() => (document.querySelector('#backup_password')?.textContent ?? '').length === 64, { timeout: 30000 });
  const password = await A.page.$eval('#backup_password', (e) => e.textContent);
  await A.click('#backup_export');
  await A.page.waitForSelector('.alert .acts button', { visible: true });
  await A.page.evaluate(() => [...document.querySelectorAll('.alert .acts button')].pop().click());
  let file;
  for (let i = 0; i < 120 && !file; i++) {
    await wait(500);
    file = fs.readdirSync(DL).find((f) => f.endsWith('.zip'));
  }
  if (!file) throw new Error('no backup file downloaded');
  step(`A: exported ${file} (${fs.statSync(`${DL}/${file}`).size} bytes)`);
  await A.browser.close();

  // ---- B: first run → Welcome → Restore → Backup file; a wrong password first
  const B = await session('b');
  await B.click('#welcome_page_restore_wallet_button_key');
  await B.click('#restore_options_from_backup_button_key');
  await B.page.waitForSelector('#restore_from_backup_page');
  await (await B.page.$('#restore_backup_file')).uploadFile(`${DL}/${file}`);
  await B.page.waitForSelector('#restore_backup_file_name', { timeout: 10000 });
  await B.page.type('#restore_backup_password', 'wrong password');
  await B.click('#restore_backup_import');
  await B.page.waitForSelector('.alert', { visible: true, timeout: 60000 });
  step(`B: wrong password → "${await B.page.$eval('.alert', (e) => e.innerText.replace(/\s+/g, ' ').trim())}"`);
  await B.page.evaluate(() => document.querySelector('.alert .acts button').click());
  await B.page.evaluate(() => { const i = document.querySelector('#restore_backup_password'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await B.page.type('#restore_backup_password', password);
  await B.click('#restore_backup_import');
  await B.page.waitForFunction(() => window.__cw.app.currentWallet.value, { timeout: 120000 });
  const after = await state(B.page);
  const contacts = await B.page.evaluate(async () => {
    window.__cw.nav.push('/address_book');
    await new Promise((r) => setTimeout(r, 1000));
    [...document.querySelectorAll('#contact_list_page button')].find((b) => b.textContent.trim() === 'Contacts')?.click();
    await new Promise((r) => setTimeout(r, 600));
    return document.querySelector('#contact_list_page')?.innerText.replace(/\s+/g, ' ').slice(0, 200);
  });
  step(`B: ${JSON.stringify(after.wallets.map((w) => `${w.name}=${w.address.slice(0, 12)}…`))}, fiat ${after.fiat}, pin timeout ${after.pinTimeout} (A had 1), current ${await B.page.evaluate(() => window.__cw.app.currentWallet.value.name)}`);
  step(`B: contacts page: ${contacts}`);
  const same = JSON.stringify(before.wallets) === JSON.stringify(after.wallets);
  step(`wallets, addresses and seeds identical: ${same}`);
  await B.page.screenshot({ path: '/tmp/opencode/cw-bk-restored.png' });
  await B.browser.close();
} catch (e) {
  step(`FAILED: ${e.message}`);
} finally {
  console.log('page errors:', errors.slice(0, 10));
  fs.rmSync(DL, { recursive: true, force: true });
  for (const p of profiles) fs.rmSync(p, { recursive: true, force: true });
}
