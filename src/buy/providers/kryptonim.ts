// Kryptonim (lib/buy/kryptonim/kryptonim.dart): buy with card or bank, every
// pair. Its quote API needs Cake's merchant key (here the user's); its widget
// link is plain.

import { exFetch, tryJson } from '../../exchange/net.ts';
import { builtinOf } from '../../exchange/currency.ts';
import { apiKey } from '../../exchange/keys.ts';
import { pairCurrency } from '../pairs.ts';
import { paymentTypeId, type BuyProvider, type PaymentMethod, type PaymentType, type Quote } from '../types.ts';
import type { SwapCurrency } from '../../exchange/currency.ts';

const API = 'https://app.kryptonim.com/v2/ramp/buy/quotes';
const WIDGET = 'https://buy.kryptonim.com/redirect-form';
const MERCHANT_ID = 'a70fe053';
const KEY = 'kryptonim';
const TIMEOUT_MS = 30_000;

const toDouble = (v: unknown): number | null => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/** _normalizeBlockChain: by tag, then by coin, else the full name */
function blockchainOf(c: SwapCurrency): string {
  switch (c.tag) {
    case 'ETH': return 'Ethereum';
    case 'BASE': return 'Base';
    case 'ARB': return 'Arbitrum';
    case 'POL': return 'Polygon';
    case 'AVAXC': return 'Avalanche';
    case 'SOL': return 'Solana';
  }
  switch (builtinOf(c)?.key) {
    case 'btc': return 'Bitcoin';
    case 'ltc': return 'Litecoin';
    case 'eth': return 'Ethereum';
    case 'baseEth': return 'Base';
    case 'arbEth': return 'Arbitrum';
    case 'maticpoly': return 'Matic';
  }
  return c.fullName ?? '';
}

/** normalizePaymentMethod */
const methodOf = (p: PaymentType) => (p === 'bankTransfer' ? 'bank' : p === 'creditCard' || p === 'debitCard' ? 'card' : p.toLowerCase());

export function createKryptonim(): BuyProvider {
  /** getExchangeRates: 200, 201 and 401 answers are read */
  const rates = async (c: SwapCurrency, fiat: string, amount: number): Promise<any> => {
    try {
      const r = await exFetch(`${API}?${new URLSearchParams({ m: MERCHANT_ID })}`, {
        headers: { accept: 'application/json', Authorization: apiKey(KEY) },
        body: { amount, currency: fiat, converted_currency: c.title, blockchain: blockchainOf(c), quote_currency: fiat },
        scope: 'buy',
        timeoutMs: TIMEOUT_MS,
        purpose: 'Kryptonim quotes',
      });
      return r.status === 200 || r.status === 201 || r.status === 401 ? tryJson<any>(r) ?? {} : {};
    } catch {
      return {};
    }
  };

  const provider: BuyProvider = {
    title: 'Kryptonim',
    description: 'Kryptonim Buy Provider',
    icon: 'assets/images/kryptonim_dark.png',
    lightIcon: 'assets/images/kryptonim_light.png',
    isAggregator: false,
    needsApiKey: KEY,

    supports(c) {
      return !!apiKey(KEY) && !!pairCurrency(c);
    },

    async paymentTypes(fiat, crypto) {
      if (!apiKey(KEY)) return [];
      const d = await rates(crypto, fiat, 100);
      if (!Array.isArray(d?.data)) return [];
      // PaymentMethod.fromKryptonimJson
      return d.data.map((e: any): PaymentMethod => ({ type: paymentTypeId(e?.payment_method) ?? 'unknown', customTitle: e?.payment_method ?? 'Unknown', customIconPath: 'assets/new-ui/buy_payment_methods/debit_card.svg' }));
    },

    async fetchQuote(a) {
      if (!apiKey(KEY)) return null;
      const d = await rates(a.crypto, a.fiat, a.amount);
      const list: any[] = Array.isArray(d?.data) ? d.data : [];
      if (!list.length) return null;
      const chosen = a.paymentType === 'all' || !a.paymentType ? list[0] : list.find((q) => paymentTypeId(q?.payment_method) === a.paymentType);
      if (!chosen) return null;
      try {
        // Quote.fromKryptonimJson: the rate is amount ÷ converted amount
        const converted = toDouble(chosen.converted_amount) ?? 0;
        const amount = toDouble(chosen.amount) ?? 0;
        const quote: Quote = {
          rate: amount / converted,
          feeAmount: toDouble(chosen.fees.totalFee) ?? 0,
          networkFee: toDouble(chosen.fees.network_fee) ?? 0,
          transactionFee: toDouble(chosen.fees.operation_fee) ?? 0,
          payout: amount,
          paymentType: paymentTypeId(chosen.payment_method) ?? 'unknown',
          recommendations: [],
          provider,
          isBuyAction: a.isBuy,
          limits: { min: toDouble(chosen.limits.min_amount) ?? 0, max: toDouble(chosen.limits.max_amount) ?? Infinity },
          fiat: a.fiat,
          crypto: a.crypto,
        };
        return [quote];
      } catch {
        return null;
      }
    },

    async launchUrl({ quote, amount, cryptoCurrencyAddress }) {
      const q = new URLSearchParams({
        amount: String(Math.trunc(amount)),
        currency: quote.fiat,
        convertedCurrency: quote.crypto.title,
        blockchain: blockchainOf(quote.crypto),
        address: cryptoCurrencyAddress,
        paymentMethod: methodOf(quote.paymentType),
      });
      return `${WIDGET}?${q}`;
    },

    launchError(message) {
      return { title: 'Kryptonim', content: `Payment provider is unavailable: ${message}` };
    },
  };
  return provider;
}
