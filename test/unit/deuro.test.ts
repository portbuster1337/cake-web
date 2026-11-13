import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex } from '@noble/hashes/utils.js';
import { selectorOf, decodeWord, encodeCall } from '../../src/coins/evm/eth.ts';
import { FRONTEND_CODE, SAVINGS_V2, encodeApproveSavings, encodeSave, encodeWithdraw, encodeWithdrawV1 } from '../../src/integrations/deuro.ts';

test('ABI: selectors from signatures, static arguments, result words', () => {
  assert.equal(selectorOf('transfer(address,uint256)'), 'a9059cbb');
  assert.equal(selectorOf('approve(address,uint256)'), '095ea7b3');
  assert.equal(selectorOf('allowance(address,address)'), 'dd62ed3e');
  const d = encodeCall('12345678', [{ bool: true }, { bytes32: FRONTEND_CODE }]);
  assert.equal(d.length, 4 + 64);
  assert.equal(d[35], 1);
  assert.equal(bytesToHex(d.subarray(36)), FRONTEND_CODE.slice(2));
  assert.throws(() => encodeCall('12345678', [{ bytes32: '0x1234' }]));
  const word = (n: bigint) => n.toString(16).padStart(64, '0');
  assert.equal(decodeWord(`0x${word(5n)}${word(9n)}`, 1), 9n);
  assert.equal(decodeWord('0x', 0), 0n);
});

test('dEuro calls: save(amount, compound), withdraw(self, amount), the V1 close, the infinite approval', () => {
  const owner = '0x1111111111111111111111111111111111111111';
  const save = encodeSave(10n ** 18n);
  assert.equal(bytesToHex(save.subarray(0, 4)), selectorOf('save(uint192,bool)'));
  assert.equal(BigInt(`0x${bytesToHex(save.subarray(4, 36))}`), 10n ** 18n);
  assert.equal(save[67], 1);
  const w = encodeWithdraw(owner, 5n);
  assert.equal(bytesToHex(w.subarray(0, 4)), selectorOf('withdraw(address,uint192)'));
  assert.equal(bytesToHex(w.subarray(16, 36)), owner.slice(2));
  const v1 = encodeWithdrawV1(owner);
  assert.equal(bytesToHex(v1.subarray(0, 4)), selectorOf('withdraw(address,uint192,bytes32)'));
  assert.equal(BigInt(`0x${bytesToHex(v1.subarray(36, 68))}`), 10n ** 24n);
  assert.equal(`0x${bytesToHex(v1.subarray(68))}`, FRONTEND_CODE);
  const a = encodeApproveSavings();
  assert.equal(bytesToHex(a.subarray(16, 36)), SAVINGS_V2.slice(2).toLowerCase());
  assert.equal(bytesToHex(a.subarray(36)), 'f'.repeat(64));
});
