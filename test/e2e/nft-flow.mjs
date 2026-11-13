// NFTs end-to-end over Tor: a new wallet (Ethereum by default, Solana or BNB
// Smart Chain), the home screen's NFTs tab (listed from Blockscout or the chain
// without a Moralis key), an import (EVM: the contract's tokenURI through the
// wallet's node, the IPFS metadata and art from a gateway; Solana: the Metaplex
// metadata on chain), the tile and its picture, the details page, and the saved
// NFT after a reload.
//   node test/e2e/nft-flow.mjs [--url http://127.0.0.1:8787/] [--coin ethereum|solana|bsc] [--contract 0x…] [--token 1] [--mint …] [--no-reload] [--timeline] [--send-check] [--listing-only]
import fs from 'node:fs';
import { launch } from './launch.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const URL_ = args.url || 'http://127.0.0.1:8787/';
const coin = args.coin || 'ethereum';
const solana = coin === 'solana';
// Bored Ape Yacht Club #1; Mad Lads #7409
const contract = args.contract || '0xBC4CA0EdA7647A8aB7C2061c2E118A18a936f13D';
const tokenId = args.token || '1';
const mint = args.mint || '6jojFqsTvvWPGfHu9ji9Y5xRsdsGAEC5GXxo4NSqEN74';
const profile = `/tmp/opencode/cw-nft-${Date.now()}`;
const browser = await launch({ profile, width: 430, height: 900 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const click = async (sel, timeout = 30000) => { await page.waitForSelector(sel, { visible: true, timeout }); await page.click(sel); };
const pin = async (p) => { for (const d of p) await click(`#pin_code_button_${d}_key`); };
const shot = (n) => page.screenshot({ path: `/tmp/opencode/nftshot-${n}.png` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ').trim()).catch(() => null);
const loaded = () => page.waitForFunction(() => !document.querySelector('#nft_loading'), { timeout: 300000, polling: 500 });
const pictures = (sel) => page.$$eval(`${sel} img`, (l) => l.filter((i) => i.src.startsWith('blob:') && i.naturalWidth > 0).length).catch(() => 0);

async function openNftTab() {
  await click('#home_tab_nfts', 60000);
  await page.waitForSelector('#nft_listing', { timeout: 30000 });
  await wait(500);
  await loaded();
}

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  await pin('1234'); await wait(300); await pin('1234');
  await click('.alert .acts button');
  await page.evaluate(async (c) => {
    const info = await window.__cw.app.createWallet(c, { name: `NFT ${c}` });
    await window.__cw.app.openWallet(info.id);
    window.__cw.nav.reset('/dashboard');
  }, coin);
  await page.waitForFunction(() => !!window.__cw.app.currentWallet.value?.receiveAddress.value, { timeout: 120000, polling: 500 });
  step(`${coin} wallet: ${await page.evaluate(() => window.__cw.app.currentWallet.value.receiveAddress.value.slice(0, 14))}…`);
  step(`tabs: ${await page.$$eval('.tabs-line button', (l) => l.map((b) => b.innerText).join(' | ')).catch(() => '')}`);
  await openNftTab();
  await shot('1-listing');
  step(`listing: ${await text('#nft_listing')}`);
  if (args['listing-only']) throw new Error('done (listing only)');
  // import
  await click('#nft_import');
  await page.waitForSelector('#import_nft_page');
  await page.type('#nft_import_address', solana ? mint : contract);
  if (!solana) await page.type('#nft_import_token_id', tokenId);
  await wait(300);
  await shot('2-import');
  step(`import page: ${await text('#import_nft_page')}`);
  const importAt = await page.evaluate(() => Date.now());
  await click('#nft_import_confirm');
  await page.waitForFunction(() => !document.querySelector('#import_nft_page') || document.querySelector('#nft_message'), { timeout: 240000, polling: 500 });
  await wait(800);
  const msg = await text('#nft_message');
  if (msg) step(`message: ${msg}`);
  if (args.timeline) {
    const log = await page.evaluate((since) => window.__cw.net().activity.filter((e) => e.at >= since).map((e) => `+${((e.at - since) / 1000).toFixed(1)}s ${e.purpose ?? ''} ${e.host}${e.path.slice(0, 40)} ${e.status ?? e.error ?? ''} ${e.ms ?? ''}ms`), importAt);
    console.log(log.join('\n'));
  }
  const tile = await page.waitForSelector('#nft_list button[id^="nft_tile_"]', { timeout: 30000 }).catch(() => null);
  if (!tile) throw new Error(`no tile: ${await text('#nft_listing')}`);
  await page.waitForFunction(() => [...document.querySelectorAll('#nft_list img')].some((i) => i.src.startsWith('blob:') && i.naturalWidth > 0) || document.querySelector('#nft_list .nft-image-error'), { timeout: 180000, polling: 1000 }).catch(() => {});
  await wait(500);
  await shot('3-tile');
  step(`tile: ${await text('#nft_list')} (pictures shown: ${await pictures('#nft_list')})`);
  // details
  await tile.click();
  await page.waitForSelector('#nft_details_page');
  await page.waitForFunction(() => [...document.querySelectorAll('#nft_details_image img')].some((i) => i.naturalWidth > 0) || document.querySelector('#nft_details_image .nft-image-error'), { timeout: 120000, polling: 1000 }).catch(() => {});
  if (await page.$('#nft_more_info')) await click('#nft_more_info');
  await wait(500);
  await shot('4-details');
  step(`details: ${await text('#nft_details_page')} (picture: ${await pictures('#nft_details_image')}, send: ${!!(await page.$('#nft_send'))})`);
  await page.evaluate(() => window.__cw.nav.pop());
  await wait(500);
  if (solana && args['send-check']) {
    // the send page with the NFT as if held: a bad address, then a good one (no token account of the NFT here)
    await page.evaluate(() => window.__cw.nav.push('/nft_send_page', { asset: { ...window.__cw.nfts.solanaAssets.value[0], isOwned: true } }));
    await page.waitForSelector('#nft_send_page');
    await page.type('#nft_send_address', 'not-an-address');
    await click('#nft_send_confirm');
    await wait(400);
    step(`bad address: ${await text('#nft_send_error')}`);
    await page.evaluate(() => { const i = document.querySelector('#nft_send_address'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.type('#nft_send_address', '9taD9QshRxnMzsPcnYpcamu66pwQurfyQ29tbkZVdrS6');
    await click('#nft_send_confirm');
    await page.waitForFunction(() => document.querySelector('#auth_sheet') || document.querySelector('.alert'), { timeout: 120000 });
    if (await page.$('#auth_sheet')) await pin('1234');
    await page.waitForSelector('.alert', { timeout: 180000 });
    await wait(400);
    await shot('6-send');
    step(`send: ${await text('.alert')}`);
    await page.evaluate(() => document.querySelector('.alert .acts button')?.click());
    await page.evaluate(() => window.__cw.nav.pop());
    await wait(400);
  }
  if (!args['no-reload']) {
    // the import is saved for the wallet
    await page.reload({ waitUntil: 'domcontentloaded' });
    await pin('1234');
    await page.waitForFunction(() => !!window.__cw?.app.currentWallet.value, { timeout: 120000, polling: 500 });
    await openNftTab();
    await page.waitForSelector('#nft_list button[id^="nft_tile_"]', { timeout: 120000 }).catch(() => {});
    step(`after a reload: ${await text('#nft_listing')}`);
    await shot('5-reloaded');
  }
} catch (e) {
  if (e.message.startsWith('done')) step(e.message);
  else {
    step(`FAILED: ${e.message}`);
    await shot('fail');
  }
} finally {
  console.log('page errors:', errors.slice(0, 10));
  await browser.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
