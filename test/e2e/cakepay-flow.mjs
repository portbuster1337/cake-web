// Cake Pay end-to-end over Tor: Apps → Cake Pay, the first-visit country picker,
// the vendor list, a search, a card's page (amount, limits, description), the
// purchase button leading to the e-mail login (no e-mail is sent), the account
// avatar after a sign-in stub, an order in the history and its details page.
//   node test/e2e/cakepay-flow.mjs [--url http://127.0.0.1:8787/] [--coin monero] [--country deu] [--search amazon]
import fs from 'node:fs';
import { launch } from './launch.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const URL_ = args.url || 'http://127.0.0.1:8787/';
const coin = args.coin || 'monero';
const profile = `/tmp/opencode/cw-cakepay-${Date.now()}`;
const browser = await launch({ profile, width: 430, height: 900 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const click = async (sel, timeout = 30000) => { await page.waitForSelector(sel, { visible: true, timeout }); await page.click(sel); };
const pin = async (p) => { for (const d of p) await click(`#pin_code_button_${d}_key`); };
const shot = (n) => page.screenshot({ path: `/tmp/opencode/cpshot-${n}.png` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  await pin('1234'); await wait(300); await pin('1234');
  await click('.alert .acts button');
  await page.evaluate(async (c) => {
    const info = await window.__cw.app.createWallet(c, { name: `Pay ${c}`, ...(c === 'monero' ? { seedType: 'polyseed' } : {}) });
    await window.__cw.app.openWallet(info.id);
    window.__cw.nav.reset('/dashboard');
  }, coin);
  await wait(1500);
  await page.evaluate(() => window.__cw.nav.push('/cake_pay_cards_page'));
  await page.waitForSelector('#cake_pay_country_picker', { timeout: 30000 });
  await wait(400);
  await shot('1-country');
  step('country picker shown on the first visit');
  await page.type('#cake_pay_country_search', 'germ');
  await click(`#cake_pay_country_${args.country || 'deu'}`);
  await page.waitForFunction(() => document.querySelector('#cake_pay_vendor_list button[id^="cake_pay_vendor_"]') || /No cards/.test(document.querySelector('#cake_pay_vendor_list')?.innerText ?? ''), { timeout: 120000 });
  await wait(4000);
  await shot('2-vendors');
  const n = await page.$$eval('#cake_pay_vendor_list button[id^="cake_pay_vendor_"]', (e) => e.length);
  step(`vendors (${await text('#cake_pay_country')}): ${n}; first: ${await text('#cake_pay_vendor_list button[id^="cake_pay_vendor_"]')}`);
  await page.type('#cake_pay_search', args.search || 'amazon');
  await wait(800);
  await page.waitForFunction(() => !document.querySelector('#cake_pay_vendor_list .spinner'), { timeout: 120000 }).catch(() => {});
  await wait(1500);
  const names = await page.$$eval('#cake_pay_vendor_list button[id^="cake_pay_vendor_"] span span:first-child', (e) => e.slice(0, 5).map((x) => x.innerText));
  step(`search "${args.search || 'amazon'}": ${JSON.stringify(names)}`);
  const first = await page.$('#cake_pay_vendor_list button[id^="cake_pay_vendor_"]');
  if (first) {
    await first.click();
    await page.waitForSelector('#cake_pay_buy_card_page');
    await wait(3000);
    await shot('3-card');
    step(`card page: ${(await text('#cake_pay_buy_card_page'))?.slice(0, 400)}`);
    const amount = await page.$('#cake_pay_amount');
    if (amount) {
      await page.evaluate(() => { const i = document.querySelector('#cake_pay_amount'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
      await page.type('#cake_pay_amount', '1');
      await wait(300);
      step(`amount 1: error "${await text('#cake_pay_amount_error')}"`);
    }
    // the purchase needs a synced wallet; with a session missing it leads to the login page
    const disabled = await page.$eval('#cake_pay_purchase', (b) => b.disabled);
    step(`purchase button disabled (not synced / amount): ${disabled}`);
    await page.evaluate(() => window.__cw.nav.pop());
    await wait(500);
  }
  await click('#cake_pay_profile');
  await page.waitForSelector('#cake_pay_welcome_page');
  await wait(400);
  await shot('4-welcome');
  step(`welcome: ${await text('#cake_pay_welcome_page')}`);
  await page.evaluate(() => window.__cw.nav.pop());
  // an order record, as a purchase leaves one, in the history and its details page
  await page.evaluate(async () => {
    const w = window.__cw.app.currentWallet.value;
    await window.__cw.cakepay.saveOrder({ id: 'demo-order-1', stateRaw: 'new', transferId: 'ext-1', from: 'XMR', to: 'EUR', createdAt: Date.now() - 60_000, amount: '0.123', receiveAmount: '50.00', quantity: '1', receiveAddress: '4abc', walletId: w.id, source: 'order', provider: 'cakePay' });
    window.__cw.nav.reset('/dashboard');
  });
  await wait(1500);
  const tile = await page.$('[id^="order_tile_"]');
  step(`order in the home history: ${tile ? await page.evaluate((e) => e.innerText.replace(/\s+/g, ' '), tile) : 'missing'}`);
  if (tile) {
    await tile.click();
    await page.waitForSelector('#order_details_page');
    await wait(4000);
    await shot('5-order');
    step(`order details: ${await text('#order_details_page')}`);
  }
} catch (e) {
  step(`FAILED: ${e.message}`);
  await shot('fail');
} finally {
  console.log('page errors:', errors.slice(0, 10));
  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
