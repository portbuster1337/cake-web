import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { decodeSilentAddress, encodeSilentAddress, isSilentAddress, silentPaymentOutputs } from '../../src/coins/utxo/silent.ts';

const vectors = JSON.parse(fs.readFileSync(new URL('./fixtures/bip352-send.json', import.meta.url), 'utf8')) as { comment: string; inputs: { txid: string; vout: number; privkey: string; taproot: boolean }[]; recipients: string[]; outputs: string[][] }[];

test('BIP-352 addresses: sp1 decodes to its scan and spend keys and back', () => {
  const a = vectors[0].recipients[0];
  const d = decodeSilentAddress(a)!;
  assert.equal(d.scan.length, 33);
  assert.equal(d.spend.length, 33);
  assert.equal(encodeSilentAddress(d.scan, d.spend), a);
  assert.ok(isSilentAddress(a));
  assert.ok(!isSilentAddress(a, true));
  assert.ok(!isSilentAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu'));
  assert.ok(!isSilentAddress(a.slice(0, -1) + (a.endsWith('q') ? 'p' : 'q')));
});

test(`BIP-352 sending: the official test vectors (${vectors.length} with P2PKH, P2WPKH and key-path P2TR inputs)`, () => {
  for (const v of vectors) {
    const outs = silentPaymentOutputs(v.inputs.map((i) => ({ ...i, privkey: hexToBytes(i.privkey) })), v.recipients.map((r) => decodeSilentAddress(r)!)).map(bytesToHex).sort();
    assert.ok(v.outputs.some((set) => JSON.stringify([...set].sort()) === JSON.stringify(outs)), `${v.comment}: ${outs.join(',')}`);
  }
});

test('a silent payment output is P2TR with the derived key itself (no BIP-341 tweak)', async () => {
  const { NETWORKS, addressToScript } = await import('../../src/coins/utxo/networks.ts');
  const { taprootAddress } = await import('../../src/coins/utxo/txbuilder.ts');
  const v = vectors[0];
  const key = silentPaymentOutputs(v.inputs.map((i) => ({ ...i, privkey: hexToBytes(i.privkey) })), [decodeSilentAddress(v.recipients[0])!])[0];
  const addr = taprootAddress(NETWORKS.btc, key);
  assert.ok(addr.startsWith('bc1p'));
  assert.equal(bytesToHex(addressToScript(NETWORKS.btc, addr)), `5120${bytesToHex(key)}`);
  // a non-eligible input changes only the smallest outpoint, not the key sum
  const extra = { txid: '00'.repeat(32), vout: 0, privkey: new Uint8Array(32).fill(1), taproot: false, eligible: false };
  const withExtra = silentPaymentOutputs([...v.inputs.map((i) => ({ ...i, privkey: hexToBytes(i.privkey) })), extra], [decodeSilentAddress(v.recipients[0])!])[0];
  assert.notEqual(bytesToHex(withExtra), bytesToHex(key));
});
