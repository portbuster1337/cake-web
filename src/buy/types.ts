// Buy / Sell core types (lib/buy/buy_provider.dart, buy_quote.dart, payment_method.dart).

import type { SwapCurrency } from '../exchange/currency.ts';

export type BuyMode = 'buy' | 'sell';

/** PaymentType */
export type PaymentType =
  | 'all' | 'bankTransfer' | 'creditCard' | 'debitCard' | 'applePay' | 'googlePay' | 'revolutPay' | 'neteller' | 'skrill' | 'sepa' | 'sepaInstant'
  | 'ach' | 'achInstant' | 'Khipu' | 'palomaBanktTansfer' | 'ovo' | 'zaloPay' | 'zaloBankTransfer' | 'gcash' | 'imps' | 'dana' | 'ideal' | 'paypal'
  | 'sepaOpenBankingPayment' | 'gbpOpenBankingPayment' | 'lowCostAch' | 'mobileWallet' | 'pixInstantPayment' | 'yellowCardBankTransfer' | 'fiatBalance'
  | 'bancontact' | 'pixPay' | 'moonpayCashApp' | 'moonpayBalance' | 'unknown';

const TITLES: Partial<Record<PaymentType, string>> = {
  all: 'All Payment Methods', bankTransfer: 'Bank Transfer', creditCard: 'Credit Card', debitCard: 'Debit Card', applePay: 'Apple Pay', googlePay: 'Google Pay',
  revolutPay: 'Revolut Pay', neteller: 'Neteller', skrill: 'Skrill', sepa: 'SEPA', sepaInstant: 'SEPA Instant', ach: 'ACH', achInstant: 'ACH Instant', Khipu: 'Khipu',
  palomaBanktTansfer: 'Paloma Bank Transfer', ovo: 'OVO', zaloPay: 'Zalo Pay', zaloBankTransfer: 'Zalo Bank Transfer', gcash: 'GCash', imps: 'IMPS', dana: 'DANA',
  ideal: 'iDEAL', paypal: 'PayPal', sepaOpenBankingPayment: 'SEPA Open Banking Payment', gbpOpenBankingPayment: 'GBP Open Banking Payment', lowCostAch: 'Low Cost ACH',
  mobileWallet: 'Mobile Wallet', pixInstantPayment: 'PIX Instant Payment', yellowCardBankTransfer: 'Yellow Card Bank Transfer', fiatBalance: 'Fiat Balance',
  bancontact: 'Bancontact', pixPay: 'PIX Pay', moonpayCashApp: 'Cash App Pay', moonpayBalance: 'MoonPay Balance',
};

export function paymentTypeTitle(p: PaymentType): string | null {
  return TITLES[p] ?? null;
}

/** PaymentType.darkIconPath (the new UI's icons) */
export function paymentTypeIcon(p: PaymentType): string | null {
  switch (p) {
    case 'all': return 'assets/new-ui/buy_payment_methods/all_methods.svg';
    case 'creditCard': case 'debitCard': case 'yellowCardBankTransfer': return 'assets/new-ui/buy_payment_methods/debit_card.svg';
    case 'bankTransfer': return 'assets/new-ui/buy_payment_methods/bank_transfer.svg';
    case 'skrill': return 'assets/images/skrill.svg';
    case 'applePay': return 'assets/new-ui/buy_payment_methods/apple_pay.svg';
    case 'googlePay': return 'assets/new-ui/buy_payment_methods/google_pay.svg';
    case 'paypal': return 'assets/new-ui/buy_payment_methods/paypal.svg';
    case 'revolutPay': return 'assets/images/revolut_dark.svg';
    default: return null;
  }
}

const MONOCHROME = new Set(['assets/new-ui/buy_payment_methods/all_methods.svg', 'assets/new-ui/buy_payment_methods/debit_card.svg', 'assets/new-ui/buy_payment_methods/bank_transfer.svg']);
export const isMonochromeIcon = (path: string) => MONOCHROME.has(path);

/** PaymentMethod.getPaymentTypeId: a provider's method id as a PaymentType */
export function paymentTypeId(raw: string | null | undefined): PaymentType | null {
  switch ((raw ?? '').toLowerCase()) {
    case 'banktransfer': case 'bank': case 'yellow_card_bank_transfer': return 'bankTransfer';
    case 'creditcard': case 'card': case 'credit_debit_card': return 'creditCard';
    case 'debitcard': return 'debitCard';
    case 'applepay': case 'apple_pay': return 'applePay';
    case 'googlepay': case 'google_pay': return 'googlePay';
    case 'revolutpay': return 'revolutPay';
    case 'neteller': return 'neteller';
    case 'skrill': return 'skrill';
    case 'sepabanktransfer': case 'sepa': case 'sepa_bank_transfer': return 'sepa';
    case 'sepainstant': case 'sepa_instant': return 'sepaInstant';
    case 'ach': case 'ach_bank_transfer': return 'ach';
    case 'iach': case 'instant_ach': return 'achInstant';
    case 'khipu': return 'Khipu';
    case 'palomabanktransfer': return 'palomaBanktTansfer';
    case 'ovo': return 'ovo';
    case 'zalopay': return 'zaloPay';
    case 'zalobanktransfer': case 'za_bank_transfer': return 'zaloBankTransfer';
    case 'gcash': return 'gcash';
    case 'imps': return 'imps';
    case 'dana': return 'dana';
    case 'ideal': return 'ideal';
    case 'paypal': return 'paypal';
    case 'sepa_open_banking_payment': return 'sepaOpenBankingPayment';
    case 'bancontact': return 'bancontact';
    case 'pix': return 'pixPay';
    default: return null;
  }
}

