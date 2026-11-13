// Tron checks over Tor: token metadata through triggerconstantcontract, and a
// signed transfer from an account without TRX broadcast to the node: a
// "balance is not sufficient" answer means the node parsed the transaction and
// accepted its signature (it checks the signature before the balance).
//   node --experimental-strip-types test/manual/tron-check.mjs [node]
import { TorClient, storage } from 'tor-js/wasm-file';
import { HDKey } from '@scure/bip32';
import { bip39Seed } from '../../src/coins/seeds/bip39.ts';
import { addressFromPrivateKey, encodeRawData, encodeTransaction, refBlock, signTransaction, txId } from '../../src/coins/tron/tron.ts';
import { decodeString, decodeUint } from '../../src/coins/evm/eth.ts';
import { bytesToHex } from '@noble/hashes/utils.js';

const node = process.argv[2] || 'https://tron-rpc.publicnode.com';
const c = new TorClient({ storage: new storage.MemoryStorage() });
await c.ready();
const post = async (path, body) => {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await c.fetch(`${node}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'User-Agent': 'Dart/3.11 (dart:io)' }, anonOptions: { isolationKey: `t${i}` }, signal: AbortSignal.timeout(60000) });
      const t = await r.text();
      return JSON.parse(t);
    } catch (e) {
      if (i === 3) throw e;
    }
  }
};
const key = HDKey.fromMasterSeed(await bip39Seed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')).derive("m/44'/195'/0'/0/0").privateKey;
const me = addressFromPrivateKey(key);
for (const [sel, kind] of [['06fdde03', 'name'], ['95d89b41', 'symbol'], ['313ce567', 'decimals']]) {
  const r = await post('/wallet/triggerconstantcontract', { owner_address: me, contract_address: 'TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9', data: sel, visible: true });
  const h = r?.constant_result?.[0];
  console.log(kind, h ? (kind === 'decimals' ? String(decodeUint(h)) : decodeString(h)) : JSON.stringify(r).slice(0, 200));
}
const block = await post('/wallet/getblock', { detail: false });
const ref = refBlock(block);
const raw = encodeRawData({
  ref_block_bytes: ref.ref_block_bytes,
  ref_block_hash: ref.ref_block_hash,
  expiration: Date.now() + 30 * 60_000,
  timestamp: ref.timestamp,
  contract: [{ type: 'TransferContract', parameter: { type_url: 'type.googleapis.com/protocol.TransferContract', value: { owner_address: me, to_address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', amount: 1 } } }],
  fee_limit: 269000,
});
const signed = encodeTransaction(raw, [signTransaction(raw, key)]);
const b = await post('/wallet/broadcasthex', { transaction: bytesToHex(signed) });
const msg = b?.message && /^[0-9a-f]+$/i.test(b.message) ? Buffer.from(b.message, 'hex').toString() : b?.message;
console.log('txid', txId(raw).slice(0, 16), 'broadcast:', JSON.stringify({ ...b, message: msg }).slice(0, 300));
c.close();
process.exit(0);
