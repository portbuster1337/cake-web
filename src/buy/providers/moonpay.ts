// MoonPay (lib/buy/moonpay/moonpay_provider.dart): buy and sell, every pair.
// Quotes need MoonPay's publishable key; the payment methods come from Cake's
// exchange helper (none here, as when Cake's helper fails), and the widget
// link carries the wallet address, which MoonPay only accepts signed — Cake's
// helper signs it, here the user's MoonPay secret key does
// (signature = base64 HMAC-SHA256 of the query string).

import { exFetch, tryJson } from '../../exchange/net.ts';
import { apiKey } from '../../exchange/keys.ts';
import { language } from '../../core/i18n.ts';
import { pairCurrency } from '../pairs.ts';
import { moonpaySignature } from '../signing.ts';
import { BuyKeyError, type BuyProvider, type PaymentType, type Quote } from '../types.ts';
import type { SwapCurrency } from '../../exchange/currency.ts';

const API = 'https://api.moonpay.com';
const KEY = 'moonpay';
const SECRET = 'moonpaySecret';
const TIMEOUT_MS = 30_000;

/** _moonPayPaymentMethodStrings */
const METHODS: Partial<Record<PaymentType, string>> = {
  creditCard: 'credit_debit_card', debitCard: 'credit_debit_card', ach: 'ach_bank_transfer', applePay: 'apple_pay', googlePay: 'google_pay',
  sepa: 'sepa_bank_transfer', paypal: 'paypal', sepaOpenBankingPayment: 'sepa_open_banking_payment', gbpOpenBankingPayment: 'gbp_open_banking_payment',
  lowCostAch: 'low_cost_ach', mobileWallet: 'mobile_wallet', pixInstantPayment: 'pix_instant_payment', yellowCardBankTransfer: 'yellow_card_bank_transfer',
  fiatBalance: 'fiat_balance', revolutPay: 'revolut_pay', moonpayCashApp: 'cash_app', moonpayBalance: 'moonpay_balance',
};
/** _paymentTypeByMoonPayString (the last type of a string wins, as the Dart map literal does) */
const BY_STRING: Record<string, PaymentType> = Object.fromEntries(Object.entries(METHODS).map(([k, v]) => [v, k as PaymentType]));
const typeOf = (s: string | undefined | null): PaymentType => (s ? BY_STRING[s] ?? 'unknown' : 'unknown');

const toDouble = (v: unknown): number | null => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/** _normalizeCurrency */
function currencyCode(c: SwapCurrency): string {
  if (c.tag === 'POLY') return `${c.title.toLowerCase()}_polygon`;
  if (c.tag === 'TRX') return `${c.title.toLowerCase()}_trx`;
  if (c.tag === 'ARB') return `${c.title.toLowerCase()}_arbitrum`;
  return c.title.toLowerCase();
}

export function createMoonPay(): BuyProvider {
  const provider: BuyProvider = {
    title: 'MoonPay',
    description: 'MoonPay offers a fast and simple way to buy and sell cryptocurrencies',
    icon: 'assets/images/moonpay_dark.png',
    lightIcon: 'assets/images/moonpay_light.png',
    isAggregator: false,
    needsApiKey: KEY,

    supports(c) {
      return !!apiKey(KEY) && !!pairCurrency(c);
    },

    /** fetchMoonPayPaymentMethods asks Cake's exchange helper: unavailable here, so none (Cake's catch) */
    async paymentTypes() {
      return [];
    },

    async fetchQuote(a) {
      if (!apiKey(KEY)) return null;
      const paymentMethod = a.paymentType && a.paymentType !== 'all' ? METHODS[a.paymentType] ?? a.customPaymentMethodType : undefined;
      const params: Record<string, string> = {
        baseCurrencyCode: a.isBuy ? a.fiat.toLowerCase() : a.crypto.title.toLowerCase(),
        baseCurrencyAmount: a.amount.toFixed(2),
        ...(paymentMethod ? { paymentMethod } : {}),
        areFeesIncluded: 'false',
        apiKey: apiKey(KEY),
      };
      try {
        const r = await exFetch(`${API}/v3/currencies/${currencyCode(a.crypto)}/${a.isBuy ? 'buy_quote' : 'sell_quote'}?${new URLSearchParams(params)}`, { scope: 'buy', timeoutMs: TIMEOUT_MS, purpose: 'MoonPay quote' });
        if (r.status !== 200) return null;
        const d = tryJson<any>(r);
        if (!d) return null;
        // the answer must be for the chosen fiat
        if (a.isBuy ? d.baseCurrencyCode !== a.fiat.toLowerCase() : d.quoteCurrency?.code !== a.fiat.toLowerCase()) return null;
        // Quote.fromMoonPayJson
        const fee = toDouble(d.feeAmount) ?? 0;
        const networkFee = toDouble(d.networkFeeAmount) ?? 0;
        const transactionFee = toDouble(d.extraFeeAmount) ?? 0;
        const base = d.baseCurrency;
        const quote: Quote = {
          rate: (a.isBuy ? toDouble(d.quoteCurrencyPrice) : toDouble(d.baseCurrencyPrice)) ?? 0,
          feeAmount: Number((fee + networkFee + transactionFee).toFixed(2)),
          networkFee,
          transactionFee,
          payout: toDouble(d.quoteCurrencyAmount) ?? 0,
          paymentType: typeOf(d.paymentMethod ?? paymentMethod),
          customPaymentMethodType: paymentMethod,
          recommendations: [],
          quoteId: String(d.signature ?? ''),
          provider,
          isBuyAction: a.isBuy,
          limits: { min: toDouble(base?.minAmount) ?? 0, max: toDouble(base?.maxAmount) ?? Infinity },
          fiat: a.fiat,
          crypto: a.crypto,
        };
        return [quote];
      } catch {
        return null;
      }
    },

    async launchUrl({ quote, amount, isBuy, cryptoCurrencyAddress }) {
      const dark = typeof document === 'undefined' || document.documentElement.dataset.theme !== 'light';
      const params: Record<string, string> = {
        theme: dark ? 'dark' : 'light',
        language: language.value,
        colorCode: dark ? '#456eff' : '#815dfb',
        baseCurrencyCode: isBuy ? quote.fiat : quote.crypto.name,
        baseCurrencyAmount: amount.toFixed(2),
        walletAddress: cryptoCurrencyAddress,
        lockAmount: 'false',
        showAllCurrencies: 'false',
        showWalletAddressForm: 'false',
        ...(isBuy ? { enabledPaymentMethods: METHODS[quote.paymentType] ?? quote.customPaymentMethodType ?? 'credit_debit_card,apple_pay,google_pay,samsung_pay,sepa_bank_transfer,gbp_bank_transfer,gbp_open_banking_payment' } : { refundWalletAddress: cryptoCurrencyAddress }),
        ...(isBuy ? { currencyCode: quote.crypto.name } : { quoteCurrencyCode: quote.crypto.name }),
        apiKey: apiKey(KEY),
      };
      // getMoonpaySignedQuery: Cake's exchange helper; here the user's secret key
      const secret = apiKey(SECRET);
      if (!secret) throw new BuyKeyError('MoonPay needs your MoonPay secret key to sign its link (Settings → Connection and sync → API keys)');
      const query = `?${new URLSearchParams(params)}`;
      return `https://${isBuy ? 'buy.moonpay.com' : 'sell.moonpay.com'}/${query}&signature=${encodeURIComponent(moonpaySignature(query, secret))}`;
    },

    launchError(message) {
      return { title: 'MoonPay', content: `The MoonPay service is currently unavailable: ${message}` };
    },
  };
  return provider;
}
