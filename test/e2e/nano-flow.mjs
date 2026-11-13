// Nano end-to-end over Tor: restore the "abandon … about" mnemonic (BIP39/HD)
// through the UI and sync it; check keys, message signing, the receive URI and
// fees; proof of work in the browser (receive and send strength); restore the
// 24-word standard phrase "abandon … art" (both derivations have history, so
// the chooser appears), then change its representative through the Change
// Representative page (a real change block on the network: the account is a
// public test vector with no balance); restore a 128-hex seed from keys; and
// create fresh wallets of both seed types.
//   node test/e2e/nano-flow.mjs [--url http://127.0.0.1:8787/] [--no-change]
import { launch } from './launch.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true']);
  return acc;
}, []));
const URL_ = args.url || 'http://127.0.0.1:8787/';
const browser = await launch({ profile: `/tmp/opencode/cw-xno-${Date.now()}`, width: 430, height: 900 });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });
const t0 = Date.now();
const step = (s) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const click = async (sel, timeout = 30000) => { await page.waitForSelector(sel, { visible: true, timeout }); await page.click(sel); };
const pin = async (p) => { for (const d of p) await click(`#pin_code_button_${d}_key`); };
const shot = (n) => page.screenshot({ path: `/tmp/opencode/cw-xno-${n}.png` });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const HD = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const STANDARD = `${'abandon '.repeat(23)}art`;

async function waitSynced(name, timeoutMs = 300000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const st = await page.evaluate((n) => {
      const w = window.__cw.app.currentWallet.value;
      if (!w || w.name !== n) return null;
      const s = w.syncStatus.value;
      return { kind: s.kind, error: s.error, txs: w.transactions.value.length, bal: Object.fromEntries(Object.entries(w.balances.value).map(([k, v]) => [k, `${v.available}/${v.pending ?? 0}`])), rep: w.representativeAddress?.value?.slice(0, 14) };
    }, name);
    if (st && (st.kind === 'synced' || st.kind === 'failed')) return st;
    if (Date.now() > end) throw new Error(`sync timeout: ${JSON.stringify(st)}`);
    await wait(2000);
  }
}

