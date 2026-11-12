// EVM end-to-end: set a PIN, restore the well-known "abandon … about" mnemonic
// as an Ethereum wallet through the UI, let it sync over Tor (balances via the
// RPC node, history via Blockscout), check the assets list, the token pages,
// the receive URI and a send fee estimate; then create a fresh wallet on each
// of the other EVM chains and check that its node answers.
//   node test/e2e/evm-flow.mjs [--url http://127.0.0.1:8787/]
import { launch } from './launch.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const URL_ = args.url || 'http://127.0.0.1:8787/';
const browser = await launch({ profile: `/tmp/opencode/cw-evm-${Date.now()}`, width: 430, height: 900 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const click = async (sel, timeout = 30000) => { await page.waitForSelector(sel, { visible: true, timeout }); await page.click(sel); };
const pin = async (p) => { for (const d of p) await click(`#pin_code_button_${d}_key`); };
const shot = (n) => page.screenshot({ path: `/tmp/opencode/cw-evm-${n}.png` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

async function waitSynced(name, timeoutMs = 300000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const st = await page.evaluate((n) => {
      const w = window.__cw.app.currentWallet.value;
      if (!w || w.name !== n) return null;
      const s = w.syncStatus.value;
      return { kind: s.kind, error: s.error, height: w.height.value, txs: w.transactions.value.length, bal: Object.fromEntries(Object.entries(w.balances.value).map(([k, v]) => [k, String(v.available)])) };
    }, name);
    if (st && (st.kind === 'synced' || st.kind === 'failed')) return st;
    if (Date.now() > end) throw new Error(`sync timeout: ${JSON.stringify(st)}`);
    await wait(2000);
  }
}

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  await pin('1234'); await wait(300); await pin('1234');
  await click('.alert .acts button');
  await page.evaluate(() => window.__cw.nav.push('/restore_wallet', { walletType: 'ethereum' }));
  await page.waitForSelector('#restore_seed');
  await page.type('#wallet_restore_name', 'ETH Abandon');
  await page.type('#restore_seed', MNEMONIC);
  await click('#wallet_restore_seed_or_key_restore_button_key');
  await page.waitForFunction(() => window.__cw.app.currentWallet.value?.name === 'ETH Abandon', { timeout: 60000 });
  const addr = await page.evaluate(() => window.__cw.app.currentWallet.value.receiveAddress.value);
  step(`restored, address ${addr} (expected 0x9858EfFD232B4033E47d90003D41EC34EcaEda94)`);
  const st = await waitSynced('ETH Abandon');
  step(`sync: ${JSON.stringify({ ...st, bal: Object.keys(st.bal).length + ' balances' })}`);
  const sample = await page.evaluate(() => window.__cw.app.currentWallet.value.transactions.value.slice(0, 3).map((x) => ({ id: x.id.slice(0, 10), dir: x.direction, cur: x.currency.slice(0, 10), amt: String(x.amount), sym: x.tokenSymbol, date: new Date(x.date).toISOString().slice(0, 10) })));
  step(`history sample: ${JSON.stringify(sample)}`);
  await page.waitForSelector('#assets_list', { timeout: 20000 });
  const assets = await page.$$eval('#assets_list button', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  step(`assets list (${assets.length}): ${JSON.stringify(assets.slice(0, 6))}`);
  await shot('1-home');
  // asset details sheet
  await page.click('#assets_list button');
  await page.waitForSelector('#asset_details', { timeout: 10000 });
  await shot('2-asset-details');
  await page.evaluate(() => window.__cw.app && document.querySelector('#asset_details .topbar button, #asset_details button')?.click());
  await wait(500);
  // home settings (tokens) page
  await page.evaluate(() => window.__cw.nav.push('/home_settings'));
  await page.waitForSelector('#home_settings_page', { timeout: 10000 });
  const tokenRows = await page.$$eval('#home_settings_page [id^="token_"]:not([id^="token_switch"])', (els) => els.length);
  step(`home settings: ${tokenRows} tokens listed`);
  await shot('3-home-settings');
  // add a custom token: the page reads name/symbol/decimals from the chain (LINK on Ethereum)
  await page.evaluate(() => window.__cw.nav.push('/edit_token', { contractAddress: '0x514910771af9ca656af840dff83e8264ecf986ca' }));
  await page.waitForSelector('#edit_token_page', { timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('#edit_token_symbol')?.value, { timeout: 60000 }).catch(() => {});
  const filled = await page.evaluate(() => ({ name: document.querySelector('#edit_token_name')?.value, symbol: document.querySelector('#edit_token_symbol')?.value, decimals: document.querySelector('#edit_token_decimals')?.value }));
  step(`edit token prefilled from chain: ${JSON.stringify(filled)}`);
  await shot('4-edit-token');
  await page.evaluate(() => window.__cw.nav.reset('/dashboard'));
  // receive: EIP-681 URI with chain id, and a token one
  await click('#home_receive');
  await page.waitForSelector('#receive_qr');
  const uri = await page.$eval('#receive_qr', (e) => e.getAttribute('data-qr'));
  step(`receive URI: ${uri}`);
  await shot('5-receive');
  await page.evaluate(() => window.__cw.nav.pop());
  // send: fee estimate (native and USDC)
  const fees = await page.evaluate(async () => {
    const w = window.__cw.app.currentWallet.value;
    const n = await w.estimateFee('medium');
    const e = await w.estimateFee('medium', undefined, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    return { native: String(n), erc20: String(e), priorities: w.priorities().map((p) => p.id) };
  });
  step(`fee estimates (wei): ${JSON.stringify(fees)}`);
  const signed = await page.evaluate(async () => {
    const w = window.__cw.app.currentWallet.value;
    const sig = await w.signMessage('hello from cake web');
    return { sig: sig.slice(0, 16), ok: await w.verifyMessage('hello from cake web', sig, w.receiveAddress.value) };
  });
  step(`personal_sign: ${JSON.stringify(signed)}`);
  await click('#home_send');
  await page.waitForSelector('#send_page');
  await shot('6-send');
  await page.evaluate(() => window.__cw.nav.pop());
  // the other chains: create a wallet and sync it
  for (const type of ['polygon', 'base', 'arbitrum', 'bsc', 'robinhood']) {
    const name = `T ${type}`;
    const ok = await page.evaluate(async (ty, n) => {
      const info = await window.__cw.app.createWallet(ty, { name: n });
      await window.__cw.app.openWallet(info.id);
      return info.address;
    }, type, name);
    const s = await waitSynced(name, 180000).catch((e) => ({ kind: 'timeout', error: e.message }));
    step(`${type}: ${ok.slice(0, 10)}… ${s.kind}${s.error ? ` (${s.error})` : ''} height ${s.height ?? '-'} balances ${s.bal ? Object.keys(s.bal).length : '-'}`);
  }
} catch (e) {
  step(`FAILED: ${e.message}`);
  await shot('fail');
} finally {
  console.log('page errors:', errors.slice(0, 10));
  await browser.close();
}
