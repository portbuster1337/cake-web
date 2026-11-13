// pairs_utils.dart: a provider's pairs are CryptoCurrency.all × FiatCurrency.all
// minus its exclusions, and the view model matches the selected currency
// against them by symbol (title) and tag — tokens match the built-in of the
// same title and chain.

import { ALL_CURRENCIES, type Currency } from '../coins/types.ts';
import type { SwapCurrency } from '../exchange/currency.ts';

export function pairCurrency(c: Pick<SwapCurrency, 'title' | 'tag'>): Currency | undefined {
  return ALL_CURRENCIES.find((x) => x.title === c.title && x.tag === c.tag);
}
