// Addresses page end-to-end (lib/new-ui/pages/addresses_page.dart): a Litecoin wallet's addresses —
// a tap selects one and stays on the page; a long press opens Cake's menu (Set label, Hide address,
// Info); the label dialog (Enter saves), the info dialog, hiding and unhiding; the address picker
// (pickerWalletAddress) returns the tapped address.
//   node test/e2e/addresses-flow.mjs [--url http://127.0.0.1:8787/]
import { launch } from './launch.mjs';

const URL_ = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : 'http://127.0.0.1:8787/';
const browser = await launch({ profile: `/tmp/opencode/cw-addr-${Date.now()}`, width: 430, height: 900 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const click = async (sel, timeout = 30000) => { await page.waitForSelector(sel, { visible: true, timeout }); await page.click(sel); };
const pin = async (p) => { for (const d of p) await click(`#pin_code_button_${d}_key`); };
const shot = (n) => page.screenshot({ path: `/tmp/opencode/addrshot-${n}.png` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
const top = () => page.evaluate(() => window.__cw.nav.top?.name);
const rows = () => page.$$eval('#addresses_page [id^="address_row_"]', (els) => els.map((e) => `${e.id.slice(12)}${e.querySelector('img[src*="checkmark"]') ? '✓' : ''}`));
async function longPress(sel) {
  const b = await (await page.$(sel)).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await wait(650);
  await page.mouse.up();
  await page.waitForSelector('.lp-popup .lp-menu', { timeout: 5000 });
  await wait(350);
}

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  await pin('1234'); await wait(300); await pin('1234');
  await click('.alert .acts button');
  await page.evaluate(async () => {
    const info = await window.__cw.app.createWallet('litecoin', { name: 'LTC' });
    await window.__cw.app.openWallet(info.id);
    window.__cw.nav.reset('/dashboard');
    window.__cw.nav.push('/receive');
    window.__cw.nav.push('/receive_addresses');
  });
  await page.waitForSelector('#addresses_page [id^="address_row_"]');
  await wait(400);
  step(`rows: ${JSON.stringify((await rows()).slice(0, 4))} (${(await rows()).length})`);
  // a tap selects and stays
  await click('#address_row_3');
  await wait(400);
  step(`after a tap: top ${await top()}, rows ${JSON.stringify((await rows()).slice(0, 5))}, receive ${await page.evaluate(() => window.__cw.app.currentWallet.value.receiveAddress.value === window.__cw.app.currentWallet.value.addresses.value.find((a) => a.index === 3 && !a.isChange && a.type === window.__cw.app.currentWallet.value.receiveOption)?.address)}`);
  // the long-press menu
  await longPress('#address_row_2');
  await shot('1-menu');
  step(`menu: ${await text('.lp-popup .lp-menu')}; top after the press ${await top()}`);
  await click('#address_menu_label');
  await page.waitForSelector('#address_label_popup_input');
  await wait(300);
  step(`label dialog focused: ${await page.evaluate(() => document.activeElement?.id)}`);
  await page.keyboard.type('Savings');
  await shot('2-label');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('#address_label_popup'), { timeout: 5000 });
  await wait(300);
  step(`row 2 now: ${await text('#address_row_2')}`);
  // info
  await longPress('#address_row_2');
  await click('#address_menu_info');
  await page.waitForSelector('#address_info_popup');
  await wait(300);
  await shot('3-info');
  step(`info: ${await text('#address_info_popup')}`);
  await page.mouse.click(20, 20);
  await page.waitForFunction(() => !document.querySelector('#address_info_popup'), { timeout: 5000 });
  // hide, then unhide from the hidden list
  await longPress('#address_row_2');
  await click('#address_menu_hide');
  await wait(500);
  step(`after hiding: row 2 shown ${!!(await page.$('#address_row_2'))}`);
  await click('#show_hidden_addresses');
  await page.waitForFunction(() => document.querySelectorAll('#addresses_page').length && window.__cw.nav.top?.args?.hidden, { timeout: 5000 });
  await wait(400);
  step(`hidden list: ${JSON.stringify(await page.$$eval('[id^="address_row_"]', (els) => els.filter((e) => getComputedStyle(e).visibility === 'visible').map((e) => e.innerText.replace(/\s+/g, ' ').slice(0, 30))))}`);
  await longPress('#address_row_2');
  step(`hidden row menu: ${await text('.lp-popup .lp-menu')}`);
  await click('#address_menu_hide');
  await wait(400);
  await page.evaluate(() => window.__cw.nav.pop());
  await wait(400);
  step(`after unhiding: row 2 shown ${!!(await page.$('#address_row_2'))}`);
  // the picker
  const picked = page.evaluate(() => window.__cw.nav.pushForResult('/picker_wallet_address'));
  await wait(600);
  const visible = (sel) => page.$$eval(sel, (els) => els.filter((e) => getComputedStyle(e).visibility === 'visible').length);
  step(`picker: show-hidden button ${await visible('#show_hidden_addresses')}, first row rounded ${await page.$$eval('[id^="address_row_"]', (els) => getComputedStyle(els.filter((e) => getComputedStyle(e).visibility === 'visible')[0]).borderTopLeftRadius)}`);
  const want = await page.evaluate(() => window.__cw.app.currentWallet.value.addresses.value.find((a) => a.index === 4 && !a.isChange && a.type === window.__cw.app.currentWallet.value.receiveOption)?.address);
  await page.evaluate(() => [...document.querySelectorAll('#address_row_4')].find((e) => getComputedStyle(e).visibility === 'visible')?.click());
  step(`picked the right address: ${(await Promise.race([picked, wait(5000).then(() => 'timeout')])) === want}; top ${await top()}`);
} catch (e) {
  step(`FAILED: ${e.message}`);
  await shot('fail');
} finally {
  console.log('page errors:', errors.slice(0, 10));
  await browser.close();
}
