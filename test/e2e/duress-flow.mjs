// Duress PIN: set one (equal to the regular PIN first: refused), lock, enter
// the duress PIN at the login page → every wallet is erased and the app is
// back at its first-run welcome page; a second run checks the in-app PIN
// prompt (requireAuth) as the trigger.
//   node test/e2e/duress-flow.mjs [--url http://127.0.0.1:8787/]
import fs from 'node:fs';
import { launch } from './launch.mjs';

const URL_ = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : 'http://127.0.0.1:8787/';
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const profiles = [];

async function setup(name) {
  const profile = `/tmp/opencode/cw-du-${name}-${Date.now()}`;
  profiles.push(profile);
  const browser = await launch({ profile, width: 430, height: 900 });
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  const click = async (sel, timeout = 30000) => { await page.waitForSelector(sel, { visible: true, timeout }); await page.click(sel); };
  const pin = async (p) => { for (const d of p) await click(`#pin_code_button_${d}_key`); };
  const okAlert = async () => { await page.waitForSelector('.alert .acts button', { visible: true, timeout: 30000 }).catch(async (e) => { await page.screenshot({ path: '/tmp/opencode/cw-du-fail.png' }); throw e; }); await page.evaluate(() => [...document.querySelectorAll('.alert .acts button')].pop().click()); await wait(300); };
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  await pin('1234'); await wait(300); await pin('1234');
  await click('.alert .acts button');
  await page.evaluate(async () => {
    const info = await window.__cw.app.createWallet('ethereum', { name: 'Duress test' });
    await window.__cw.app.openWallet(info.id);
    window.__cw.nav.reset('/dashboard');
  });
  // Settings → Security → Duress PIN
  await page.evaluate(() => window.__cw.nav.push('/security_and_backup_page'));
  await click('#security_duress');
  await page.waitForSelector('#auth_sheet', { visible: true });
  await wait(500);
  await pin('1234'); // requireAuth
  await okAlert(); // notice
  await okAlert(); // "Did you back up all your seeds?" → Yes
  const settled = async () => { await page.waitForFunction(() => !document.querySelector('.alert') && !document.querySelector('#auth_sheet'), { timeout: 30000 }); await wait(500); };
  await page.waitForFunction(() => [...document.querySelectorAll('.topbar .t')].some((e) => e.textContent === 'Duress PIN'), { timeout: 30000 });
  await settled();
  await pin('1234'); // same as the regular PIN
  await page.waitForSelector('.alert', { visible: true });
  const refused = await page.$eval('.alert', (e) => e.innerText.replace(/\s+/g, ' ').trim());
  await okAlert();
  await settled();
  await pin('9999');
  // the pad clears and asks again; taps before that are lost
  await page.waitForFunction(() => /again/i.test(document.body.innerText), { timeout: 30000 });
  await wait(600);
  await pin('9999');
  await okAlert(); // "Duress PIN set up successfully"
  await settled();
  return { browser, page, click, pin, refused };
}

const count = (page) => page.evaluate(() => ({ wallets: window.__cw.app.walletInfos.value.length, phase: window.__cw.app.phase.value }));

try {
  const A = await setup('login');
  step(`duress = regular PIN refused: "${A.refused}"`);
  step(`before: ${JSON.stringify(await count(A.page))}`);
  await A.page.evaluate(() => window.__cw.app.lock());
  await A.page.waitForSelector('#login_page');
  await A.pin('9999');
  await A.page.waitForFunction(() => window.__cw.app.phase.value === 'welcome', { timeout: 30000 });
  await wait(500);
  const left = await A.page.evaluate(async () => ({ setUp: await window.__cw.app.lockoutState().then(() => true), welcome: !!document.querySelector('#create_pin_welcome_page_create_a_pin_button_key') }));
  step(`after the duress PIN at login: ${JSON.stringify({ ...(await count(A.page)), ...left })}`);
  await A.page.reload({ waitUntil: 'domcontentloaded' });
  await A.page.waitForSelector('#create_pin_welcome_page_create_a_pin_button_key', { timeout: 30000 });
  step('after a reload: first-run welcome page (no PIN, no wallets)');
  await A.browser.close();

  const B = await setup('inapp');
  await B.page.evaluate(() => window.__cw.nav.reset('/dashboard'));
  await B.page.evaluate(() => window.__cw.nav.push('/settings'));
  await B.click('#settings_backup');
  await B.page.waitForSelector('#auth_sheet', { visible: true });
  await wait(500);
  await B.pin('9999');
  await B.page.waitForFunction(() => window.__cw.app.phase.value === 'welcome', { timeout: 30000 });
  step(`after the duress PIN at an in-app prompt: ${JSON.stringify(await count(B.page))}`);
  await B.browser.close();
} catch (e) {
  step(`FAILED: ${e.message}`);
} finally {
  console.log('page errors:', errors.slice(0, 10));
  for (const p of profiles) fs.rmSync(p, { recursive: true, force: true });
}
