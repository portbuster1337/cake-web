// calculateBestRate's arrangement of the quotes (buy_sell_view_model.dart).

import type { Quote } from './types.ts';

const isOnramper = (q: Quote) => q.provider.title === 'Onramper';

/**
 * By payout (most crypto first when buying, least first when selling); the first quote of each provider is
 * recommended, plus Onramper's "success rate" ones; the rest are "more options". Onramper's recommended quotes come
 * first, the cheapest rate among them gets the "Best Rate" badge (again, if it had one), and the first is selected.
 * bestRateQuote is the best payout, taken before Onramper's are moved up.
 */
export function arrangeQuotes(list: Quote[], isBuy: boolean): { recommended: Quote[]; others: Quote[]; best: Quote | null; selected: Quote | null } {
  const quotes = [...list].sort((a, b) => (isBuy ? b.payout - a.payout : a.payout - b.payout));
  const seen = new Set<string>();
  const recommended = quotes.filter((q) => (seen.has(q.provider.title) ? false : (seen.add(q.provider.title), true)));
  for (const q of quotes) if (isOnramper(q) && q.recommendations.includes('successRate') && !recommended.includes(q)) recommended.push(q);
  const others = quotes.filter((q) => !recommended.includes(q));
  if (!recommended.length) return { recommended, others, best: null, selected: null };
  const best = recommended[0];
  // a stable partition, as Dart's insertion sort does with this comparator
  recommended.sort((a, b) => Number(isOnramper(b)) - Number(isOnramper(a)));
  const cheapest = recommended.reduce((a, b) => (isBuy ? (a.rate < b.rate ? a : b) : a.rate > b.rate ? a : b));
  cheapest.recommendations.push('bestRate');
  return { recommended, others, best, selected: recommended[0] };
}