async function restoreSeed(name, words) {
  await page.evaluate(() => window.__cw.nav.push('/restore_wallet', { walletType: 'nano' }));
  await page.waitForSelector('#restore_seed');
  await page.type('#wallet_restore_name', name);
  await page.type('#restore_seed', words);
  await click('#wallet_restore_seed_or_key_restore_button_key');
}

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  await click('#create_pin_welcome_page_create_a_pin_button_key');
  await pin('1234'); await wait(300); await pin('1234');
  await click('.alert .acts button');

  // 1. BIP39 / HD
  await restoreSeed('XNO HD', HD);
  await page.waitForFunction(() => window.__cw.app.currentWallet.value?.name === 'XNO HD', { timeout: 120000 });
  step(`HD restored: ${await page.evaluate(() => window.__cw.app.currentWallet.value.receiveAddress.value)} (expected nano_1p6hocygi1pzjidi3hho3wn85qiw3ykapg7khu9b45dwf7momgqoytn1c1jz)`);
  step(`sync: ${JSON.stringify(await waitSynced('XNO HD'))}`);
  await wait(4000);
  const misc = await page.evaluate(async () => {
    const w = window.__cw.app.currentWallet.value;
    const sig = await w.signMessage('hello from cake web');
    const tx = w.transactions.value[0];
    return {
      derivation: w.derivation, rep: w.representativeAddress.value.slice(0, 16), repScore: w.repScore, hasFees: w.hasFees, priorities: w.priorities().length, fee: String(await w.estimateFee('medium')),
      keys: (await w.keys()).map((k) => `${k.label}=${k.value.slice(0, 10)}…(${k.value.length})`),
      sig: sig.slice(0, 12), ok: await w.verifyMessage('hello from cake web', sig, w.receiveAddress.value), bad: await w.verifyMessage('hello', sig, w.receiveAddress.value),
      firstTx: tx && { dir: tx.direction, amount: String(tx.amount), pending: tx.isPending, date: new Date(tx.date).toISOString().slice(0, 10), height: tx.height },
      explorer: tx && w.explorerUrl(tx.id),
      valid: [w.validateAddress('nano_3i1aq1cchnmbn9x5rsbap8b15akfh7wj7pwskuzi7ahz8oq6cobd99d4r3b7'), w.validateAddress('nano_3i1aq1cchnmbn9x5rsbap8b15akfh7wj7pwskuzi7ahz8oq6cobd99d4r3b8')],
    };
  });
  step(`HD wallet: ${JSON.stringify(misc)}`);
  await shot('1-home');
  await click('#home_receive');
  await page.waitForSelector('#receive_qr');
  step(`receive URI: ${await page.$eval('#receive_qr', (e) => e.getAttribute('data-qr'))}`);
  await page.evaluate(() => window.__cw.nav.pop());
  await click('#home_send');
  await page.waitForSelector('#send_page');
  await wait(1000);
  step(`send page: fee row ${await page.$('#send_fees') ? 'shown' : 'hidden'}, advanced ${await page.$('#send_advanced') ? 'shown' : 'hidden'}`);
  await shot('2-send');
  await page.evaluate(() => window.__cw.nav.pop());
  const pow = await page.evaluate(async () => {
    const w = window.__cw.app.currentWallet.value;
    const root = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('');
    let t = performance.now();
    const recv = await w.generateWork(root, 0xfffffe0000000000n);
    const recvMs = Math.round(performance.now() - t);
    t = performance.now();
    const send = await w.generateWork(root.split('').reverse().join(''), 0xfffffff800000000n);
    return { cores: navigator.hardwareConcurrency, recv, recvMs, send, sendMs: Math.round(performance.now() - t) };
  });
  step(`proof of work in the browser: ${JSON.stringify(pow)}`);

  // 2. the 24-word standard phrase: both derivations have history → the chooser
  await restoreSeed('XNO 24', STANDARD);
  await page.waitForSelector('#choose_derivation_page', { timeout: 120000 });
  const options = await page.$$eval('#choose_derivation_page button', (els) => els.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  step(`derivation chooser: ${JSON.stringify(options)}`);
  await shot('3-choose');
  await page.evaluate(() => [...document.querySelectorAll('#choose_derivation_page button')].find((b) => b.querySelector('span')?.textContent === 'nano')?.click());
  await page.waitForFunction(() => window.__cw.app.currentWallet.value?.name === 'XNO 24', { timeout: 120000 });
  step(`standard restored: ${await page.evaluate(() => window.__cw.app.currentWallet.value.receiveAddress.value)} (expected nano_3i1aq1cchnmbn9x5rsbap8b15akfh7wj7pwskuzi7ahz8oq6cobd99d4r3b7)`);
  step(`sync: ${JSON.stringify(await waitSynced('XNO 24'))}`);
  await page.waitForFunction(() => window.__cw.app.currentWallet.value.representativeAddress.value, { timeout: 60000 }).catch(() => {});

  // 3. Change Representative
  await page.evaluate(() => window.__cw.nav.push('/change_representative'));
  await page.waitForSelector('#change_rep_page');
  await page.waitForFunction(() => document.querySelectorAll('#rep_list button').length > 0, { timeout: 90000 }).catch(() => {});
  const reps = await page.$$eval('#rep_list button', (els) => els.slice(0, 3).map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
  const current = await page.$eval('#current_rep', (e) => e.innerText.replace(/\s+/g, ' ').trim());
  step(`change rep page: current "${current}", ${await page.$$eval('#rep_list button', (els) => els.length)} listed, e.g. ${JSON.stringify(reps)}`);
  await shot('4-change-rep');
  if (!args['no-change']) {
    const before = await page.evaluate(() => window.__cw.app.currentWallet.value.representativeAddress.value);
    // the second listed representative that is not the current one
    await page.evaluate((cur) => {
      const btns = [...document.querySelectorAll('#rep_list button')];
      const pick = btns.filter((b) => !b.id.endsWith(cur.slice(5, 13)))[1] ?? btns[0];
      pick.click();
    }, before);
    const target = await page.$eval('#change_rep_address', (e) => e.value);
    const tc = Date.now();
    await click('#change_rep_button');
    await page.waitForSelector('.alert .acts button', { visible: true });
    await page.evaluate(() => [...document.querySelectorAll('.alert .acts button')].pop().click());
    await page.waitForFunction(() => [...document.querySelectorAll('.alert')].some((a) => /Successful|Error/.test(a.textContent)), { timeout: 600000 });
    const result = await page.$eval('.alert', (e) => e.innerText.replace(/\s+/g, ' ').trim());
    const after = await page.evaluate(() => window.__cw.app.currentWallet.value.representativeAddress.value);
    step(`change rep → ${target.slice(0, 16)}: "${result}" in ${((Date.now() - tc) / 1000).toFixed(1)} s; representative now ${after.slice(0, 16)} (was ${before.slice(0, 16)}), defaultNanoRep ${await page.evaluate(() => window.__cw.settings.value.defaultNanoRep.slice(0, 16))}`);
    await shot('5-change-rep-done');
    await page.evaluate(() => document.querySelector('.alert .acts button')?.click());
  }

  // 4. restore from keys: the 128-hex BIP39 seed of the HD phrase
  await page.evaluate(() => window.__cw.nav.reset('/dashboard'));
  await page.evaluate(() => window.__cw.nav.push('/restore_wallet', { walletType: 'nano' }));
  await click('#restore_tab_keys');
  await page.type('#wallet_restore_name', 'XNO hex');
  await page.type('#restore_private_key', '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4');
  await click('#wallet_restore_seed_or_key_restore_button_key');
  await page.waitForFunction(() => window.__cw.app.currentWallet.value?.name === 'XNO hex', { timeout: 120000 });
  step(`hex restored: ${JSON.stringify(await page.evaluate(() => { const w = window.__cw.app.currentWallet.value; return { address: w.receiveAddress.value.slice(0, 16), derivation: w.derivation, nonSeed: w.info.isNonSeedWallet, seed: !!w.seed }; }))}`);

  // 5. fresh wallets of both seed types
  for (const seedType of ['bip39', 'nano']) {
    const name = `XNO new ${seedType}`;
    const r = await page.evaluate(async (st, n) => {
      const info = await window.__cw.app.createWallet('nano', { name: n, seedType: st });
      const w = await window.__cw.app.openWallet(info.id);
      return { words: w.seed.split(' ').length, derivation: w.derivation };
    }, seedType, name);
    const s = await waitSynced(name, 180000).catch((e) => ({ kind: 'timeout', error: e.message }));
    step(`new ${seedType} wallet: ${r.words} words, ${r.derivation}; ${JSON.stringify(s)}`);
  }
  await shot('6-new');
} catch (e) {
  step(`FAILED: ${e.message}`);
  await shot('fail');
  const act = await page.evaluate(() => window.__cw.app.net().activity.slice(-30).map((a) => `${a.via} ${a.method} ${a.host}${a.path} ${a.status ?? ''} ${a.ms ?? ''}ms ${a.purpose ?? ''} ${a.error ?? ''}`)).catch(() => []);
  for (const a of act) console.log('   ', a.slice(0, 200));
} finally {
  console.log('page errors:', errors.slice(0, 10));
  await browser.close();
}
