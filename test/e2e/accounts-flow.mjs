// Accounts end-to-end: a Monero wallet with three accounts; the accounts page
// (Cake's description, the card deck with the active account in front), a tap
// that brings a card to the front and selects its account, archiving the front
// account from its card customizer (Cake's confirmation), the archived-accounts
// page and bringing the account back.
//   node test/e2e/accounts-flow.mjs [--url http://127.0.0.1:8787/]
import { launch } from './launch.mjs';

const URL_ = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : 'http://127.0.0.1:8787/';
const browser = await launch({ profile: `/tmp/opencode/cw-acc-${Date.now()}`, width: 430, height: 900 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const click = async (sel, timeout = 30000) => { await page.waitForSelector(sel, { visible: true, timeout }); await page.click(sel); };
const pin = async (p) => { for (const d of p) await click(`#pin_code_button_${d}_key`); };
const shot = (n) => page.screenshot({ path: `/tmp/opencode/accshot-${n}.png` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
const state = () => page.evaluate(() => { const w = window.__cw.app.currentWallet.value; return { current: w.currentAccount.value, layout: window.__cw.settings.value.accountCards[w.id] ?? null, deck: [...document.querySelectorAll('[id^="account_card_"]')].map((e) => Number(e.id.slice(13))) }; });

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  await pin('1234'); await wait(300); await pin('1234');
  await click('.alert .acts button');
  await page.evaluate(async () => {
    const info = await window.__cw.app.createWallet('monero', { name: 'Accounts', seedType: 'polyseed' });
    const w = await window.__cw.app.openWallet(info.id);
    window.__cw.nav.reset('/dashboard');
    // the education was seen
    window.__cw.settings.value = { ...window.__cw.settings.value, dismissedPromos: { ...window.__cw.settings.value.dismissedPromos, education_accounts: true } };
    void w;
  });
  await page.waitForFunction(() => window.__cw.app.currentWallet.value?.syncStatus.value.kind === 'synced', { timeout: 300000, polling: 1000 });
  await page.evaluate(async () => { const w = window.__cw.app.currentWallet.value; await w.addAccount('Savings'); await w.addAccount('Spending'); });
  await page.waitForFunction(() => window.__cw.app.currentWallet.value.accounts.value.length === 3, { timeout: 60000 });
  step(`accounts: ${await page.evaluate(() => window.__cw.app.currentWallet.value.accounts.value.map((a) => `${a.index}:${a.label}`).join(', '))}`);
  await page.evaluate(() => window.__cw.nav.push('/wallet_accounts_page'));
  await page.waitForSelector('#wallet_accounts_page');
  await wait(600);
  await shot('1-deck');
  step(`page: ${await text('#wallet_accounts_page')} ${JSON.stringify(await state())}`);
  // a back card to the front
  const back = await page.$('[id^="account_card_"]');
  await back.click();
  await wait(1500);
  step(`after a tap: ${JSON.stringify(await state())}`);
  // archive the front card's account
  const menus = await page.$$eval('#wallet_accounts_page .balance-card button[aria-label="Menu"]', (l) => l.length);
  await page.evaluate(() => [...document.querySelectorAll('#wallet_accounts_page .balance-card button[aria-label="Menu"]')].pop().click());
  await page.waitForSelector('#card_customizer_page', { timeout: 15000 }).catch(async () => { step(`no customizer (menus ${menus}): top ${await page.evaluate(() => window.__cw.nav.top?.name)} alert ${await text('.alert')}`); throw new Error('customizer'); });
  await click('#archive_account');
  await page.waitForSelector('#archive_confirmation');
  await wait(300);
  await shot('2-archive-confirm');
  step(`confirmation: ${await text('.alert')}`);
  await page.evaluate(() => [...document.querySelectorAll('.alert .acts button')].pop().click());
  await page.waitForSelector('#wallet_accounts_page');
  await wait(800);
  await shot('3-after-archive');
  step(`after archiving: ${JSON.stringify(await state())}`);
  await click('#archived_accounts_button');
  await page.waitForSelector('#archived_accounts_page');
  await wait(300);
  await shot('4-archived');
  step(`archived page: ${await text('#archived_accounts_page')}`);
  await click('#archived_accounts_page button[id^="archived_account_"]');
  await page.waitForSelector('.alert');
  step(`unarchive confirmation: ${await text('.alert')}`);
  await page.evaluate(() => [...document.querySelectorAll('.alert .acts button')].pop().click());
  await wait(800);
  step(`archived page after: ${await text('#archived_accounts_page')}`);
  await page.evaluate(() => window.__cw.nav.pop());
  await wait(600);
  step(`deck again: ${JSON.stringify(await state())}`);
} catch (e) {
  step(`FAILED: ${e.message}`);
  await shot('fail');
} finally {
  console.log('page errors:', errors.slice(0, 10));
  await browser.close();
}
