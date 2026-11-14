// Paying a trade's deposit from the wallet (ExchangeTradeViewModel.confirmSending,
// SendViewModel.createTransaction's swap paths).

import { formatFixed } from '../core/amount.ts';
import { amountOf } from './amounts.ts';
import { settings } from '../app/settings.ts';
import { isEvm } from '../coins/types.ts';
import { EVM_TOKEN_TAGS } from '../coins/tokens.gen.ts';
import type { PendingTransaction, WalletBase } from '../core/wallet.ts';
import { builtinOf, titleTagEqual, type SwapCurrency } from './currency.ts';
import { executeJupiterSwap, JupiterSwapFailedError } from './providers/jupiter.ts';
import { EVM_NATIVE, methodSelector, registerSwapsXyzTx, SWAP_AND_EXECUTE_SIG, TRANSFER_SIG, ZERO_ADDRESS } from './providers/swapsxyz.ts';
import { decodeWord, encodeCall, SELECTOR, unhex } from '../coins/evm/eth.ts';
import { saveTrade, findTrade } from './trades.ts';
import { PROVIDERS, STATES, type Trade } from './types.ts';

interface WalletAsset {
  key: string;
  title: string;
  tag: string | null;
  decimals: number;
  address?: string;
}

/** the wallet's balance keys as Cake's currencies: the native coin (with its tag) and the tokens (tagged with the chain) */
function walletAssets(w: WalletBase): WalletAsset[] {
  const native: WalletAsset = { key: w.currency.key, title: w.currency.title, tag: w.currency.tag, decimals: w.currency.decimals };
  const list = ((w as any).assetList?.() ?? []) as { key: string; symbol: string; decimals: number; address?: string; isNative: boolean }[];
  const tag = isEvm(w.type) ? EVM_TOKEN_TAGS[w.type] : w.type === 'solana' ? 'SOL' : w.type === 'tron' ? 'TRX' : null;
  return [native, ...list.filter((a) => !a.isNative && a.address).map((a) => ({ key: a.key, title: a.symbol.toUpperCase(), tag, decimals: a.decimals, address: a.address }))];
}

/**
 * The wallet's asset for a swap currency: EVM by title and (tag or title as tag) (evm_chain_wallet.dart:862),
 * Solana by mint, else title and tag (resolveTransactionCurrency), Tron by title and tag; others only their coin.
 */
export function walletAssetFor(w: WalletBase, c: SwapCurrency | undefined): string | undefined {
  if (!c) return undefined;
  const assets = walletAssets(w);
  if (isEvm(w.type)) return assets.find((a) => a.title === c.title && (a.tag === c.tag || a.tag === c.title))?.key;
  if (w.type === 'solana') {
    if (c.address) return assets.find((a) => a.address === c.address)?.key;
    return assets.find((a) => a.title === c.title && a.tag === c.tag)?.key;
  }
  if (w.type === 'tron') return assets.find((a) => a.title === c.title && a.tag === c.tag)?.key;
  return builtinOf(c)?.key === w.currency.key ? w.currency.key : undefined;
}

function decimalsOf(w: WalletBase, key: string): number {
  return walletAssets(w).find((a) => a.key === key)?.decimals ?? w.currency.decimals;
}

/** checkIfCanSend: the trade's deposit is this wallet's coin, BTC Lightning on Bitcoin, or a token of its chain */
export function checkIfCanSend(trade: Trade | undefined, w: WalletBase): string | null {
  if (!trade) return 'Trade is null';
  const from = trade.from;
  if (!from) return 'Trade from currency is null';
  const wc = { title: w.currency.title, tag: w.currency.tag } as SwapCurrency;
  const tokenOf = (key: string) => {
    if (w.currency.key !== key) return false;
    const chainTag = (w.currency.tag ?? w.currency.title).toUpperCase();
    return from.tag?.toUpperCase() === chainTag || from.title.toUpperCase() === chainTag;
  };
  const ok =
    titleTagEqual(from, wc) ||
    (from.title === 'BTC' && from.tag === 'LN' && w.currency.key === 'btc') ||
    ['eth', 'maticpoly', 'baseEth', 'arbEth', 'trx', 'sol', 'bnb', 'robEth'].some(tokenOf);
  if (!ok) return `Wallet currency ${w.currency.title} does not match trade from currency ${from.title} or is not a supported token for this wallet.`;
  return null;
}


