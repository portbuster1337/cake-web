// AnyPay end-to-end (no coins needed): from a Bitcoin wallet, scanned requests for other networks —
// a Litecoin address with no Litecoin wallet (the decision page, then the swap page in Cake's
// "from send" mode: Litecoin to that address at a fixed rate); with a Litecoin wallet (switch to
// it: its send page with the address); a bare EVM address (pick its network); an unsupported EVM
// chain; then in an Ethereum wallet a USDT transfer request (the token and its amount selected) and
// the recipient-network selector.
//   node test/e2e/anypay-flow.mjs [--url http://127.0.0.1:8787/]
import { bech32 } from '@scure/base';
import { launch } from './launch.mjs';

const URL_ = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : 'http://127.0.0.1:8787/';
const browser = await launch({ profile: `/tmp/opencode/cw-anypay-${Date.now()}`, width: 430, height: 900 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const click = async (sel, timeout = 30000) => { await page.waitForSelector(sel, { visible: true, timeout }); await page.click(sel); };
const pin = async (p) => { for (const d of p) await click(`#pin_code_button_${d}_key`); };
const shot = (n) => page.screenshot({ path: `/tmp/opencode/anypayshot-${n}.png` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
const top = () => page.evaluate(() => window.__cw.nav.top?.name);
// a valid Litecoin address nobody holds
const LTC = bech32.encode('ltc', [0, ...bech32.toWords(crypto.getRandomValues(new Uint8Array(20)))]);
const ETH = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';

/** the send page's Scan, typed in by hand */
async function scan(code) {
  await click('#send_scan');
  await page.waitForSelector('#scan_page');
  await click('#scan_manual');
  await page.type('#scan_manual_input', code);
  await click('#scan_manual_submit');
  await wait(1200);
}

async function openSend(walletId) {
  await page.evaluate(async (id) => { await window.__cw.app.openWallet(id); window.__cw.nav.reset('/dashboard'); window.__cw.nav.push('/send'); }, walletId);
  await page.waitForSelector('#send_page');
  await wait(300);
}

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  await pin('1234'); await wait(300); await pin('1234');
  await click('.alert .acts button');
  const ids = await page.evaluate(async () => ({
    btc: (await window.__cw.app.createWallet('bitcoin', { name: 'BTC' })).id,
    eth: (await window.__cw.app.createWallet('ethereum', { name: 'ETH' })).id,
  }));
  // 1. a Litecoin address, no Litecoin wallet
  await openSend(ids.btc);
  await scan(`litecoin:${LTC}?amount=0.5`);
  await page.waitForSelector('#anypay_decision_page', { timeout: 15000 });
  await shot('1-decision-swap');
  step(`Litecoin request, no wallet: ${await text('#anypay_decision_page')}`);
  await click('#anypay_decision_primary');
  await page.waitForSelector('#swap_page', { timeout: 15000 });
  await wait(1500);
  const swap = await page.evaluate(() => { const vm = window.__cw.swap; return { receive: vm?.receiveCurrency.value.title, address: vm?.receiveAddress.value, fixed: vm?.isFixedRateMode.value, amount: vm?.receiveAmount }; });
  await shot('2-swap-from-send');
  step(`swap page: ${JSON.stringify(swap)} | ${(await text('#swap_page'))?.slice(0, 120)}`);
  // 2. with a Litecoin wallet: switch to it
  const ltcId = await page.evaluate(async () => (await window.__cw.app.createWallet('litecoin', { name: 'LTC' })).id);
  await openSend(ids.btc);
  await scan(`litecoin:${LTC}?amount=0.5`);
  await page.waitForSelector('#anypay_decision_page', { timeout: 15000 });
  await shot('3-decision-switch');
  step(`with a Litecoin wallet: ${await text('#anypay_decision_page')}`);
  await click('#anypay_decision_primary');
  await page.waitForFunction((id) => window.__cw.app.currentWallet.value?.id === id && window.__cw.nav.top?.name === '/send', { timeout: 60000, polling: 300 }, ltcId);
  await page.waitForSelector('#send_page');
  await wait(800);
  step(`after switching: wallet ${await page.evaluate(() => window.__cw.app.currentWallet.value.name)}, address ${await page.$eval('#send_address', (e) => e.value)}, amount ${await page.$eval('#send_amount', (e) => e.value)}`);
  // 3. a bare EVM address in the Bitcoin wallet: its network
  await openSend(ids.btc);
  await scan(ETH);
  await page.waitForSelector('#anypay_evm_sheet', { timeout: 15000 });
  await shot('4-evm-sheet');
  step(`bare EVM address: ${await text('#anypay_evm_sheet')}`);
  await click('#anypay_network_137');
  await page.waitForSelector('#anypay_decision_page', { timeout: 15000 });
  step(`Polygon picked: ${await text('#anypay_decision_page')}`);
  await click('#anypay_decision_secondary');
  await wait(500);
  // 4. an unsupported chain
  await scan(`ethereum:${ETH}@10`);
  await page.waitForSelector('.alert', { timeout: 15000 });
  step(`chain 10: ${await text('.alert')}`);
  await page.evaluate(() => document.querySelector('.alert .acts button')?.click());
  await wait(400);
  // 5. the Ethereum wallet: a USDT request
  await openSend(ids.eth);
  await scan(`ethereum:${USDT}@1/transfer?address=${ETH}&uint256=2500000`);
  await wait(800);
  await shot('5-usdt');
  const form = await page.evaluate(() => ({ address: document.querySelector('#send_address')?.value, amount: document.querySelector('#send_amount')?.value, asset: document.querySelector('#send_asset')?.innerText ?? null }));
  step(`USDT request in the Ethereum wallet: ${JSON.stringify(form)} top ${await top()} | ${(await text('#send_page'))?.slice(0, 140)}`);
  // 6. the recipient network selector
  step(`selector: ${await text('#anypay_recipient_network')}`);
  await click('#anypay_recipient_network');
  await page.waitForSelector('#anypay_recipient_network_sheet');
  await shot('6-recipient-network');
  step(`recipient networks: ${await text('#anypay_recipient_network_sheet')}`);
  await click('#anypay_network_8453');
  await page.waitForSelector('#anypay_decision_page', { timeout: 15000 });
  step(`Base picked: ${await text('#anypay_decision_page')}`);
} catch (e) {
  step(`FAILED: ${e.message}`);
  await shot('fail');
} finally {
  console.log('page errors:', errors.slice(0, 10));
  await browser.close();
}