/** PaymentMethod */
export interface PaymentMethod {
  type: PaymentType;
  customTitle: string;
  customIconPath: string;
  customDescription?: string;
  customPaymentMethodType?: string;
  badges?: string[];
  bottomLeftSubTitle?: string;
}

export const paymentMethodTitle = (m: PaymentMethod) => paymentTypeTitle(m.type) ?? m.customTitle;
export const paymentMethodIcon = (m: PaymentMethod) => paymentTypeIcon(m.type) ?? m.customIconPath;

export const ALL_PAYMENT_METHODS: PaymentMethod = { type: 'all', customTitle: 'All Payment Methods', customIconPath: 'assets/new-ui/buy_payment_methods/all_methods.svg' };

/** same PaymentType = the same method, unless both are unknown: then by title */
export function samePaymentMethod(a: PaymentMethod, b: PaymentMethod): boolean {
  if (a.type !== b.type) return false;
  return a.type !== 'unknown' || a.customTitle === b.customTitle;
}

export type Recommendation = 'bestRate' | 'lowKyc' | 'successRate';

/** RecommendationTitle: the string keys */
export const RECOMMENDATION_KEYS: Record<Recommendation, string> = { bestRate: 'best_rate', lowKyc: 'low_kyc', successRate: 'highest_success_rate' };

/** getRecommendationFromString */
export function recommendationOf(s: string): Recommendation | null {
  switch (s) {
    case 'BEST RATE': return 'bestRate';
    case 'LowKyc': return 'lowKyc';
    case 'SuccessRate': return 'successRate';
    default: return null;
  }
}

/** Quote */
export interface Quote {
  rate: number;
  feeAmount: number;
  networkFee: number;
  transactionFee: number;
  payout: number;
  provider: BuyProvider;
  paymentType: PaymentType;
  recommendations: Recommendation[];
  isBuyAction: boolean;
  quoteId?: string;
  rampId?: string;
  rampName?: string;
  rampIconPath?: string;
  limits?: { min: number | null; max: number | null };
  customPaymentMethodType?: string;
  fiat: string;
  crypto: SwapCurrency;
}

/** the quote's name: the ramp (aggregators) or the provider */
export const quoteTitle = (q: Quote) => (q.provider.isAggregator ? q.rampName ?? '' : q.provider.title);
export const quoteIcon = (q: Quote) => (q.provider.isAggregator ? q.rampIconPath ?? q.provider.icon : q.provider.icon);
/** Quote.badges (string keys) */
export const quoteBadgeKeys = (q: Quote) => q.recommendations.map((r) => RECOMMENDATION_KEYS[r]);

export interface FetchQuoteArgs {
  crypto: SwapCurrency;
  fiat: string;
  amount: number;
  isBuy: boolean;
  walletAddress: string;
  paymentType?: PaymentType;
  customPaymentMethodType?: string;
}

export interface LaunchArgs {
  quote: Quote;
  amount: number;
  isBuy: boolean;
  cryptoCurrencyAddress: string;
}

/** BuyProvider */
export interface BuyProvider {
  readonly title: string;
  readonly description: string;
  /** the dark-theme icon (the new UI uses dark assets on its dark surfaces; light ones otherwise) */
  readonly icon: string;
  readonly lightIcon: string;
  readonly isAggregator: boolean;
  /** an API key this build does not have */
  readonly needsApiKey?: string;
  /** the pair is listed (pairs_utils: CryptoCurrency.all × FiatCurrency.all minus the provider's exclusions, matched by title and tag) */
  supports(crypto: SwapCurrency, fiat: string, isBuy: boolean): boolean;
  paymentTypes(fiat: string, crypto: SwapCurrency, isBuy: boolean): Promise<PaymentMethod[]>;
  fetchQuote(a: FetchQuoteArgs): Promise<Quote[] | null>;
  /** launchProvider: the provider's page for this quote (opened in a new tab) */
  launchUrl(a: LaunchArgs): Promise<string>;
  /** fetchRecommendedDefaults (Onramper): the fiat its providers use in the user's region */
  recommendedFiat?: string | null;
  /** providers that catch their own launch errors show this alert (DFX, MoonPay, Kryptonim); the others fail the page */
  launchError?(message: string): { title: string; content: string };
}

export class BuyProviderError extends Error {}

/** a key this build does not have (shown as is instead of Cake's generic message) */
export class BuyKeyError extends BuyProviderError {}
