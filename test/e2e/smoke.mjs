// Smoke test: first run in a real browser. Set a PIN, reach the welcome page,
// and watch the in-page Tor client bootstrap.
//   node test/e2e/smoke.mjs [--url http://127.0.0.1:8787/] [--browser chrome|firefox]
import { launch } from './launch.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const URL_ = args.url || 'http://127.0.0.1:8787/';
const browser = await launch({ browser: args.browser || 'chrome', profile: `/tmp/opencode/cw-smoke-${Date.now()}`, width: 430, height: 900 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#create_pin_welcome_page', { timeout: 30000 });
  step('welcome page shown');
  await page.screenshot({ path: '/tmp/opencode/cw-1-welcome.png' });
  await page.click('#create_pin_welcome_page_create_a_pin_button_key');
  await page.waitForSelector('#pin_code_button_1_key');
  for (const d of '1234') await page.click(`#pin_code_button_${d}_key`);
  await page.waitForFunction(() => document.querySelector('#pin-title')?.textContent?.includes('again'));
  step('pin entered once');
  for (const d of '1234') await page.click(`#pin_code_button_${d}_key`);
  await page.waitForSelector('.alert', { timeout: 20000 });
  step(`alert: ${await page.$eval('.alert', (e) => e.textContent)}`);
  await page.click('.alert .acts button');
  await page.waitForSelector('#welcome_page', { timeout: 10000 });
  step('welcome (create/restore) page shown');
  await page.screenshot({ path: '/tmp/opencode/cw-2-wallet-welcome.png' });
  // Tor status in the page
  const tor = await page.waitForFunction(() => {
    const s = window.__cw.app.torStatus.value;
    return s.state === 'ready' || s.state === 'error' ? JSON.stringify(s) : null;
  }, { timeout: 180000, polling: 1000 }).then((h) => h.jsonValue()).catch(async () => 'timeout ' + await page.evaluate(() => JSON.stringify(window.__cw.app.torStatus.value)));
  step(`tor: ${tor}`);
} catch (e) {
  step(`FAILED: ${e.message}`);
  await page.screenshot({ path: '/tmp/opencode/cw-fail.png' });
} finally {
  console.log('page errors:', errors.slice(0, 10));
  await browser.close();
}
