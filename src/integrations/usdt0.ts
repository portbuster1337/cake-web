// USDT0 over LayerZero (cw_evm/lib/usdt0/*, cw_evm/lib/contract/oft.dart): the
// OFT contracts on Ethereum (an adapter for Tether's USDT), Polygon and
// Arbitrum; quoteSend for the LayerZero fee, then send with that fee as value.
// Addresses and endpoint IDs from https://docs.usdt0.to/technical-documentation/deployments

import { concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import { decodeWord, encodeAbi, encodeCall, SELECTOR, selectorOf, type AbiValue } from '../coins/evm/eth.ts';
import type { PendingTransaction } from '../core/wallet.ts';

export const ETHEREUM_CHAIN_ID = 1;
export const USDT0_TOKEN: Record<number, string> = {
  1: '0xdac17f958d2ee523a2206206994597c13d831ec7',
  137: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
  42161: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
};
export const USDT0_OFT: Record<number, string> = {
  1: '0x6C96dE32CEa08842dcc4058c14d3aaAD7Fa41dee',
  137: '0x6BA10300f0DC58B7a1e4c0e41f5daBb7D7829e13',
  42161: '0x14E4A1B13bf7F943c8ff7C51fb60FA964A298D92',
};
export const USDT0_EID: Record<number, number> = { 1: 30101, 137: 30109, 42161: 30110 };
/** the chain registry's order */
const CHAIN_ORDER = [1, 137, 8453, 42161, 56, 4663];
const MAX_UINT256 = (1n << 256n) - 1n;

export interface MessagingFee {
  nativeFee: bigint;
  lzTokenFee: bigint;
}

/** USDT0Config.isUSDT0Token */
export const isUsdt0Token = (chainId: number, contract: string | undefined) => !!contract && USDT0_TOKEN[chainId]?.toLowerCase() === contract.toLowerCase();

/** getUSDT0DestinationChains: the other supported chains */
export const usdt0DestinationChains = (chainId: number): number[] => CHAIN_ORDER.filter((c) => USDT0_TOKEN[c] && c !== chainId);

/** addressToBytes32: the address left-padded to 32 bytes */
export const addressToBytes32 = (address: string): string => `0x${'0'.repeat(24)}${address.replace(/^0x/i, '').toLowerCase()}`;

const SEND_PARAM = '(uint32,bytes32,uint256,uint256,bytes,bytes,bytes)';
const SEL_QUOTE = selectorOf(`quoteSend(${SEND_PARAM},bool)`);
const SEL_SEND = selectorOf(`send(${SEND_PARAM},(uint256,uint256),address)`);

/** SendParam: no extra options, compose message or OFT command */
function sendParam(dstEid: number, to: string, amount: bigint, minAmount: bigint): AbiValue {
  const empty = new Uint8Array();
  return { tuple: [{ uint: BigInt(dstEid) }, { bytes32: addressToBytes32(to) }, { uint: amount }, { uint: minAmount }, { bytes: empty }, { bytes: empty }, { bytes: empty }] };
}

export const encodeQuoteSend = (dstEid: number, to: string, amount: bigint, minAmount = 0n) => concatBytes(hexToBytes(SEL_QUOTE), encodeAbi([sendParam(dstEid, to, amount, minAmount), { bool: false }]));

export const encodeOftSend = (dstEid: number, to: string, amount: bigint, minAmount: bigint, fee: MessagingFee, refund: string) =>
  concatBytes(hexToBytes(SEL_SEND), encodeAbi([sendParam(dstEid, to, amount, minAmount), { tuple: [{ uint: fee.nativeFee }, { uint: fee.lzTokenFee }] }, { address: refund }]));

/** quoteSend's MessagingFee */
export const decodeMessagingFee = (result: string): MessagingFee => ({ nativeFee: decodeWord(result, 0), lzTokenFee: decodeWord(result, 1) });

/** what the bridge needs from an EVM wallet */
export interface Usdt0Wallet {
  address: string;
  callContract(to: string, data: Uint8Array): Promise<string>;
  createContractCall(to: string, data: Uint8Array, opts?: { priority?: string; amount?: bigint; amountDecimals?: number; value?: bigint; record?: { currency: string; amount: bigint } }): Promise<PendingTransaction>;
  transactionReceipt(hash: string): Promise<boolean | null>;
}

function supported(src: number, dst: number): { oft: string; eid: number } {
  const oft = USDT0_OFT[src];
  const eid = USDT0_EID[dst];
  if (!oft) throw new Error(`USDT0 not supported for chain ${src}`);
  if (!eid) throw new Error(`USDT0 not supported for chain ${dst}`);
  return { oft, eid };
}

/** quoteCrossChainTransfer */
export async function quoteUsdt0(w: Usdt0Wallet, src: number, dst: number, amount: bigint, recipient: string): Promise<MessagingFee> {
  const { oft, eid } = supported(src, dst);
  return decodeMessagingFee(await w.callContract(oft, encodeQuoteSend(eid, recipient, amount, 0n)));
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** an approval, sent and then waited for, so the bridge transaction's gas is estimated against it */
async function approve(w: Usdt0Wallet, token: string, spender: string, value: bigint, priority?: string): Promise<void> {
  const p = await w.createContractCall(token, encodeCall(SELECTOR.approve, [{ address: spender }, { uint: value }]), { priority });
  await p.commit();
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    await sleep(4_000);
    const r = await w.transactionReceipt(p.id).catch(() => null);
    if (r === true) return;
    if (r === false) throw new Error('The approval transaction reverted');
  }
  throw new Error('The approval is not confirmed yet; try again in a few minutes');
}

/**
 * executeCrossChainTransfer: from Ethereum the adapter must be allowed to take the USDT (an infinite approval; Tether
 * takes a new allowance only from zero); then send with the quoted fee, the wallet refunded any excess.
 */
export async function executeUsdt0(w: Usdt0Wallet, o: { src: number; dst: number; amount: bigint; recipient: string; fee: MessagingFee; token: string; tokenKey: string; priority?: string }): Promise<PendingTransaction> {
  const { oft, eid } = supported(o.src, o.dst);
  if (o.src === ETHEREUM_CHAIN_ID) {
    const allowance = decodeWord(await w.callContract(o.token, encodeCall(SELECTOR.allowance, [{ address: w.address }, { address: oft }])));
    if (allowance < o.amount) {
      if (allowance > 0n) await approve(w, o.token, oft, 0n, o.priority);
      await approve(w, o.token, oft, MAX_UINT256, o.priority);
    }
  }
  return w.createContractCall(oft, encodeOftSend(eid, o.recipient, o.amount, 0n, o.fee, w.address), { priority: o.priority, value: o.fee.nativeFee, amount: o.amount, amountDecimals: 6, record: { currency: o.tokenKey, amount: o.amount } });
}
