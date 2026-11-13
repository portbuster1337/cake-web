// The payment URI of a trade's deposit, for paying it from another wallet
// (exchange_trade_view_model.dart paymentUri, cw_core/lib/payment_uris.dart).

import { WALLET_CURRENCY, type WalletType } from '../coins/types.ts';
import { EVM_DEFAULT_TOKENS, SPL_DEFAULT_TOKENS, TRON_DEFAULT_TOKENS } from '../coins/tokens.gen.ts';
import { EVM_CHAINS } from '../coins/evm/chains.ts';
import { builtinOf, walletTypeOf, type SwapCurrency } from './currency.ts';
import { amountOf, dartDouble } from './amounts.ts';
import type { Trade } from './types.ts';

/** TokenUtilities.findSolanaTokenMint / findTronTokenContract / findErc20TokenForSwap: a token's contract, built-ins by symbol */
function tokenContract(from: SwapCurrency, list: { symbol: string; address: string; decimals: number }[]): { address: string; decimals: number } | null {
  if (from.address) return { address: from.address, decimals: from.decimals };
  const t = list.find((x) => x.symbol.toUpperCase() === from.title.toUpperCase());
  return t ? { address: t.address, decimals: t.decimals } : null;
}

/** paymentUri (exchange_trade_view_model.dart, cw_core/lib/payment_uris.dart): the external-send QR, by the deposit currency's wallet type */
export function paymentUri(trade: Trade): string | null {
  const address = trade.inputAddress;
  const from = trade.from;
  if (!address || !from) return null;
  const amount = (trade.amount ?? '').replace(/,/g, '.');
  const q = (k: string) => (amount ? `?${k}=${amount}` : '');
  const type: WalletType | undefined = walletTypeOf(from);
  const key = builtinOf(from)?.key;
  switch (type) {
    case undefined: return address;
    case 'bitcoin': return `bitcoin:${address}${q('amount')}`;
    case 'bitcoinCash': return `${address}${q('amount')}`;
    case 'dogecoin': return `doge:${address}${q('amount')}`;
    case 'litecoin': return `litecoin:${address}${q('amount')}`;
    case 'monero': return `monero:${address}${q('tx_amount')}`;
    case 'wownero': return `wownero:${address}${q('tx_amount')}`;
    case 'nano': return `nano:${address}${q('amount')}`;
    case 'zano': return `zano:${address}${q('amount')}`;
    case 'decred': return `decred:${address}${q('amount')}`;
    case 'zcash': return `zcash:${address}${q('amount')}`;
    case 'banano': case 'haven': return null;
    case 'solana':
    case 'tron': {
      const native = type === 'solana' ? 'sol' : 'trx';
      const token = key === native ? null : tokenContract(from, type === 'solana' ? SPL_DEFAULT_TOKENS : TRON_DEFAULT_TOKENS);
      if (key !== native && !token) return null;
      const params = [...(amount ? [`amount=${amount}`] : []), ...(token ? [`${type === 'solana' ? 'spl-token' : 'token'}=${token.address}`] : [])];
      return `${type}:${address}${params.length ? `?${params.join('&')}` : ''}`;
    }
    default: {
      const chain = EVM_CHAINS[type];
      if (!chain) return null;
      if (key === WALLET_CURRENCY[type]) return `ethereum:${address}@${chain.chainId}${amount ? `?value=${dartDouble(Number.parseFloat(amount))}e18` : ''}`;
      const token = tokenContract(from, EVM_DEFAULT_TOKENS[type] ?? []);
      if (!token) return null;
      const params = [`address=${address}`];
      if (token.decimals === 18 && amount) params.push(`uint256=${amountOf(amount, 18)}`);
      if (amount) params.push(`amount=${amount}`);
      return `ethereum:${token.address}@${chain.chainId}/transfer?${params.join('&')}`;
    }
  }
}
