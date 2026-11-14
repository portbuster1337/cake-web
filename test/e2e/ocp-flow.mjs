// Open CryptoPay end-to-end against a stand-in merchant (answered inside the page at the network
// router, so no shop is contacted): a Litecoin wallet scans a DFX-style payment link; the invoice
// and the Litecoin address/amount fill the form; dismissing the confirmation cancels the invoice;
// a second scan, with the wallet's transaction stubbed, goes through the swipe and is handed to the
// merchant (who would broadcast it) instead of being broadcast by the wallet.
//   node test/e2e/ocp-flow.mjs [--url http://127.0.0.1:8787/]
import { bech32 } from '@scure/base';
import { launch } from './launch.mjs';

const URL_ = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : 'http://127.0.0.1:8787/';
const LNURL = bech32.encode('lnurl', bech32.toWords(new TextEncoder().encode('https://ocp.test/lnurlp/abc')), false).toUpperCase();
const QR = `https://app.dfx.swiss/pl/?lightning=${LNURL}`;
// a valid Litecoin address nobody holds
const LTC = bech32.encode('ltc', [0, ...bech32.toWords(crypto.getRandomValues(new Uint8Array(20)))]);
const browser = await launch({ profile: `/tmp/opencode/cw-ocp-${Date.now()}`, width: 430, height: 900 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const click = async (sel, timeout = 30000) => { await page.waitForSelector(sel, { visible: true, timeout }); await page.click(sel); };
const pin = async (p) => { for (const d of p) await click(`#pin_code_button_${d}_key`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);

async function scan(code) {
  await click('#send_scan');
  await page.waitForSelector('#scan_page');
  await click('#scan_manual');
  await page.type('#scan_manual_input', code);
  await click('#scan_manual_submit');
  await page.waitForFunction(() => document.querySelector('#send_address')?.value?.startsWith('ltc1') || document.querySelector('.alert'), { timeout: 30000 });
  await wait(500);
}

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  await pin('1234'); await wait(300); await pin('1234');
  await click('.alert .acts button');
  await page.evaluate(async (ltc) => {
    const info = await window.__cw.app.createWallet('litecoin', { name: 'LTC' });
    await window.__cw.app.openWallet(info.id);
    // the stand-in merchant
    const r = window.__cw.net();
    const real = r.request.bind(r);
    window.__ocpLog = [];
    const json = (o, status = 200) => ({ status, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify(o)), via: 'tor' });
    r.request = async (req) => {
      const u = new URL(req.url);
      if (u.host !== 'ocp.test') return real(req);
      window.__ocpLog.push(`${req.method ?? 'GET'} ${u.pathname}${u.search}`);
      if (u.pathname === '/lnurlp/abc') return json({ callback: 'https://ocp.test/cb/abc', displayName: 'Coffee Shop', quote: { id: 'q1', expiration: new Date(Date.now() + 600000).toISOString() }, transferAmounts: [{ method: 'Litecoin', assets: [{ asset: 'LTC', amount: '0.25' }] }, { method: 'Bitcoin', assets: [{ asset: 'BTC', amount: '0.001' }] }] });
      if (u.pathname === '/cb/abc') return json({ expiryDate: new Date(Date.now() + 600000).toISOString(), uri: `litecoin:${ltc}` });
      if (u.pathname === '/cancel/abc') return json({});
      if (u.pathname === '/tx/abc') return json({ txId: u.searchParams.get('tx') });
      return json({ message: 'not found' }, 404);
    };
    window.__cw.nav.reset('/dashboard');
    window.__cw.nav.push('/send');
  }, LTC);
  await page.waitForSelector('#send_page');
  await scan(QR);
  step(`after the scan: address ${await page.$eval('#send_address', (e) => e.value)}, amount ${await page.$eval('#send_amount', (e) => e.value)}; requests ${JSON.stringify(await page.evaluate(() => window.__ocpLog))}`);
  // the confirmation (no coins: an error), dismissed → the invoice is cancelled, the form cleared
  await page.waitForFunction(() => window.__cw.app.currentWallet.value?.syncStatus.value.kind === 'synced', { timeout: 240000, polling: 1000 });
  await click('#send_page_send_button_key');
  await page.waitForFunction(() => document.querySelector('#send_error') || document.querySelector('#auth_sheet'), { timeout: 60000 });
  if (await page.$('#auth_sheet')) { await pin('1234'); await page.waitForSelector('#send_error', { timeout: 60000 }); }
  step(`confirmation: ${await text('#send_error')}`);
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Close')?.click());
  await wait(800);
  step(`after dismissing: address "${await page.$eval('#send_address', (e) => e.value)}"; requests ${JSON.stringify(await page.evaluate(() => window.__ocpLog.slice(2)))}`);
  // again, with the wallet's transaction stubbed: the swipe hands it to the merchant
  await page.evaluate(() => {
    const w = window.__cw.app.currentWallet.value;
    window.__broadcast = 0;
    w.createTransaction = async () => ({ id: 'ab'.repeat(32), hex: '0200beef', amount: 25000000n, fee: 1000n, amountFormatted: '0.25', feeFormatted: '0.00001', commit: async () => { window.__broadcast++; } });
  });
  await scan(QR);
  await click('#send_page_send_button_key');
  await page.waitForSelector('#send_page_confirm_swiper_key button', { timeout: 60000 }).catch(async () => { if (await page.$('#auth_sheet')) { await pin('1234'); await page.waitForSelector('#send_page_confirm_swiper_key button', { timeout: 60000 }); } });
  await page.focus('#send_page_confirm_swiper_key button');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#send_done') || document.querySelector('#send_error'), { timeout: 60000 });
  step(`after the swipe: ${await text('#send_done') ? 'sent' : await text('#send_error')}; broadcast by the wallet ${await page.evaluate(() => window.__broadcast)} time(s); requests ${JSON.stringify(await page.evaluate(() => window.__ocpLog.slice(-1)))}`);
} catch (e) {
  step(`FAILED: ${e.message}`);
  await page.screenshot({ path: '/tmp/opencode/ocp-fail.png' });
} finally {
  console.log('page errors:', errors.slice(0, 10));
  await browser.close();
}
