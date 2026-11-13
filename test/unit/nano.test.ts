import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bytesToHex } from '@noble/hashes/utils.js';
import { addressToPublicKey, isValidNanoAddress, messageHash, nanoKeys, privateToPublic, publicKeyToAddress, RECEIVE_THRESHOLD, SEND_THRESHOLD, signHash, signMessage, standardSeedToMnemonic, standardSeedToPrivate, stateHash, verifyHash, verifyMessage, workDifficulty } from '../../src/coins/nano/nano.ts';
import { POW_WASM } from '../../src/coins/nano/powWasm.gen.ts';

const M = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const ZERO = '0'.repeat(64);
const fixture: { blocks: { hash: string; subtype: string; contents: Record<string, string> }[] } = JSON.parse(readFileSync(new URL('./fixtures/nano-blocks.json', import.meta.url), 'utf8'));

test('standard seed 00…00, index 0 (Nano docs vector)', () => {
  const priv = standardSeedToPrivate(ZERO, 0);
  assert.equal(priv, '9F0E444C69F77A49BD0BE89DB92C38FE713E0963165CCA12FAF5712D7657120F');
  assert.equal(bytesToHex(privateToPublic(priv)).toUpperCase(), 'C008B814A7D269A1FA3C6528B19201A24D797912DB9996FF02A1FF356E45552B');
  assert.equal(publicKeyToAddress(privateToPublic(priv)), 'nano_3i1aq1cchnmbn9x5rsbap8b15akfh7wj7pwskuzi7ahz8oq6cobd99d4r3b7');
});

test("HD m/44'/165'/0' of abandon…about, and the 24-word standard mnemonic both ways (Cake's types)", async () => {
  const hd = await nanoKeys({ mnemonic: M }, 'bip39');
  assert.equal(hd.address, 'nano_1p6hocygi1pzjidi3hho3wn85qiw3ykapg7khu9b45dwf7momgqoytn1c1jz');
  assert.equal(hd.privateKey, '7f72c7d17beac5cdc249d3aeba8bf76d640129f69db17e584a4a98e635855d7c');
  assert.equal(hd.hexSeed.length, 128);
  const words = standardSeedToMnemonic(ZERO);
  assert.equal(words, `${'abandon '.repeat(23)}art`);
  assert.equal((await nanoKeys({ mnemonic: words }, 'nano')).address, 'nano_3i1aq1cchnmbn9x5rsbap8b15akfh7wj7pwskuzi7ahz8oq6cobd99d4r3b7');
  assert.equal((await nanoKeys({ mnemonic: words }, 'bip39')).address, 'nano_1ago7jdaipwf9jycz7fjn7s7sc7qz5gqdwrmqhham7fhfih1x9no74r15gwr');
  assert.equal((await nanoKeys({ hexSeed: ZERO }, 'nano')).address, 'nano_3i1aq1cchnmbn9x5rsbap8b15akfh7wj7pwskuzi7ahz8oq6cobd99d4r3b7');
});

test('accounts: checksum, prefixes, round trip', () => {
  const a = 'nano_3i1aq1cchnmbn9x5rsbap8b15akfh7wj7pwskuzi7ahz8oq6cobd99d4r3b7';
  assert.ok(isValidNanoAddress(a));
  assert.ok(isValidNanoAddress(a.replace('nano_', 'xrb_')));
  assert.ok(!isValidNanoAddress(a.slice(0, -1) + '8'));
  assert.ok(!isValidNanoAddress('nano_5i1aq1cchnmbn9x5rsbap8b15akfh7wj7pwskuzi7ahz8oq6cobd99d4r3b7'));
  assert.equal(publicKeyToAddress(addressToPublicKey(a)), a);
  assert.ok(isValidNanoAddress('nano_1111111111111111111111111111111111111111111111111111hifc8npp'));
});

test('real blocks: our state hash is the network hash and their signatures verify', () => {
  assert.equal(fixture.blocks.length, 2);
  for (const b of fixture.blocks) {
    const c = b.contents;
    assert.equal(stateHash({ account: c.account, previous: c.previous, representative: c.representative, balance: c.balance, link: c.link }), b.hash, b.subtype);
    assert.ok(verifyHash(b.hash, c.signature, c.account));
    assert.ok(!verifyHash(b.hash.replace(/^./, (x) => (x === 'A' ? 'B' : 'A')), c.signature, c.account));
    const need = b.subtype === 'send' ? SEND_THRESHOLD : RECEIVE_THRESHOLD;
    assert.ok(workDifficulty(c.previous, c.work) >= need, `${b.subtype} work`);
  }
});

test('block and message signatures', async () => {
  const k = await nanoKeys({ hexSeed: ZERO }, 'nano');
  const h = stateHash({ account: k.address, previous: ZERO, representative: k.address, balance: '1000', link: ZERO });
  const sig = signHash(h, k.privateKey);
  assert.equal(sig.length, 128);
  assert.ok(verifyHash(h, sig, k.address));
  assert.equal(messageHash('hello').length, 64);
  const m = signMessage('hello from cake web', k.privateKey);
  assert.ok(verifyMessage('hello from cake web', m, k.address));
  assert.ok(!verifyMessage('hello', m, k.address));
});

test('the WebAssembly proof-of-work kernel finds valid receive work', () => {
  const inst = new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(POW_WASM, 'base64')));
  const search = inst.exports.search as (s: bigint, c: number, t: bigint) => number;
  const mem = inst.exports.memory as WebAssembly.Memory;
  const root = fixture.blocks[0].contents.previous;
  new Uint8Array(mem.buffer).set(Buffer.from(root, 'hex'), 0);
  // the network's own work for this root has this difficulty
  const work = BigInt(`0x${fixture.blocks[0].contents.work}`);
  assert.equal(search(work, 1, 0n), 1);
  assert.equal(new DataView(mem.buffer).getBigUint64(40, true), workDifficulty(root, fixture.blocks[0].contents.work));
  // a fresh search at the receive threshold
  let start = 0n;
  let found = 0;
  for (let i = 0; i < 200 && !found; i++) {
    found = search(start, 1 << 20, RECEIVE_THRESHOLD);
    start = new DataView(mem.buffer).getBigUint64(32, true);
  }
  assert.equal(found, 1);
  const w = new DataView(mem.buffer).getBigUint64(32, true).toString(16).padStart(16, '0');
  assert.ok(workDifficulty(root, w) >= RECEIVE_THRESHOLD);
});
