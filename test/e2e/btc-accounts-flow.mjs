// Bitcoin accounts end-to-end (Cake's optional "Multiple Accounts"): a new
// Bitcoin wallet whose indexer is replaced by a stand-in answering from the
// wallet's own address records (a payment to account 0's and to account 1's
// first receive address, nothing else), so no coins and no network are needed.
// The accounts page with the toggle off, turning it on (the one-time discovery
// finds "Account 1" and stops at account 2), per-account balance / history /
// receive address / address types, adding an account from the page (Cake's
// random card design), the addresses page header, the home card label, and
// turning the toggle off again (back to the primary account).
//   node test/e2e/btc-accounts-flow.mjs [--url http://127.0.0.1:8787/]
import { launch } from './launch.mjs';

const URL_ = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : 'http://127.0.0.1:8787/';
const browser = await launch({ profile: `/tmp/opencode/cw-btcacc-${Date.now()}`, width: 430, height: 900 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const click = async (sel, timeout = 30000) => { await page.waitForSelector(sel, { visible: true, timeout }); await page.click(sel); };
const pin = async (p) => { for (const d of p) await click(`#pin_code_button_${d}_key`); };
const shot = (n) => page.screenshot({ path: `/tmp/opencode/btcaccshot-${n}.png` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
const view = () => page.evaluate(() => {
  const w = window.__cw.app.currentWallet.value;
  const b = w.balances.value[w.currency.key];
  return {
    multi: w.isMultiAccountsEnabled,
    current: w.currentAccount.value,
    accounts: w.accounts.value.map((a) => `${a.index}:${a.label}:${a.balance}`),
    balance: String(b?.full ?? 0n),
    txs: w.transactions.value.map((x) => `${x.direction}:${x.amount}`),
    receive: w.receiveAddress.value,
    receivePath: (() => { const r = w.state.addresses.find((a) => a.address === w.receiveAddress.value); return r ? `${r.account}/${r.type}/${r.change ? 1 : 0}/${r.index}` : null; })(),
    options: w.receiveOptions().map((o) => o.id).join(','),
    unspents: w.unspents.value.length,
    syncing: w.syncStatus.value.kind,
  };
});
const synced = () => page.waitForFunction(() => window.__cw.app.currentWallet.value?.syncStatus.value.kind === 'synced', { timeout: 120000, polling: 300 });

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  await pin('1234'); await wait(300); await pin('1234');
  await click('.alert .acts button');
  await page.evaluate(async () => {
    window.__cw.settings.value = { ...window.__cw.settings.value, useMempoolFeeAPI: false, dismissedPromos: { ...window.__cw.settings.value.dismissedPromos, education_accounts: true } };
    const info = await window.__cw.app.createWallet('bitcoin', { name: 'BTC accounts', seedType: 'bip39' });
    const w = await window.__cw.app.openWallet(info.id);
    // the stand-in indexer: account 0's and account 1's first P2WPKH receive addresses were each paid once
    const paid = (addr) => {
      const r = w.state.addresses.find((a) => a.address === addr);
      if (!r || r.type !== 'p2wpkh' || r.change || r.index !== 0 || r.legacy) return null;
      return r.account === 0 ? 30000n : r.account === 1 ? 50000n : null;
    };
    const txOf = (addr, value) => ({ txid: (addr.slice(-8) + '0'.repeat(56)).replace(/[^0-9a-f]/g, 'a').slice(0, 64), height: 899990, time: Math.floor(Date.now() / 1000) - 3600, fee: 200n, vsize: 110, inputs: [{ txid: 'b'.repeat(64), vout: 0, address: 'bc1qexternalsenderxxxxxxxxxxxxxxxxxxxxxx', value: value + 200n, sequence: 0xffffffff }], outputs: [{ n: 0, address: addr, value }] });
    const calls = { address: 0, txs: 0 };
    window.__fakeCalls = calls;
    w.indexer = {
      kind: 'esplora', url: 'fake://indexer',
      tip: async () => ({ height: 900000 }),
      address: async (addr) => { calls.address++; const v = paid(addr); return { address: addr, txCount: v ? 1 : 0, confirmed: v ?? 0n, unconfirmed: 0n }; },
      addressTxs: async (addr) => { calls.txs++; const v = paid(addr); return v ? [txOf(addr, v)] : []; },
      utxos: async () => [], tx: async () => { throw new Error('no'); }, txHex: async () => '', broadcast: async () => { throw new Error('offline test'); },
      fees: async () => ({ 1: 5, 5: 3, 10: 1 }),
    };
    window.__cw.nav.reset('/dashboard');
    // connect() asked the real indexer for the tip before the swap; sync with the stand-in now
    await w.sync(true);
  });
  await synced();
  step(`new wallet (accounts off): ${JSON.stringify(await view())}`);
  step(`home card label: ${await text('#balance_card_label')}`);
  // the accounts page with the toggle off
  await page.evaluate(() => window.__cw.nav.push('/wallet_accounts_page'));
  await page.waitForSelector('#wallet_accounts_page');
  await wait(400);
  await shot('1-off');
  step(`accounts page (off): ${await text('#wallet_accounts_page')} | deck cards: ${(await page.$$('[id^="account_card_"]')).length} | archived button: ${!!(await page.$('#archived_accounts_button'))}`);
  // on: the one-time discovery
  const before = await page.evaluate(() => ({ ...window.__fakeCalls }));
  await click('#multiple_accounts_toggle');
  await page.waitForFunction(() => window.__cw.app.currentWallet.value.accounts.value.length > 1 && window.__cw.app.currentWallet.value.syncStatus.value.kind === 'synced', { timeout: 120000, polling: 300 });
  await wait(600);
  const after = await page.evaluate(() => ({ ...window.__fakeCalls, limit: window.__cw.app.currentWallet.value.info.accountDiscoveryLimit, stored: Object.keys(window.__cw.app.currentWallet.value.state.accountLabels) }));
  step(`after turning it on: ${JSON.stringify(await view())}`);
  step(`discovery: ${after.address - before.address} address lookups, ${after.txs - before.txs} histories, limit ${after.limit}, stored accounts ${JSON.stringify(after.stored)}`);
  await shot('2-on');
  step(`accounts page (on): ${await text('#wallet_accounts_page')}`);
  // account 1 to the front: its balance, history, receive address and types
  await click('#account_card_1');
  await page.waitForFunction(() => window.__cw.app.currentWallet.value.currentAccount.value === 1, { timeout: 15000 });
  await wait(400);
  step(`account 1: ${JSON.stringify(await view())}`);
  // a new account from the page
  await click('#add_account');
  await page.waitForSelector('#account_creation');
  await page.type('#account_creation_name', 'Savings');
  await click('#account_creation_continue');
  await page.waitForFunction(() => window.__cw.app.currentWallet.value.currentAccount.value === 2, { timeout: 30000 });
  await synced();
  await wait(800);
  const design = await page.evaluate(() => { const w = window.__cw.app.currentWallet.value; return window.__cw.settings.value.cardDesigns[`${w.id}:2`]; });
  step(`after adding: ${JSON.stringify(await view())} design ${JSON.stringify(design)}`);
  await shot('3-added');
  // the receive and addresses pages of the new account
  await page.evaluate(() => { window.__cw.nav.reset('/dashboard'); window.__cw.nav.push('/receive'); });
  await page.waitForSelector('#receive_page');
  await wait(400);
  step(`receive page: type picker ${!!(await page.$('#receive_address_type'))}`);
  await page.evaluate(() => window.__cw.nav.push('/receive_addresses'));
  await page.waitForSelector('#addresses_page').catch(() => {});
  await wait(400);
  await shot('4-addresses');
  step(`addresses header: ${await text('#account_preview_header')}`);
  await page.evaluate(() => window.__cw.nav.reset('/dashboard'));
  await wait(500);
  step(`home card label: ${await text('#balance_card_label')} amount ${await text('#balance_card_amount')}`);
  // off: back to the primary account
  await page.evaluate(() => window.__cw.nav.push('/wallet_accounts_page'));
  await page.waitForSelector('#wallet_accounts_page');
  await click('#multiple_accounts_toggle');
  await wait(800);
  step(`after turning it off: ${JSON.stringify(await view())}`);
  await page.evaluate(() => window.__cw.nav.reset('/dashboard'));
  await wait(500);
  step(`home card label: ${await text('#balance_card_label')}`);
  // a reload keeps the accounts and the toggle
  await page.reload({ waitUntil: 'domcontentloaded' });
  await pin('1234');
  await page.waitForFunction(() => !!window.__cw?.app.currentWallet.value, { timeout: 60000, polling: 300 });
  await wait(1000);
  step(`after a reload: ${JSON.stringify(await page.evaluate(() => { const w = window.__cw.app.currentWallet.value; return { multi: w.isMultiAccountsEnabled, current: w.currentAccount.value, accounts: w.accounts.value.map((a) => `${a.index}:${a.label}`), info: { cur: w.info.currentAccountIndex, limit: w.info.accountDiscoveryLimit } }; }))}`);
} catch (e) {
  step(`FAILED: ${e.message}`);
  await shot('fail');
} finally {
  console.log('page errors:', errors.slice(0, 10));
  await browser.close();
}
