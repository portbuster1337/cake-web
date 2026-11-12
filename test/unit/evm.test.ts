import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transaction, Wallet, getAddress, encodeRlp, decodeRlp, AbiCoder, hexlify, randomBytes } from 'ethers';
import { HDKey } from '@scure/bip32';
import { checksumAddress, addressFromPrivateKey, signTransaction, signPersonalMessage, verifyPersonalMessage, rlpEncode, rlpDecode, decodeString, decodeUint, erc20Transfer, hex, unhex, isValidEvmAddress, type RlpItem } from '../../src/coins/evm/eth.ts';
import { bip39Seed } from '../../src/coins/seeds/bip39.ts';

const PRIV = unhex('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318');

test('EIP-55 checksums match ethers', () => {
  for (let i = 0; i < 50; i++) {
    const a = hexlify(randomBytes(20));
    assert.equal(checksumAddress(a), getAddress(a));
  }
  assert.ok(isValidEvmAddress('0x52908400098527886E0F7030069857D2E4169EE7'));
  assert.ok(isValidEvmAddress('0x52908400098527886e0f7030069857d2e4169ee7'));
  assert.ok(!isValidEvmAddress('0x52908400098527886E0F7030069857D2E4169eE7'));
});

test("BIP44 m/44'/60'/0'/0/0 of the abandon…about mnemonic (Cake's EVM key)", async () => {
  const seed = await bip39Seed('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
  const k = HDKey.fromMasterSeed(seed).derive("m/44'/60'/0'/0/0").privateKey!;
  assert.equal(addressFromPrivateKey(k), '0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
});

test('legacy EIP-155 transactions serialize like ethers', async () => {
  const w = new Wallet(hex(PRIV));
  for (const chainId of [56, 137, 8453, 42161, 4663]) {
    const tx = { chainId, nonce: 7n, to: '0x3535353535353535353535353535353535353535', value: 10n ** 18n, data: new Uint8Array(0), gasLimit: 21000n, gasPrice: 20_000_000_000n };
    const ours = signTransaction(tx, PRIV);
    const theirs = await w.signTransaction({ type: 0, chainId, nonce: 7, to: tx.to, value: tx.value, gasLimit: tx.gasLimit, gasPrice: tx.gasPrice, data: '0x' });
    assert.equal(hex(ours.raw), theirs);
    assert.equal(ours.hash, Transaction.from(theirs).hash);
  }
});

test('EIP-1559 type-2 transactions (ERC-20 transfer) serialize like ethers', async () => {
  const w = new Wallet(hex(PRIV));
  const data = erc20Transfer('0x9858EfFD232B4033E47d90003D41EC34EcaEda94', 1_234_567n);
  const tx = { chainId: 1, nonce: 0n, to: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', value: 0n, data, gasLimit: 65_000n, maxFeePerGas: 31_000_000_000n, maxPriorityFeePerGas: 2_000_000_000n };
  const ours = signTransaction(tx, PRIV);
  const theirs = await w.signTransaction({ type: 2, chainId: 1, nonce: 0, to: tx.to, value: 0n, data: hex(data), gasLimit: tx.gasLimit, maxFeePerGas: tx.maxFeePerGas, maxPriorityFeePerGas: tx.maxPriorityFeePerGas });
  assert.equal(hex(ours.raw), theirs);
  const parsed = Transaction.from(theirs);
  assert.equal(parsed.from, addressFromPrivateKey(PRIV));
  assert.equal(ours.hash, parsed.hash);
});

test('personal_sign matches ethers and verifies', async () => {
  const w = new Wallet(hex(PRIV));
  for (const m of ['hello', 'Cake Wallet ✓ 🎂', '']) {
    const ours = signPersonalMessage(m, PRIV);
    assert.equal(`0x${ours}`, await w.signMessage(m));
    assert.ok(verifyPersonalMessage(m, ours, w.address));
    assert.ok(!verifyPersonalMessage(`${m}x`, ours, w.address));
  }
});

test('RLP and ABI helpers', () => {
  const items: RlpItem[] = [new Uint8Array(0), Uint8Array.of(0x7f), Uint8Array.of(0x80), new Uint8Array(60).fill(1), [Uint8Array.of(1, 2), [new Uint8Array(0)]]];
  const enc = rlpEncode(items);
  const toHexTree = (x: RlpItem): any => (x instanceof Uint8Array ? hex(x) : x.map(toHexTree));
  assert.equal(hex(enc), encodeRlp(toHexTree(items)));
  assert.deepEqual(toHexTree(rlpDecode(enc)), decodeRlp(hex(enc)));
  const abi = AbiCoder.defaultAbiCoder();
  assert.equal(decodeString(abi.encode(['string'], ['USD Coin'])), 'USD Coin');
  assert.equal(decodeUint(abi.encode(['uint256'], [123456789n])), 123456789n);
  assert.equal(decodeString('0x4d4b520000000000000000000000000000000000000000000000000000000000'), 'MKR');
});
