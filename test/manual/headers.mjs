// Which HTTP headers leave the page through Tor? Sets a PIN (so the router is
// online), then asks header-echo services through the in-page Tor client.
//   node test/manual/headers.mjs [--url http://127.0.0.1:8787/]
import { launch } from '../e2e/launch.mjs';

const url = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : 'http://127.0.0.1:8787/';
const browser = await launch({ profile: `/tmp/opencode/cw-headers-${Date.now()}`, width: 430, height: 900 });
const page = await browser.newPage();
const click = async (sel) => { await page.waitForSelector(sel, { visible: true, timeout: 30000 }); await page.click(sel); };
try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  for (const d of '1234') await click(`#pin_code_button_${d}_key`);
  await new Promise((r) => setTimeout(r, 300));
  for (const d of '1234') await click(`#pin_code_button_${d}_key`);
  await click('.alert .acts button');
  if (process.argv.includes('--ua')) await page.evaluate((ua) => (window.__uaTest = ua), process.argv[process.argv.indexOf('--ua') + 1]);
  const out = await page.evaluate(async () => {
    const res = [];
    for (const u of ['https://httpbin.org/headers', 'https://postman-echo.com/headers']) {
      try {
        const r = await window.__cw.app.net().request({ url: u, purpose: 'header check', timeoutMs: 60000, headers: window.__uaTest ? { 'User-Agent': window.__uaTest } : undefined });
        res.push(`${u}: ${new TextDecoder().decode(r.body).replace(/\s+/g, ' ')}`);
      } catch (e) {
        res.push(`${u}: ERROR ${e.message}`);
      }
    }
    return { browserUA: navigator.userAgent, res };
  });
  console.log(JSON.stringify(out, null, 1));
} finally {
  await browser.close();
}
