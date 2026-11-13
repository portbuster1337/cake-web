// Nano check over Tor: a receive block from the (public) test account of the
// "abandon … about" mnemonic, with our hash, signature and proof of work, and a
// made-up source. The node checks work, then signature, then the source: a
// "Gap source block" answer means it accepted our work and signature ("Bad
// signature" / "Block work is less than threshold" otherwise). Nothing is
// added to the ledger.
//   node --experimental-strip-types test/manual/nano-check.mjs [node]
import { TorClient, storage } from 'tor-js/wasm-file';
import { bytesToHex } from '@noble/hashes/utils.js';
import { nanoKeys, publicKeyToAddress, RECEIVE_THRESHOLD, signHash, stateHash, workDifficulty } from '../../src/coins/nano/nano.ts';
import { POW_WASM } from '../../src/coins/nano/powWasm.gen.ts';

const node = process.argv[2] || 'https://rpc.nano.to';
const c = new TorClient({ storage: new storage.MemoryStorage() });
await c.ready();
const post = async (body) => {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await c.fetch(node, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'User-Agent': 'Dart/3.11 (dart:io)', 'nano-app': 'cake-wallet' }, anonOptions: { isolationKey: `n${i}${body.action}` }, signal: AbortSignal.timeout(90000) });
      return JSON.parse(await r.text());
    } catch (e) {
      if (i === 3) throw e;
    }
  }
};

const k = await nanoKeys({ mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' }, 'bip39');
const info = await post({ action: 'account_info', account: k.address, representative: 'true' });
console.log('account', k.address.slice(0, 16), 'frontier', info.frontier?.slice(0, 16), 'balance', info.balance);
const fb = await post({ action: 'block_info', json_block: 'true', hash: info.frontier });
const f = fb.contents;
console.log('frontier hash check', stateHash(f) === info.frontier.toUpperCase());

function work(root, threshold) {
  const inst = new WebAssembly.Instance(new WebAssembly.Module(Buffer.from(POW_WASM, 'base64')));
  const mem = inst.exports.memory;
  new Uint8Array(mem.buffer).set(Buffer.from(root, 'hex'), 0);
  const dv = new DataView(mem.buffer);
  let start = dv.getBigUint64(0, true) ^ BigInt(Date.now());
  for (;;) {
    if (inst.exports.search(start, 1 << 20, threshold)) return dv.getBigUint64(32, true).toString(16).padStart(16, '0');
    start = dv.getBigUint64(32, true);
  }
}

const source = bytesToHex(crypto.getRandomValues(new Uint8Array(32))).toUpperCase();
const block = { type: 'state', account: k.address, previous: info.frontier, representative: info.representative, balance: (BigInt(f.balance) + 1n).toString(), link: source, link_as_account: publicKeyToAddress(Buffer.from(source, 'hex')) };
block.signature = signHash(stateHash(block), k.privateKey);
const t0 = Date.now();
block.work = work(info.frontier, RECEIVE_THRESHOLD);
console.log('work', block.work, 'in', Date.now() - t0, 'ms, difficulty', workDifficulty(info.frontier, block.work).toString(16));
const good = await post({ action: 'process', json_block: 'true', subtype: 'receive', block });
console.log('process (valid signature):', JSON.stringify(good));
const bad = await post({ action: 'process', json_block: 'true', subtype: 'receive', block: { ...block, signature: block.signature.replace(/^./, (x) => (x === 'A' ? 'B' : 'A')) } });
console.log('process (broken signature):', JSON.stringify(bad));
c.close();
process.exit(0);
