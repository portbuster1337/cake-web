// Small helpers of the swap pages.

import { WALLET_CURRENCY, currency } from '../../../coins/types.ts';
import { chainIconOf, walletTypeOf, type SwapCurrency } from '../../../exchange/currency.ts';

/** middleTruncate */
export function middleTruncate(s: string, head: number, tail: number): string {
  return s.length <= head + tail + 3 ? s : `${s.slice(0, head)}...${s.slice(s.length - tail)}`;
}

/** _resolveChainBadgePath: the currency's badge, its tag's, else its wallet type's coin's */
export function badgeFor(c: SwapCurrency): string | null {
  const b = chainIconOf(c);
  if (b) return b;
  const wt = walletTypeOf(c);
  return wt ? currency(WALLET_CURRENCY[wt]).chainIconPath : null;
}
