// Charts end-to-end against a stand-in price API (answered at the page's network router, so nothing
// is fetched): opening the tab (Cake's Init: 30D, market cap), the pinned header and the grid in
// Cake's number formats, the sort menu (a tap), a card's long-press menu (favorite, remove; the last
// asset can't be removed), a range change (the modal shares it), the chart modal (no Remove; its
// Favorite pins), adding an asset, the table kept across a reload.
//   node test/e2e/charts-flow.mjs [--url http://127.0.0.1:8787/]
import { launch } from './launch.mjs';

const URL_ = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : 'http://127.0.0.1:8787/';
const browser = await launch({ profile: `/tmp/opencode/cw-charts-${Date.now()}`, width: 430, height: 900 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const click = async (sel, timeout = 30000) => { await page.waitForSelector(sel, { visible: true, timeout }); await page.click(sel); };
const pin = async (p) => { for (const d of p) await click(`#pin_code_button_${d}_key`); };
const shot = (n) => page.screenshot({ path: `/tmp/opencode/chartsshot-${n}.png` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
const grid = () => page.$$eval('#charts_grid > button', (els) => els.map((e) => `${e.id.replace('chart_asset_', '')}=${e.querySelector('.chart_asset_price')?.innerText}`));
const loaded = () => page.waitForFunction(() => document.querySelector('#chart_change'), { timeout: 30000, polling: 100 });
/** a long press with the mouse: held 650 ms */
async function longPress(sel) {
  const b = await (await page.$(sel)).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await wait(650);
  await page.mouse.up();
  await page.waitForSelector('.lp-popup .lp-menu', { timeout: 5000 });
  await wait(350);
}
/** the stand-in price API: a straight line from the first price to the last over any range */
const installStandIn = () => page.evaluate(() => {
    const LINES = { 'crypto.BTC': [60000, 65432.12], 'crypto.XMR': [250.5, 240.25], 'crypto.ETH': [3000, 3300], 'crypto.LTC': [80, 90], 'crypto.DOGE': [0.1, 0.123456] };
    window.__priceLog = [];
    const r = window.__cw.net();
    const real = r.request.bind(r);
    r.request = async (req) => {
      const u = new URL(req.url);
      if (!/prices\.cakewallet\.com|cakeprcgc/.test(u.host)) return real(req);
      const base = u.searchParams.get('base');
      const interval = Number(u.searchParams.get('interval') || 0);
      const line = LINES[base] ?? [1, 1];
      const results = {};
      if (interval) {
        window.__priceLog.push(`${base}@${interval}`);
        const end = Number(u.searchParams.get('end'));
        const start = Math.max(Number(u.searchParams.get('start')), end - 400 * interval);
        const first = Math.ceil(start / interval) * interval;
        const n = Math.floor((end - first) / interval);
        for (let i = 0; i <= n; i++) results[first + i * interval] = line[0] + ((line[1] - line[0]) * i) / Math.max(1, n);
      } else results[Math.floor(Date.now() / 1000)] = line[1];
      return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: new TextEncoder().encode(JSON.stringify({ results })), via: 'tor' };
    };
});
const popupText = () => text('.lp-popup');
const closePopup = async () => { await page.mouse.click(10, 10); await page.waitForFunction(() => !document.querySelector('.lp-popup'), { timeout: 5000 }); };

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  await pin('1234'); await wait(300); await pin('1234');
  await click('.alert .acts button');
  await installStandIn();
  await page.evaluate(async () => {
    const info = await window.__cw.app.createWallet('litecoin', { name: 'LTC' });
    await window.__cw.app.openWallet(info.id);
    window.__cw.nav.reset('/dashboard');
  });
  await click('#nav_charts');
  await loaded();
  await wait(400);
  await shot('1-page');
  step(`header: ${await text('#charts_header')}`);
  step(`grid (market cap): ${JSON.stringify(await grid())}; requests ${JSON.stringify(await page.evaluate(() => window.__priceLog))}`);
  // the sort menu opens on a tap
  await click('#charts_sort');
  await page.waitForSelector('.lp-popup .lp-menu');
  await wait(350);
  await shot('2-sort-menu');
  step(`sort menu: ${await popupText()} | selected color ${await page.$eval('#charts_sort_marketcap', (e) => getComputedStyle(e).color)} vs ${await page.$eval('#charts_sort_gains', (e) => getComputedStyle(e).color)}`);
  await click('#charts_sort_losses');
  await wait(300);
  step(`grid (losses): ${JSON.stringify(await grid())}`);
  await click('#charts_sort');
  await page.waitForSelector('#charts_sort_alphabetical');
  await wait(350);
  await click('#charts_sort_alphabetical');
  await wait(300);
  step(`grid (alphabetical): ${JSON.stringify(await grid())}`);
  // a card's long-press menu: Monero as the favorite
  await longPress('#chart_asset_xmr');
  await shot('3-card-menu');
  step(`card menu: ${await popupText()} (footer: ${!!(await page.$('.lp-footer'))})`);
  await click('#charts_menu_favorite');
  await loaded();
  await wait(300);
  step(`pinned now: ${(await text('#charts_header'))?.slice(0, 60)}`);
  // the right button opens it too; Remove Ethereum
  const eth = await (await page.$('#chart_asset_eth')).boundingBox();
  await page.mouse.click(eth.x + 20, eth.y + 20, { button: 'right' });
  await page.waitForSelector('.lp-popup .lp-menu');
  await wait(350);
  await click('#charts_menu_remove');
  await loaded();
  await wait(300);
  step(`after removing Ethereum: ${JSON.stringify(await grid())}`);
  // removing the pinned Monero: the first asset is pinned
  await longPress('#chart_asset_xmr');
  await click('#charts_menu_remove');
  await loaded();
  await wait(300);
  step(`after removing the pinned Monero: grid ${JSON.stringify(await grid())}, header ${(await text('#charts_header'))?.slice(0, 40)}`);
  // the last asset: the note, and Remove does nothing
  await longPress('#chart_asset_btc');
  await shot('4-last-asset');
  step(`last asset: ${await popupText()}`);
  await click('#charts_menu_remove');
  await wait(400);
  step(`Remove on the last asset: popup still open ${!!(await page.$('.lp-popup'))}`);
  await closePopup();
  // add Litecoin and Dogecoin with Cake's picker
  for (const q of ['Litecoin', 'Dogecoin']) {
    await click('#charts_add');
    await page.waitForSelector('#swap_currency_picker');
    await page.type('#swap_currency_picker input', q);
    await wait(500);
    await page.evaluate((name) => [...document.querySelectorAll('#swap_currency_picker button')].find((b) => b.innerText.includes(name) && !b.innerText.includes('Cash'))?.click(), q);
    await wait(500);
    // a network to pick for tokens
    if (await page.$('#swap_currency_picker')) await page.evaluate(() => document.querySelector('#swap_currency_picker button[id^="network_"]')?.click());
    await loaded();
    await wait(300);
  }
  step(`after adding: ${JSON.stringify(await grid())}`);
  // a range: the page and the modal share it
  const before = (await page.evaluate(() => window.__priceLog.length));
  await click('#range_1D');
  await loaded();
  await wait(300);
  step(`1D: ${await text('#chart_change')}; requests ${JSON.stringify(await page.evaluate((n) => window.__priceLog.slice(n), before))}`);
  // the chart modal: Litecoin (the wallet's coin: Buy and Sell), no Remove, Favorite pins
  await click('#chart_asset_ltc');
  await page.waitForSelector('#chart_modal');
  await wait(500);
  await shot('5-modal');
  step(`modal: ${await text('#chart_modal')} | selected range ${await page.$eval('#chart_modal [aria-pressed="true"]', (e) => e.innerText)}`);
  await click('#chart_modal #range_7D');
  await page.waitForFunction(() => document.querySelector('#chart_modal #chart_change'), { timeout: 30000 });
  await wait(300);
  step(`modal at 7D, page range ${await page.$eval('#charts_header [aria-pressed="true"]', (e) => e.innerText)}`);
  await click('#chart_modal_favorite');
  await page.waitForFunction(() => !document.querySelector('#chart_modal'), { timeout: 5000 });
  await loaded();
  await wait(300);
  step(`after the modal's Favorite: ${(await text('#charts_header'))?.slice(0, 40)}`);
  // tapping the tab again starts over: 30D, market cap
  await click('#nav_charts');
  await loaded();
  await wait(300);
  step(`after re-opening the tab: range ${await page.$eval('#charts_header [aria-pressed="true"]', (e) => e.innerText)}, grid ${JSON.stringify(await grid())}`);
  await shot('6-reopened');
  // a reload keeps the table
  await page.reload({ waitUntil: 'domcontentloaded' });
  await pin('1234');
  await page.waitForSelector('#nav_charts', { timeout: 60000 });
  await installStandIn();
  await click('#nav_charts');
  await loaded();
  await wait(300);
  step(`after a reload: header ${(await text('#charts_header'))?.slice(0, 30)}, grid ${JSON.stringify(await grid())}`);
} catch (e) {
  step(`FAILED: ${e.message}`);
  await shot('fail');
} finally {
  console.log('page errors:', errors.slice(0, 10));
  await browser.close();
}
