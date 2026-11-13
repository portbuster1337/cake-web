// Swap end-to-end over Tor: restore a Bitcoin wallet, open Swap (BTC → XMR),
// enter an amount, wait for the providers' limits and best rate, look at the
// provider chooser, the configure and provider pages and the currency picker;
// then create a real trade (an order only: nothing is sent) to a fresh Monero
// address, check the confirm sheet, the external-send view, the trade in the
// history and its details page, and a status update.
//   node test/e2e/swap-flow.mjs [--url http://127.0.0.1:8787/] [--no-trade] [--amount 0.01] [--coin bitcoin|litecoin|dogecoin] [--no-sync-wait] [--log]
import fs from 'node:fs';
import { launch } from './launch.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const URL_ = args.url || 'http://127.0.0.1:8787/';
const profile = `/tmp/opencode/cw-swap-${Date.now()}`;
const browser = await launch({ profile, width: 430, height: 900 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const click = async (sel, timeout = 30000) => { await page.waitForSelector(sel, { visible: true, timeout }); await page.click(sel); };
const pin = async (p) => { for (const d of p) await click(`#pin_code_button_${d}_key`); };
const shot = (n) => page.screenshot({ path: `/tmp/opencode/swapshot-${n}.png` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const vmState = () => page.evaluate(() => {
  const el = document.querySelector('#swap_page');
  return {
    deposit: document.querySelector('#swap_page_deposit_amount_field_key')?.value,
    receive: document.querySelector('#swap_page_receive_amount_field_key')?.value,
    provider: document.querySelector('#swap_provider_preview')?.innerText.replace(/\s+/g, ' ').trim(),
    limit: document.querySelector('#swap_limit_popup')?.innerText.trim(),
    button: document.querySelector('#exchange_page_exchange_button_key')?.innerText.trim(),
    disabled: document.querySelector('#exchange_page_exchange_button_key')?.disabled,
    open: !!el,
  };
});

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  await pin('1234'); await wait(300); await pin('1234');
  await click('.alert .acts button');
  // a Monero wallet to receive into (no sync needed for its address), then the Bitcoin wallet
  const xmr = await page.evaluate(async () => {
    const info = await window.__cw.app.createWallet('monero', { name: 'Swap XMR', seedType: 'polyseed' });
    return info.address;
  });
  // the deposit wallet: the restored Bitcoin test wallet (slow to sync: long history), or a new wallet of --coin
  await page.evaluate(async (coin) => {
    const info = coin === 'bitcoin'
      ? await window.__cw.app.restoreWalletFromSeed('bitcoin', { name: 'Swap BTC', mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' })
      : await window.__cw.app.createWallet(coin, { name: `Swap ${coin}` });
    await window.__cw.app.openWallet(info.id);
    window.__cw.nav.reset('/dashboard');
  }, args.coin || 'bitcoin');
  step(`wallets ready; XMR receive address ${xmr.slice(0, 12)}…`);
  if (!args['no-sync-wait']) {
    await page.waitForFunction(() => window.__cw.app.currentWallet.value?.syncStatus.value.kind === 'synced', { timeout: 600000, polling: 1000 });
    step('deposit wallet synced');
  }
  await click('#home_swap');
  await page.waitForSelector('#swap_page');
  // a log of the view model's amounts, for diagnostics
  await page.evaluate(() => {
    window.__swaplog = [];
    const vm = window.__cw.swap;
    for (const k of ['depositMoney', 'receiveMoney', 'isFixedRateMode', 'bestRate', 'isSendAllEnabled']) vm[k].subscribe((v) => window.__swaplog.push(`${Math.round(performance.now())} ${k}=${v}`));
  });
  const mark = (m) => page.evaluate((x) => window.__swaplog?.push(`--- ${x}`), m);
  await wait(800);
  await shot('1-empty');
  step(`swap page: ${JSON.stringify(await vmState())}`);
  // amount
  const amount = args.amount || '0.01';
  await page.type('#swap_page_deposit_amount_field_key', amount);
  await page.waitForFunction(() => /≈/.test(document.querySelector('#swap_provider_preview')?.innerText ?? ''), { timeout: 120000 }).catch(() => {});
  await wait(1500);
  step(`quoted: ${JSON.stringify(await vmState())}`);
  await shot('2-quoted');
  // the provider chooser
  await click('#swap_provider_preview');
  await page.waitForSelector('#swap_provider_selector');
  await wait(400);
  step(`provider selector: ${await page.$eval('#swap_provider_selector', (e) => e.innerText.replace(/\s+/g, ' ').slice(0, 300))}`);
  await shot('3-selector');
  await mark('3-selector');
  await page.evaluate(() => window.__cw.nav.pop());
  // configure → providers
  await click('#swap_configure');
  await page.waitForSelector('#swap_options_page');
  await click('#swap_providers_row');
  await page.waitForSelector('#swap_providers_page');
  await wait(400);
  await shot('4-providers');
  await mark('4-providers');
  step(`providers page: ${await page.$eval('#swap_providers_page', (e) => e.innerText.replace(/\s+/g, ' ').slice(0, 400))}`);
  await page.evaluate(() => window.__cw.nav.pop());
  await page.evaluate(() => window.__cw.nav.pop());
  await page.waitForSelector('#swap_page');
  // receive currency picker
  await click('#swap_amount_box_receive_currency_button_key');
  await page.waitForSelector('#swap_currency_picker');
  await wait(500);
  await shot('5-picker');
  await mark('5-picker');
  step(`receive picker sections: ${await page.$eval('#swap_currency_picker', (e) => e.innerText.split('\n').filter((l) => /^[A-Z][a-z]+( [A-Za-z]+)*$/.test(l.trim())).slice(0, 12).join(' | '))}`);
  await page.evaluate(() => document.querySelector('#swap_currency_picker .topbar button')?.click());
  await wait(500);
  // the receiver: paste the Monero address through the receiver sheet
  await click('#swap_receiver_button');
  await page.waitForSelector('#swap_address_selection');
  await wait(400);
  await shot('6-receiver');
  await mark('6-receiver');
  const walletBtn = await page.$('#swap_address_selection button[id^="swap_wallet_"]');
  if (walletBtn) await walletBtn.click();
  else {
    await page.type('#swap_receiver_address', xmr);
    await click('#swap_receiver_submit');
  }
  await wait(800);
  step(`after the receiver: ${JSON.stringify(await vmState())}`);
  await shot('7-ready');
  await mark('7-ready');
  if (!args['no-trade']) {
    await page.waitForFunction(() => !document.querySelector('#exchange_page_exchange_button_key')?.disabled, { timeout: 60000 });
    await click('#exchange_page_exchange_button_key');
    // PIN (if asked)
    await wait(800);
    if (await page.$('#auth_sheet')) { await wait(400); await pin('1234'); }
    await page.waitForFunction(() => document.querySelector('#swap_confirm_sheet') || [...document.querySelectorAll('.alert')].length, { timeout: 180000 });
    await wait(1500);
    const alert = await page.$eval('.alert', (e) => e.innerText.replace(/\s+/g, ' ')).catch(() => null);
    if (alert) step(`trade failed: ${alert}`);
    else {
      await shot('8-confirm');
      step(`confirm sheet: ${await page.$eval('#swap_confirm_sheet', (e) => e.innerText.replace(/\s+/g, ' ').slice(0, 500))}`);
      const trade = await page.evaluate(() => window.__cw.trades.trades.value[0]);
      step(`stored trade: ${JSON.stringify({ id: trade.id, provider: trade.providerRaw, state: trade.stateRaw, amount: trade.amount, receive: trade.receiveAmount, input: trade.inputAddress?.slice(0, 12), payout: trade.payoutAddress?.slice(0, 12), refund: trade.refundAddress?.slice(0, 12), walletId: !!trade.walletId })}`);
      // close without sending
      await page.evaluate(() => document.querySelector('#swap_confirm_sheet .topbar button[aria-label="Close"]')?.click());
      await wait(1500);
      await page.evaluate(() => window.__cw.nav.reset('/dashboard'));
      await wait(1500);
      await shot('9-home');
      const tile = await page.$('[id^="trade_tile_"]');
      step(`trade in the home history: ${tile ? await page.evaluate((e) => e.innerText.replace(/\s+/g, ' '), tile) : 'missing'}`);
      if (tile) {
        await tile.click();
        await page.waitForSelector('#trade_details_page');
        await wait(8000);
        await shot('10-details');
        step(`details: ${await page.$eval('#trade_details_page', (e) => e.innerText.replace(/\s+/g, ' ').slice(0, 500))}`);
      }
    }
  }
} catch (e) {
  step(`FAILED: ${e.message}`);
  await shot('fail');
} finally {
  if (args.log) console.log((await page.evaluate(() => window.__swaplog ?? []).catch(() => [])).join('\n'));
  console.log('page errors:', errors.slice(0, 10));
  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