/** the transaction that pays a trade's deposit (sendViewModel.createTransaction(provider, trade)) */
export async function buildSwapTransaction(w: WalletBase, trade: Trade): Promise<PendingTransaction> {
  const err = checkIfCanSend(trade, w);
  if (err) throw new Error(err);
  if (trade.providerRaw === PROVIDERS.jupiter.raw && w.type === 'solana') return jupiterTransaction(w, trade);
  if (trade.providerRaw === PROVIDERS.swapsXyz.raw) {
    const p = isEvm(w.type) && trade.routerData && trade.routerData !== '0x' ? await swapsXyzTransaction(w as CallWallet, trade) : await depositTransaction(w, trade);
    return withSwapsXyz(trade, p);
  }
  return depositTransaction(w, trade);
}

/** a payment of the deposit to the trade's address */
async function depositTransaction(w: WalletBase, trade: Trade): Promise<PendingTransaction> {
  const asset = walletAssetFor(w, trade.from) ?? w.currency.key;
  const amount = amountOf(trade.amount, decimalsOf(w, asset));
  const pending = await w.createTransaction({
    outputs: [{ address: trade.inputAddress ?? '', amount, sendAll: !!trade.isSendAll, asset: asset === w.currency.key ? undefined : asset }],
    priority: settings.peek().priority[w.type] ?? w.defaultPriority(),
    // Litecoin never spends MWEB coins in a swap
    coinType: w.type === 'litecoin' ? 'nonMweb' : undefined,
  });
  // send_view_model.dart: a send-all Near Intents trade needs exactly the quoted amount
  if (trade.providerRaw === PROVIDERS.nearIntents.raw && trade.isSendAll && pending.amount !== amount) {
    throw new Error(`The amount to send (${formatFixed(pending.amount, decimalsOf(w, asset))}) does not match the swap amount (${trade.amount}). Please create a new swap.`);
  }
  return pending;
}

export interface CallWallet extends WalletBase {
  address: string;
  chainId?: number;
  callContract(to: string, data: Uint8Array): Promise<string>;
  createContractCall(to: string, data: Uint8Array, opts?: { priority?: string; amount?: bigint; amountDecimals?: number; value?: bigint; record?: { currency: string; amount: bigint }; fallbackGas?: bigint }): Promise<PendingTransaction>;
}

const USDT_ETHEREUM = '0xdac17f958d2ee523a2206206994597c13d831ec7';
/** BigInt.tryParse (decimal, or hex after 0x) */
const tryBig = (s: string | undefined) => {
  const v = (s ?? '').trim().replace(/n$/, '');
  return /^\d+$/.test(v) || /^0x[0-9a-f]+$/i.test(v) ? BigInt(v) : 0n;
};
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** getAllowance (null when the node cannot say) */
async function allowanceOf(w: CallWallet, token: string, spender: string): Promise<bigint | null> {
  try {
    return decodeWord(await w.callContract(token, encodeCall(SELECTOR.allowance, [{ address: w.address }, { address: spender }])));
  } catch {
    return null;
  }
}

/** _waitForApprovalUpdate: the allowance read every second, 30 times, until it reaches the amount (or drops to it) */
async function waitForAllowance(w: CallWallet, token: string, spender: string, amount: bigint, exact = false): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    const a = await allowanceOf(w, token, spender);
    if (a !== null && (exact ? a <= amount : a >= amount)) return true;
    await sleep(1000);
  }
  return false;
}

/** buildApprovalNeeded, committed */
async function approve(w: CallWallet, token: string, spender: string, amount: bigint, priority: string): Promise<void> {
  const p = await w.createContractCall(token, encodeCall(SELECTOR.approve, [{ address: spender }, { uint: amount }]), { priority });
  await p.commit();
}

/**
 * SendViewModel.createTransaction's Swaps.xyz path: a transfer call as it is; swapAndExecute after the router may take
 * the token (an approval of the amount, Tether on Ethereum first back to zero), with the call's value
 */
