// Bridge end-to-end over Tor: an Arbitrum wallet and an Ethereum wallet; on the
// Arbitrum one (with a USDT balance injected — nothing is held for real) the
// asset's Bridge button, the amount, the destination network, the receiving
// wallet, the confirmation with LayerZero's fee from quoteSend over the
// wallet's node, the swipe (the node refuses: no real USDT), then the bridge
// history with a recorded transfer and its details.
//   node test/e2e/bridge-flow.mjs [--url http://127.0.0.1:8787/] [--coin arbitrum|polygon|ethereum]
import { launch } from './launch.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const URL_ = args.url || 'http://127.0.0.1:8787/';
const coin = args.coin || 'arbitrum';
const browser = await launch({ profile: `/tmp/opencode/cw-bridge-${Date.now()}`, width: 430, height: 900 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const click = async (sel, timeout = 30000) => { await page.waitForSelector(sel, { visible: true, timeout }); await page.click(sel); };
const pin = async (p) => { for (const d of p) await click(`#pin_code_button_${d}_key`); };
const shot = (n) => page.screenshot({ path: `/tmp/opencode/bridgeshot-${n}.png` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  await pin('1234'); await wait(300); await pin('1234');
  await click('.alert .acts button');
  const usdtKey = await page.evaluate(async (c) => {
    const other = c === 'ethereum' ? 'arbitrum' : 'ethereum';
    await window.__cw.app.createWallet(other, { name: `Receiving ${other}` });
    const info = await window.__cw.app.createWallet(c, { name: `Bridge ${c}` });
    const w = await window.__cw.app.openWallet(info.id);
    window.__cw.nav.reset('/dashboard');
    const usdt = w.assetList().find((a) => a.symbol === 'USDT');
    return usdt?.key;
  }, coin);
  await page.waitForFunction(() => window.__cw.app.currentWallet.value?.syncStatus.value.kind === 'synced', { timeout: 180000, polling: 1000 });
  // a balance to bridge, and native coin for the fees (both only in this page)
  await page.evaluate((k) => {
    const w = window.__cw.app.currentWallet.value;
    w.balances.value = { ...w.balances.value, [k]: { available: 25_000_000n, full: 25_000_000n }, [w.currency.key]: { available: 10n ** 17n, full: 10n ** 17n } };
  }, usdtKey);
  step(`${coin} wallet synced; USDT key ${usdtKey}`);
  await click('#asset_USDT', 60000);
  await page.waitForSelector('#asset_details');
  step(`asset details: ${await text('#asset_details')}`);
  await click('#asset_bridge');
  await page.waitForSelector('#bridge_amount_page');
  await page.type('#bridge_amount', '12.5');
  await wait(400);
  await shot('1-amount');
  step(`amount page: ${await text('#bridge_amount_page')}`);
  await click('#bridge_amount_next');
  await page.waitForSelector('#bridge_network_page');
  await wait(300);
  await shot('2-network');
  step(`network page: ${await text('#bridge_network_page')}`);
  await click('#bridge_network_1, #bridge_network_42161');
  await page.waitForSelector('#bridge_receiving_wallet_page');
  await wait(300);
  await shot('3-receiving');
  step(`receiving page: ${await text('#bridge_receiving_wallet_page')}`);
  await click('#bridge_receiving_wallet_page button[id^="bridge_receiving_"]');
  await page.waitForSelector('#bridge_confirm_sheet');
  await page.waitForFunction(() => !document.querySelector('#bridge_quote_loading') && (document.querySelector('#bridge_confirm_fee') || document.querySelector('#bridge_quote_error')), { timeout: 180000 });
  await wait(500);
  if (await page.$('#bridge_confirm_to')) await page.click('#bridge_confirm_to');
  await wait(300);
  await shot('4-confirm');
  step(`confirm: ${await text('#bridge_confirm_sheet')}`);
  if (await page.$('#send_page_confirm_swiper_key button')) {
    await page.focus('#send_page_confirm_swiper_key button');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#bridge_execute_error') || document.querySelector('#bridge_success_sheet'), { timeout: 240000 });
    await wait(500);
    await shot('5-executed');
    step(`after the swipe: ${(await text('#bridge_execute_error')) ?? (await text('#bridge_success_sheet'))}`);
  }
  // the history with a transfer as one is recorded, and its details
  await page.evaluate(async () => {
    const w = window.__cw.app.currentWallet.value;
    await window.__cw.bridge.addBridgeTransfer({ id: 'demo_1', walletId: w.id, sourceChainId: w.chainId, destinationChainId: 1, tokenSymbol: 'USDT', tokenContract: '0x', amount: '12.5', recipientAddress: w.address, sourceTxHash: `0x${'ab'.repeat(32)}`, status: 'completed', createdAt: Date.now() - 600_000 });
    await window.__cw.bridge.addBridgeTransfer({ id: 'demo_2', walletId: w.id, sourceChainId: w.chainId, destinationChainId: 137, tokenSymbol: 'USDT', tokenContract: '0x', amount: '3', recipientAddress: w.address, sourceTxHash: `0x${'cd'.repeat(32)}`, status: 'failed', errorMessage: 'Transaction reverted', createdAt: Date.now() - 300_000 });
  });
  await page.evaluate(() => document.querySelector('#bridge_confirm_sheet button[aria-label="Close"]')?.click());
  await wait(400);
  await page.evaluate(() => { window.__cw.nav.reset('/dashboard'); window.__cw.nav.push('/bridge_history_page'); });
  await page.waitForSelector('#bridge_history_page');
  await wait(500);
  await shot('6-history');
  step(`history: ${await text('#bridge_history_page')}`);
  await click('#bridge_history_list button[id^="bridge_transfer_"]');
  await page.waitForSelector('#bridge_detail_page');
  await wait(300);
  await shot('7-detail');
  step(`detail: ${await text('#bridge_detail_page')}`);
} catch (e) {
  step(`FAILED: ${e.message}`);
  await shot('fail');
} finally {
  console.log('page errors:', errors.slice(0, 10));
  await browser.close();
}
