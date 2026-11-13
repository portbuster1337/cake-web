// Wallet groups end-to-end: a Bitcoin wallet, then a new Ethereum wallet that
// joins its recovery phrase (group description → Choose Wallet Group → the
// wallet → name → "existing recovery phrase" page → Open Wallet), a Tron
// wallet joining the group of two, the wallet list's shared-seed group, and a
// second Bitcoin wallet, which no group can take (the empty state).
//   node test/e2e/group-flow.mjs [--url http://127.0.0.1:8787/]
import { launch } from './launch.mjs';

const URL_ = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : 'http://127.0.0.1:8787/';
const browser = await launch({ profile: `/tmp/opencode/cw-group-${Date.now()}`, width: 430, height: 900 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const click = async (sel, timeout = 30000) => { await page.waitForSelector(sel, { visible: true, timeout }); await page.click(sel); };
const pin = async (p) => { for (const d of p) await click(`#pin_code_button_${d}_key`); };
const shot = (n) => page.screenshot({ path: `/tmp/opencode/groupshot-${n}.png` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);

async function joinGroup(type, name, pick) {
  await page.evaluate(() => { window.__cw.nav.reset('/dashboard'); window.__cw.nav.push('/new_wallet_type'); });
  await click(`#wallet_type_${type}`);
  await page.waitForSelector('#wallet_group_description_page');
  await click('#wallet_group_description_page_choose_wallet_group_button_key');
  await page.waitForSelector('#wallet_groups_display_page');
  await wait(300);
  step(`${type}: groups offered: ${await text('#wallet_groups_display_page .page-body')}`);
  await click(pick);
  await click('#wallet_group_display_page_next_button_key');
  await page.waitForSelector('#new_wallet_page');
  await page.evaluate(() => { const i = document.querySelector('#new_wallet_page_wallet_name_textformfield_key'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.type('#new_wallet_page_wallet_name_textformfield_key', name);
  await click('#new_wallet_page_confirm_button_key');
  await page.waitForSelector('#wallet_group_existing_seed_page', { timeout: 120000 });
  await wait(300);
}

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  await pin('1234'); await wait(300); await pin('1234');
  await click('.alert .acts button');
  const btc = await page.evaluate(async () => {
    const info = await window.__cw.app.createWallet('bitcoin', { name: 'BTC', seedType: 'bip39' });
    await window.__cw.app.openWallet(info.id);
    return info.id;
  });
  // Ethereum joins the Bitcoin wallet
  await page.evaluate(() => { window.__cw.nav.reset('/dashboard'); window.__cw.nav.push('/new_wallet_type'); });
  await click('#wallet_type_ethereum');
  await page.waitForSelector('#wallet_group_description_page');
  await wait(400);
  await shot('1-description');
  step(`description: ${await text('#wallet_group_description_text')}`);
  await page.evaluate(() => window.__cw.nav.pop());
  await joinGroup('ethereum', 'ETH child', `#wallet_group_single_${btc}`);
  await shot('2-existing-seed');
  step(`existing seed page: ${await text('#wallet_group_existing_seed_text')}`);
  await click('#wallet_group_existing_seed_description_page_open_wallet_button_key');
  await page.waitForFunction(() => window.__cw.nav.top?.name === '/dashboard', { timeout: 30000 });
  // Tron joins the group of two
  await joinGroup('tron', 'TRX child', '#wallet_group_0');
  await click('#wallet_group_existing_seed_description_page_open_wallet_button_key');
  const r = await page.evaluate(async () => {
    const infos = window.__cw.app.walletInfos.value;
    const secrets = await Promise.all(infos.map((w) => window.__cw.app.getSecrets(w.id)));
    return infos.map((w, i) => ({ name: w.name, type: w.type, group: w.hashedWalletIdentifier?.slice(0, 10), sameSeed: secrets[i].mnemonic === secrets[0].mnemonic }));
  });
  step(`wallets: ${JSON.stringify(r)}`);
  // the wallet list's shared-seed group
  await page.evaluate(() => window.__cw.nav.reset('/dashboard'));
  await click('#nav_wallets');
  await page.waitForSelector('#wallet_list_page', { visible: true });
  await wait(500);
  await shot('3-wallet-list');
  step(`wallet list: ${await text('#wallet_list_page .page-body')}`);
  // a second Bitcoin wallet: every group has one already
  await page.evaluate(() => { window.__cw.nav.reset('/dashboard'); window.__cw.nav.push('/new_wallet_type'); });
  await click('#wallet_type_bitcoin');
  await click('#wallet_group_description_page_choose_wallet_group_button_key');
  await page.waitForSelector('#wallet_group_empty');
  await wait(300);
  await shot('4-empty');
  step(`bitcoin again: ${await text('#wallet_groups_display_page')}`);
} catch (e) {
  step(`FAILED: ${e.message}`);
  await shot('fail');
} finally {
  console.log('page errors:', errors.slice(0, 10));
  await browser.close();
}