export async function swapsXyzTransaction(w: CallWallet, trade: Trade): Promise<PendingTransaction> {
  const routerTo = trade.inputAddress;
  const data = trade.routerData!;
  if (!routerTo) throw new Error('Invalid router address');
  const priority = settings.peek().priority[w.type] ?? w.defaultPriority();
  const value = tryBig(trade.routerValue);
  const selector = methodSelector(data);
  const failed = (e: unknown) => new Error(`Failed to create Swaps.xyz transaction - ${(e as Error).message}`);
  if (selector === TRANSFER_SIG) {
    try {
      return await w.createContractCall(routerTo, unhex(data), { priority, value: 0n, fallbackGas: 300_000n });
    } catch (e) {
      throw failed(e);
    }
  }
  if (selector !== SWAP_AND_EXECUTE_SIG) throw new Error('Unsupported Swaps.xyz transaction type');
  const token = (trade.sourceTokenAddress ?? '').toLowerCase();
  const required = tryBig(trade.sourceTokenAmountRaw);
  const native = !token || token === ZERO_ADDRESS || token === EVM_NATIVE;
  // isApprovalRequired: none for the coin; an unreadable allowance counts as too low
  if (!native && required > 0n) {
    const current = await allowanceOf(w, token, routerTo);
    if (current === null || current < required) {
      if (w.chainId === 1 && token === USDT_ETHEREUM && current !== null && current > 0n) {
        await approve(w, token, routerTo, 0n, priority);
        if (!(await waitForAllowance(w, token, routerTo, 0n, true))) throw new Error('Failed to reset USDT allowance. Please try again.');
      }
      await approve(w, token, routerTo, required, priority);
      if (!(await waitForAllowance(w, token, routerTo, required))) throw new Error('Approval transaction failed or timed out on-chain. Try again.');
    }
  }
  // createCallDataTransaction: the token must be in the wallet, with enough of it
  const tokenKey = native ? w.currency.key : ((w as any).tokens as { address: string }[] | undefined)?.find((x) => x.address.toLowerCase() === token)?.address;
  if (!native && required > 0n) {
    if (!tokenKey) throw failed(new Error('Insufficient token balance (Token not found in wallet).'));
    if ((w.balances.value[tokenKey]?.available ?? 0n) < required) throw failed(new Error(`Insufficient ${trade.from?.title ?? ''} balance to cover the transaction amount.`));
  }
  try {
    return await w.createContractCall(routerTo, unhex(data), { priority, value, fallbackGas: 300_000n, amount: native ? value : required, amountDecimals: native ? 18 : trade.sourceTokenDecimals ?? 18, record: { currency: tokenKey ?? w.currency.key, amount: native ? value : required } });
  } catch (e) {
    throw failed(e);
  }
}

/**
 * ExchangeTradeViewModel.confirmSending: the trade keeps the transaction's hash; after the broadcast,
 * registerSwapsXyzTransaction (alt-VM routes)
 */
async function withSwapsXyz(trade: Trade, p: PendingTransaction): Promise<PendingTransaction> {
  await saveTrade({ ...(findTrade(trade.id) ?? trade), txId: p.id });
  return {
    ...p,
    commit: async () => {
      await p.commit();
      const vmId = (trade.providerId ?? '').toLowerCase();
      const chainId = /^\d+$/.test(trade.router ?? '') ? Number(trade.router) : 0;
      if (trade.needToRegisterInSwapXyz && vmId && p.id && chainId > 0) void registerSwapsXyzTx({ txId: trade.id, txHash: p.id, chainId, vmId });
    },
  };
}

/** signAndPrepareJupiterSwapTransaction: sign Jupiter's transaction; sending it is Jupiter's /execute */
function jupiterTransaction(w: WalletBase, trade: Trade): PendingTransaction {
  const sol = w as unknown as { signTransactionBase64(b64: string): { signed: string; signature: string }; watchSignature(sig: string): void };
  if (!trade.routerData || !trade.routerValue) throw new Error('Failed to process Jupiter swap: the swap has no transaction');
  const { signed } = sol.signTransactionBase64(trade.routerData);
  const from = trade.from;
  const decimals = from?.decimals ?? 9;
  const amount = amountOf(trade.amount, decimals);
  const feeSol = trade.fee && trade.fee > 0 ? trade.fee : 0.0005;
  const fee = amountOf(feeSol.toFixed(9), 9);
  const finish = async (signature: string, ok: boolean) => {
    const cur = findTrade(trade.id) ?? trade;
    await saveTrade({ ...cur, txId: signature, stateRaw: ok ? STATES.completed.raw : STATES.failed.raw });
  };
  return {
    id: trade.id,
    amount,
    fee,
    amountFormatted: formatFixed(amount, decimals),
    feeFormatted: formatFixed(fee, 9),
    commit: async () => {
      try {
        const signature = await executeJupiterSwap(signed, trade.routerValue!);
        await finish(signature, true);
        sol.watchSignature(signature);
      } catch (e) {
        await finish(e instanceof JupiterSwapFailedError ? e.signature : '', false);
        throw e;
      }
    },
  };
}

