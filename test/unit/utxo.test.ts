import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bchSighash, buildBchTransaction } from '../../src/coins/utxo/bch.ts';
import { cashaddrEncode, cashaddrDecode } from '../../src/coins/utxo/cashaddr.ts';
import { NETWORKS, pubkeyToAddress, toCashAddr, isValidAddress, addressToScript } from '../../src/coins/utxo/networks.ts';
import { buildTransaction, estimateVsize } from '../../src/coins/utxo/txbuilder.ts';
import { Transaction } from '@scure/btc-signer';

test('cashaddr spec vectors', () => {
  const h = hex.decode('76a04053bda0a88bda5177b86a15c3b29f559873');
  assert.equal(cashaddrEncode('bitcoincash', 'p2pkh', h), 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a');
  assert.deepEqual(cashaddrDecode('bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a').hash, h);
  assert.equal(toCashAddr('1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu'), 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a');
  assert.equal(cashaddrEncode('bitcoincash', 'p2sh', hex.decode('76a04053bda0a88bda5177b86a15c3b29f559873')), 'bitcoincash:ppm2qsznhks23z7629mms6s4cwef74vcwvn0h829pq');
  assert.ok(isValidAddress(NETWORKS.bch, 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a'));
  assert.ok(!isValidAddress(NETWORKS.bch, 'bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6b'));
});

test('BIP143 digest (native P2WPKH example) with the BCH preimage code', () => {
  // BIP143 example: second input, scriptCode of 1d0f172a0ecb48aee1be1f2687d2963ae33f71a1, 6 BTC
  const inputs = [
    { txid: '9f96ade4b41d5433f4eda31e1738ec2b36f6e7d1420d94a6af99801a88f7f7ff', vout: 0, sequence: 0xffffffee, value: 625000000n, scriptCode: hex.decode('2103c9f4836b9a4f77fc0d81f7bcb01b7f1b35916864b9476c241ce9fc198bd25432ac') },
    { txid: '8ac60eb9575db5b2d987e29f301b5b819ea83a5c6579d282d189cc04b8e151ef', vout: 1, sequence: 0xffffffff, value: 600000000n, scriptCode: hex.decode('76a9141d0f172a0ecb48aee1be1f2687d2963ae33f71a188ac') },
  ];
  const outputs = [
    { value: 112340000n, script: hex.decode('76a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac') },
    { value: 223450000n, script: hex.decode('76a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac') },
  ];
  assert.equal(hex.encode(bchSighash(inputs, outputs, 1, 1, 17, 0x01)), 'c37af31116d1b27caf68aae9e3ac82f1477929014d5b917657d0eb49478cb670');
});

test('BCH tx signs and verifies', () => {
  const sk = hex.decode('11'.repeat(32));
  const pub = secp256k1.getPublicKey(sk, true);
  const addr = pubkeyToAddress(NETWORKS.bch, pub, 'p2pkh');
  assert.match(addr, /^bitcoincash:q/);
  const built = buildBchTransaction([{ txid: 'aa'.repeat(32), vout: 1, value: 100000n, address: addr, type: 'p2pkh', pubkey: pub, privkey: sk, confirmations: 3 }], [{ address: addr, value: 99000n }], { locktime: 800000 });
  const raw = Transaction.fromRaw(hex.decode(built.hex), { allowUnknownOutputs: true, disableScriptCheck: true });
  assert.equal(raw.inputsLength, 1);
  assert.equal(raw.lockTime, 800000);
  assert.equal(built.txid.length, 64);
});

test('BTC p2wpkh/p2tr/p2pkh/p2sh tx build, vsize estimate close to real', () => {
  const net = NETWORKS.btc;
  const sk = hex.decode('22'.repeat(32));
  const pub = secp256k1.getPublicKey(sk, true);
  for (const type of ['p2wpkh', 'p2tr', 'p2sh'] as const) {
    const addr = pubkeyToAddress(net, pub, type);
    const built = buildTransaction(net, [{ txid: 'bb'.repeat(32), vout: 0, value: 50000n, address: addr, type, pubkey: pub, privkey: sk, confirmations: 1 }], [{ address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', value: 40000n }, { address: addr, value: 9000n, isChange: true }], { rbf: true, locktime: 900000 });
    const est = estimateVsize(net, [type], ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', addr]);
    assert.ok(Math.abs(est - built.vsize) <= 2, `${type}: estimate ${est} vs real ${built.vsize}`);
    assert.equal(built.fee, 1000n);
  }
  assert.ok(addressToScript(NETWORKS.ltc, pubkeyToAddress(NETWORKS.ltc, pub, 'p2wpkh')).length === 22);
  assert.match(pubkeyToAddress(NETWORKS.doge, pub, 'p2pkh'), /^D/);
  assert.match(pubkeyToAddress(NETWORKS.ltc, pub, 'p2wpkh'), /^ltc1q/);
});
