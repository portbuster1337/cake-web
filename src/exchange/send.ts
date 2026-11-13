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

