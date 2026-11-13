// Buy / Sell end-to-end over Tor: a new wallet, the card's Buy chip, Buy or Sell,
// a preset amount, DFX.swiss quotes (keyless; EUR), the payment methods, the
// confirmation and the redirect page, which signs in to DFX with the wallet's
// signature and prepares the app.dfx.swiss link (it is not opened).
//   node test/e2e/buy-flow.mjs [--url http://127.0.0.1:8787/] [--coin monero|bitcoin|ethereum|solana|tron] [--mode buy|sell] [--fiat EUR] [--amount 100 | --custom 150] [--no-launch]
import fs from 'node:fs';
import { launch } from './launch.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const URL_ = args.url || 'http://127.0.0.1:8787/';
const coin = args.coin || 'monero';
const mode = args.mode || 'buy';
const fiat = args.fiat || 'EUR';
const profile = `/tmp/opencode/cw-buy-${Date.now()}`;
const browser = await launch({ profile, width: 430, height: 900 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const click = async (sel, timeout = 30000) => { await page.waitForSelector(sel, { visible: true, timeout }); await page.click(sel); };
const pin = async (p) => { for (const d of p) await click(`#pin_code_button_${d}_key`); };
const shot = (n) => page.screenshot({ path: `/tmp/opencode/buyshot-${n}.png` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  await pin('1234'); await wait(300); await pin('1234');
  await click('.alert .acts button');
  await page.evaluate(async (c) => {
    const info = await window.__cw.app.createWallet(c, { name: `Buy ${c}`, ...(c === 'monero' ? { seedType: 'polyseed' } : {}) });
    await window.__cw.app.openWallet(info.id);
    window.__cw.nav.reset('/dashboard');
  }, coin);
  await page.waitForFunction(() => !!window.__cw.app.currentWallet.value?.receiveAddress.value, { timeout: 120000, polling: 500 });
  step(`${coin} wallet ready: ${await page.evaluate(() => window.__cw.app.currentWallet.value.receiveAddress.value.slice(0, 14))}…`);
  // the card's Buy chip → Buy or Sell
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Buy'), { timeout: 30000 });
  await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === 'Buy').click());
  await page.waitForSelector('#buy_sell_selector');
  await wait(400);
  await shot('1-selector');
  step(`selector: ${await text('#buy_sell_selector')}`);
  await click(`#buy_sell_selector_${mode}`);
  await page.waitForSelector('#buy_sell_amount_page');
  await wait(600);
  // the fiat
  const shown = await text('#buy_sell_fiat_pill');
  if (!shown?.includes(fiat)) {
    await click('#buy_sell_fiat_pill');
    await click(`#fiat_${fiat}`);
    await wait(600);
  }
  await shot('2-amount');
  step(`amount page: ${await text('#buy_sell_amount_page')}`);
  if (args.custom) {
    // Custom: the amount typed in, "≈ crypto" under it, "Up to ~…" in the top bar
    await click('#buy_sell_amount_custom');
    await page.waitForSelector('#buy_sell_custom_amount', { visible: true });
    await page.type('#buy_sell_custom_amount', args.custom);
    await page.waitForFunction(() => /\d/.test(document.querySelector('#buy_sell_custom_crypto')?.innerText ?? ''), { timeout: 120000 }).catch(() => {});
    await wait(1500);
    await shot('2b-custom');
    step(`custom: ${await text('#buy_sell_amount_page')}`);
    await click('#buy_sell_custom_continue');
  } else {
    // a preset amount (the second, or --amount)
    const amount = args.amount || (await page.evaluate(() => window.__cw.buy.defaultAmounts[1]));
    await click(`#buy_sell_amount_${amount}`);
  }
  await page.waitForSelector('#buy_sell_provider_page', { timeout: 120000 }).catch(async () => {
    step(`no provider page: ${await text('.alert')}`);
  });
  await page.waitForFunction(() => !document.querySelector('#buy_sell_loading_rates'), { timeout: 180000 }).catch(() => {});
  await wait(800);
  await shot('3-providers');
  step(`providers: ${await text('#buy_sell_provider_page')}`);
  step(`vm: ${JSON.stringify(await page.evaluate(() => {
    const vm = window.__cw.buy;
    return { fiat: vm.fiatAmount.value, crypto: vm.cryptoAmount.value, methods: vm.paymentMethods.value.map((m) => m.customTitle), quotes: vm.sortedRecommendedQuotes.value.map((q) => ({ p: q.provider.title, rate: q.rate, payout: q.payout, badges: q.recommendations, limits: q.limits })), state: vm.quoteState.value, address: vm.cryptoCurrencyAddress.value.slice(0, 14) };
  }))}`);
  if (await page.$('#buy_sell_payment_method_row')) {
    await click('#buy_sell_payment_method_row');
    await page.waitForSelector('#buy_sell_payment_method_page');
    await wait(400);
    await shot('4-methods');
    step(`methods: ${await text('#buy_sell_payment_method_page')}`);
    await page.evaluate(() => window.__cw.nav.pop());
    await wait(400);
  }
  const quote = await page.$('#buy_sell_quotes button[id^="buy_sell_quote_"]');
  if (quote) {
    await quote.click();
    await page.waitForSelector('#buy_sell_confirmation_page');
    await wait(500);
    await shot('5-confirm');
    step(`confirmation: ${await text('#buy_sell_confirmation_page')}`);
    if (!args['no-launch']) {
      await click('#buy_sell_proceed');
      await page.waitForSelector('#buy_sell_redirecting_page');
      await page.waitForFunction(() => document.querySelector('#buy_sell_open_provider') || document.querySelector('#buy_sell_redirect_error') || document.querySelector('.alert'), { timeout: 120000 }).catch(() => {});
      await wait(800);
      await shot('6-redirect');
      step(`redirect: ${await text('#buy_sell_redirecting_page')} ${(await text('.alert')) ?? ''}`);
      const link = await page.evaluate(() => {
        const b = document.querySelector('#buy_sell_open_provider');
        return b ? 'ready' : null;
      });
      if (link) {
        // the link itself (window.open stubbed: nothing leaves Tor in the test)
        const url = await page.evaluate(() => {
          let opened = null;
          window.open = (u) => { opened = u; return null; };
          document.querySelector('#buy_sell_open_provider').click();
          return opened;
        });
        step(`provider link: ${url?.replace(/session=[^&]+/, 'session=<token>').slice(0, 240)}`);
      }
    }
  }
} catch (e) {
  step(`FAILED: ${e.message}`);
  await shot('fail');
} finally {
  console.log('page errors:', errors.slice(0, 10));
  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
