// Screenshots of the main screens (for visual checks): creates a PIN and a
// wallet through the UI, then visits pages.
//   node test/e2e/screens.mjs [--type bitcoin] [--theme 1] [--out /tmp/opencode/shots]
import fs from 'node:fs';
import { launch } from './launch.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const URL_ = args.url || 'http://127.0.0.1:8787/';
const OUT = args.out || '/tmp/opencode/shots';
const TYPE = args.type || 'bitcoin';
fs.mkdirSync(OUT, { recursive: true });
const browser = await launch({ browser: args.browser || 'chrome', profile: `/tmp/opencode/cw-shots-${Date.now()}`, width: 430, height: 900 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const click = async (sel, timeout = 20000) => { await page.waitForSelector(sel, { visible: true, timeout }); await page.click(sel); };
const pin = async (p) => { for (const d of p) await click(`#pin_code_button_${d}_key`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (n) => { await wait(700); await page.screenshot({ path: `${OUT}/${n}.png` }); console.log('shot', n); };
try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  if (args.theme) await page.evaluate((t) => localStorage.setItem('cw-theme', t), args.theme), await page.reload({ waitUntil: 'domcontentloaded' });
  await shot('01-welcome');
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  await shot('02-pin');
  await pin('1234'); await wait(300); await pin('1234');
  await click('.alert .acts button');
  await shot('03-welcome-wallet');
  await click('#welcome_page_create_new_wallet_button_key');
  await shot('04-wallet-type');
  await click(`#wallet_type_${TYPE}`);
  await page.type('#new_wallet_page_wallet_name_textformfield_key', 'My Wallet');
  await shot('05-new-wallet');
  await click('#new_wallet_page_confirm_button_key');
  await page.waitForSelector('#pre_seed_page', { timeout: 60000 });
  for (const i of [0, 1, 2]) await click(`#pre_seed_check_${i}`);
  await shot('06-pre-seed');
  await click('#pre_seed_page_button_key');
  await shot('07-seed');
  await page.evaluate(() => window.__cw.nav.reset('/dashboard'));
  await page.waitForFunction(() => window.__cw.app.currentWallet.value?.syncStatus.value.kind === 'synced', { timeout: 300000, polling: 2000 }).catch(() => {});
  await shot('08-home');
  await click('#home_receive'); await shot('09-receive'); await page.evaluate(() => window.__cw.nav.pop());
  await click('#home_send'); await shot('10-send'); await page.evaluate(() => window.__cw.nav.pop());
  await click('#home_page_settings_button_key'); await shot('11-settings');
  await click('#settings_display'); await shot('12-display'); await page.evaluate(() => window.__cw.nav.pop());
  await click('#settings_connections'); await shot('13-connections'); await page.evaluate(() => window.__cw.nav.pop());
  await page.evaluate(() => window.__cw.nav.pop());
  await click('#nav_wallets'); await shot('14-wallets');
  await click('#nav_contacts'); await shot('15-contacts');
  await click('#nav_apps'); await shot('16-apps');
  await click('#nav_charts'); await wait(6000); await shot('17-charts');
} catch (e) {
  console.log('FAILED', e.message);
  await page.screenshot({ path: `${OUT}/fail.png` });
} finally {
  console.log('errors', errors.slice(0, 5));
  await browser.close();
}
