// The buy / sell view model (lib/view_model/buy/buy_sell_view_model.dart): the
// pair (a wallet asset and a fiat), the amount (fiat when buying, crypto when
// selling, the other side derived from the selected quote), the payment
// methods of every provider, every supporting provider's quotes sorted into
// "recommended" (one per provider) and "more options", and the launch.

import { signal, type Signal } from '@preact/signals';
import { t } from '../core/i18n.ts';
import type { WalletBase } from '../core/wallet.ts';
import { settings } from '../app/settings.ts';
import { apiString, fetchPrice, prices } from '../app/prices.ts';
import { isEvm, walletCurrency } from '../coins/types.ts';
import { EVM_TOKEN_TAGS } from '../coins/tokens.gen.ts';
import { builtinOf, fromCurrency, fromToken, type SwapCurrency } from '../exchange/currency.ts';
import { dartDouble, withMaxDecimals } from '../exchange/amounts.ts';
import { buyProviders } from './providers/index.ts';
import { arrangeQuotes } from './quotes.ts';
import { ALL_PAYMENT_METHODS, BuyKeyError, samePaymentMethod, type BuyMode, type BuyProvider, type PaymentMethod, type Quote } from './types.ts';

export type QuoteState = { kind: 'initial' } | { kind: 'loading' } | { kind: 'loaded' } | { kind: 'failed'; error: string };
export type MethodState = 'initial' | 'loading' | 'loaded' | 'failed';

/** _defaultAmountsMap: amounts of roughly equal worth per fiat (the USD ones for the rest) */
const DEFAULT_AMOUNTS: Record<string, string[]> = {
  AMD: ['20000', '40000', '200000', '400000', '1000000'],
  ARS: ['50000', '100000', '500000', '1000000', '2500000'],
  AUD: ['100', '200', '1000', '2000', '5000'],
  BDT: ['5000', '10000', '50000', '100000', '250000'],
  BGN: ['100', '200', '1000', '2000', '5000'],
  BRL: ['250', '500', '2500', '5000', '12500'],
  CAD: ['50', '100', '500', '1000', '2500'],
  CHF: ['50', '100', '500', '1000', '2500'],
  CLP: ['50000', '100000', '500000', '1000000', '2500000'],
  CNY: ['500', '1000', '5000', '10000', '25000'],
  COP: ['200000', '400000', '2000000', '4000000', '10000000'],
  CZK: ['1000', '2000', '10000', '20000', '50000'],
  DKK: ['400', '800', '4000', '8000', '20000'],
  EGP: ['2500', '5000', '25000', '50000', '125000'],
  EUR: ['50', '100', '500', '1000', '2500'],
  GBP: ['50', '100', '500', '1000', '2500'],
  GHS: ['500', '1000', '5000', '10000', '25000'],
  GTQ: ['400', '800', '4000', '8000', '20000'],
  HKD: ['400', '800', '4000', '8000', '20000'],
  HRK: ['400', '800', '4000', '8000', '20000'],
  HUF: ['20000', '40000', '200000', '400000', '1000000'],
  IDR: ['800000', '1600000', '8000000', '16000000', '40000000'],
  ILS: ['200', '400', '2000', '4000', '10000'],
  INR: ['5000', '10000', '50000', '100000', '250000'],
  IRR: ['2000000', '4000000', '20000000', '40000000', '100000000'],
  ISK: ['7000', '14000', '70000', '140000', '350000'],
  JPY: ['10000', '20000', '100000', '200000', '500000'],
  KES: ['5000', '10000', '50000', '100000', '250000'],
  KRW: ['50000', '100000', '500000', '1000000', '2500000'],
  MAD: ['500', '1000', '5000', '10000', '25000'],
  MXN: ['1000', '2000', '10000', '20000', '50000'],
  MYR: ['250', '500', '2500', '5000', '12500'],
  NGN: ['50000', '100000', '500000', '1000000', '2500000'],
  NOK: ['500', '1000', '5000', '10000', '25000'],
  NZD: ['100', '200', '1000', '2000', '5000'],
  PHP: ['3000', '6000', '30000', '60000', '150000'],
  PKR: ['15000', '30000', '150000', '300000', '750000'],
  PLN: ['200', '400', '2000', '4000', '10000'],
  RON: ['250', '500', '2500', '5000', '12500'],
  RUB: ['5000', '10000', '50000', '100000', '250000'],
  SAR: ['200', '400', '2000', '4000', '10000'],
  SEK: ['500', '1000', '5000', '10000', '25000'],
  SGD: ['50', '100', '500', '1000', '2500'],
  THB: ['2000', '4000', '20000', '40000', '100000'],
  TRY: ['1500', '3000', '15000', '30000', '75000'],
  TWD: ['1500', '3000', '15000', '30000', '75000'],
  UAH: ['2000', '4000', '20000', '40000', '100000'],
  USD: ['50', '100', '500', '1000', '2500'],
  VEF: ['2000', '4000', '20000', '40000', '100000'],
  VND: ['1000000', '2000000', '10000000', '20000000', '50000000'],
  ZAR: ['1000', '2000', '10000', '20000', '50000'],
};

/** Cake waits 10 s for each provider; a new Tor circuit alone can take that long */
const PROVIDER_TIMEOUT_MS = 30_000;

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => Promise.race([p, new Promise<T>((ok) => setTimeout(() => ok(fallback), ms))]);

/** double.tryParse */
function tryDouble(s: string): number | null {
  const v = s.trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(v)) return null;
  return Number(v);
}

/** the wallet's assets as swap currencies (wallet.balance.keys) */
export function walletCurrencies(w: WalletBase): SwapCurrency[] {
  const native = fromCurrency(w.currency);
  const list = ((w as any).assetList?.() ?? []) as { symbol: string; name?: string; decimals: number; address?: string; isNative: boolean; icon?: string }[];
  const tag = isEvm(w.type) ? EVM_TOKEN_TAGS[w.type] : w.type === 'solana' ? 'SOL' : w.type === 'tron' ? 'TRX' : null;
  const tokens = tag ? list.filter((a) => !a.isNative && a.address).map((a) => fromToken({ symbol: a.symbol, name: a.name ?? a.symbol, address: a.address!, decimals: a.decimals, icon: a.icon }, tag)) : [];
  return [native, ...tokens];
}

export class BuySellVM {
  readonly wallet: WalletBase;
  readonly mode: BuyMode;
  readonly providerList: BuyProvider[];
  readonly cryptoCurrency: Signal<SwapCurrency>;
  readonly fiatCurrency: Signal<string>;
  readonly fiatAmount = signal('');
  /** _cryptoAmount (canonical) */
  readonly cryptoAmount = signal('');
  readonly cryptoCurrencyAddress = signal('');
  readonly paymentMethods = signal<PaymentMethod[]>([]);
  readonly selectedPaymentMethod = signal<PaymentMethod | null>(null);
  readonly paymentMethodState = signal<MethodState>('initial');
  readonly quoteState = signal<QuoteState>({ kind: 'initial' });
  readonly sortedRecommendedQuotes = signal<Quote[]>([]);
  readonly sortedQuotes = signal<Quote[]>([]);
  readonly selectedQuote = signal<Quote | null>(null);
  bestRateQuote: Quote | null = null;
  #enteredSide: 'fiat' | 'crypto' = 'fiat';
  #rateSeq = 0;
  #methodSeq = 0;

  constructor(w: WalletBase, mode: BuyMode, initialCurrency?: SwapCurrency) {
    this.wallet = w;
    this.mode = mode;
    this.providerList = buyProviders(w, mode);
    this.cryptoCurrency = signal(fromCurrency(w.currency));
    this.fiatCurrency = signal(settings.peek().fiatCurrency);
    void this.#initialize();
    if (initialCurrency) this.changeCryptoCurrency(initialCurrency);
  }

  get isBuy(): boolean {
    return this.mode === 'buy';
  }

  /** amount: the entered fiat when buying (200 by default), the crypto when selling (0.01 BTC or 1) */
  get amount(): number {
    if (this.isBuy) return tryDouble(this.fiatAmount.peek()) ?? 200;
    return tryDouble(this.cryptoAmount.peek()) ?? (builtinOf(this.cryptoCurrency.peek())?.key === 'btc' ? 0.01 : 1);
  }

  get defaultAmounts(): string[] {
    return DEFAULT_AMOUNTS[this.fiatCurrency.value] ?? ['50', '100', '500', '1000', '2500'];
  }

  /** activeWalletCurrencies / hasMultipleCurrencies */
  get activeWalletCurrencies(): SwapCurrency[] {
    return walletCurrencies(this.wallet);
  }

  get hasMultipleCurrencies(): boolean {
    return this.activeWalletCurrencies.length > 1;
  }

  get isReadyToTrade(): boolean {
    return !!this.selectedQuote.value && !!this.selectedPaymentMethod.value && this.paymentMethodState.value === 'loaded' && this.quoteState.value.kind === 'loaded';
  }

  get isQuoteFailed(): boolean {
    return this.quoteState.value.kind === 'failed';
  }

  /** recommendedFiat: Onramper's, for the user's region */
  get recommendedFiat(): string | null {
    return this.providerList.find((p) => p.title === 'Onramper')?.recommendedFiat ?? null;
  }

  /** maxFiatAmount: the highest maximum over every quote ("Up to ~…") */
  get maxFiatAmount(): string | null {
    const all = [...this.sortedRecommendedQuotes.value, ...this.sortedQuotes.value];
    if (!all.length || this.quoteState.value.kind !== 'loaded') return null;
    return all.reduce((m, q) => Math.max(m, q.limits?.max ?? 0), 0).toFixed(2);
  }

  #priceKey(c: SwapCurrency): string {
    return c.address ? apiString(walletCurrency(c.tag === 'SOL' ? 'solana' : c.tag === 'TRX' ? 'tron' : 'ethereum'), c.address) : `crypto.${c.title}`;
  }

  /** fiatConversionStore.prices[cryptoCurrency]: in the app's fiat currency */
  #price(): number | null {
    const p = prices.value[this.#priceKey(this.cryptoCurrency.peek())];
    return p && p > 0 ? p : null;
  }

  async #fetchPrice(): Promise<void> {
    const k = this.#priceKey(this.cryptoCurrency.peek());
    if (prices.peek()[k] !== undefined) return;
    const p = await fetchPrice(k).catch(() => 0);
    if (p > 0) prices.value = { ...prices.peek(), [k]: p };
  }

  /** amountForQuote: the crypto of a quote (canonical, at most the coin's decimals), or null */
  amountForQuote(q: Quote): string | null {
    let amount: number | null;
    if (!this.isBuy) amount = tryDouble(this.cryptoAmount.value);
    else {
      const fiat = tryDouble(this.fiatAmount.value);
      amount = fiat === null || q.rate <= 0 ? null : fiat / q.rate;
    }
    if (amount === null || !Number.isFinite(amount)) return null;
    return trimFixed(amount.toFixed(Math.min(20, this.cryptoCurrency.value.decimals)));
  }

  /** fiatAmountForQuote: selling — crypto × rate; buying — the quote's crypto at the app's price */
  fiatAmountForQuote(q: Quote): string | null {
    let amount: number | null;
    if (!this.isBuy) {
      const c = tryDouble(this.cryptoAmount.value);
      amount = c === null ? null : c * q.rate;
    } else {
      const price = this.#price();
      const c = tryDouble(this.amountForQuote(q) ?? '');
      amount = price === null || c === null ? null : price * c;
    }
    if (amount === null || !Number.isFinite(amount)) return null;
    return amount.toFixed(2);
  }

  // --------------------------------------------------------------- setup --

  /** _initialize: the amounts cleared (or the other side only), the address, payment methods, then quotes */
  async #initialize(keepEnteredAmount = false): Promise<void> {
    if (!keepEnteredAmount) {
      this.cryptoAmount.value = '';
      this.fiatAmount.value = '';
    } else if (this.#enteredSide === 'fiat') this.cryptoAmount.value = '';
    else this.fiatAmount.value = '';
    this.cryptoCurrencyAddress.value = this.wallet.addressForBuy();
    this.paymentMethodState.value = 'initial';
    this.quoteState.value = { kind: 'initial' };
    this.sortedRecommendedQuotes.value = [];
    this.sortedQuotes.value = [];
    this.paymentMethods.value = [];
    void this.#fetchPrice();
    await this.#getAvailablePaymentTypes();
    await this.calculateBestRate();
  }

  changeFiatCurrency(fiat: string): void {
    this.fiatCurrency.value = fiat;
    void this.#initialize();
  }

  async retryWithRecommendedFiat(): Promise<void> {
    const f = this.recommendedFiat;
    if (!f) return;
    this.fiatCurrency.value = f;
    await this.#initialize(true);
  }

  changeCryptoCurrency(c: SwapCurrency): void {
    this.cryptoCurrency.value = c;
    void this.#initialize();
  }

  /** _getAvailablePaymentTypes: every provider's methods, one per type (unknown ones by title), "All" first */
  async #getAvailablePaymentTypes(): Promise<void> {
    const seq = ++this.#methodSeq;
    this.paymentMethodState.value = 'loading';
    this.selectedPaymentMethod.value = null;
    const fiat = this.fiatCurrency.peek();
    const crypto = this.cryptoCurrency.peek();
    try {
      const results = await Promise.all(this.providerList.map((p) => withTimeout(p.paymentTypes(fiat, crypto, this.isBuy).catch(() => [] as PaymentMethod[]), PROVIDER_TIMEOUT_MS, [] as PaymentMethod[])));
      if (seq !== this.#methodSeq) return;
      const list: PaymentMethod[] = [];
      for (const methods of results) for (const m of methods) if (!list.some((x) => samePaymentMethod(x, m))) list.push(m);
      if (list.length) {
        list.unshift({ ...ALL_PAYMENT_METHODS });
        this.paymentMethods.value = list;
        this.selectedPaymentMethod.value = list[0];
        this.paymentMethodState.value = 'loaded';
      } else {
        this.paymentMethods.value = [];
        this.paymentMethodState.value = 'failed';
      }
    } catch {
      if (seq === this.#methodSeq) this.paymentMethodState.value = 'failed';
    }
  }

  // -------------------------------------------------------------- amounts --

  async changeFiatAmount(amount: string): Promise<void> {
    this.#enteredSide = 'fiat';
    this.fiatAmount.value = amount.replace(/,/g, '.');
    if (!amount) {
      this.fiatAmount.value = '';
      this.cryptoAmount.value = '';
      return;
    }
    if (!this.isReadyToTrade && !this.isQuoteFailed) {
      this.cryptoAmount.value = '...';
      return;
    } else if (this.isQuoteFailed) {
      this.cryptoAmount.value = '';
      return;
    }
    if (!this.#quoteForAmounts()) {
      await this.calculateBestRate();
      return;
    }
    this.#recalculateDerivedAmount();
  }

  async changeCryptoAmount(amount: string): Promise<void> {
    this.#enteredSide = 'crypto';
    this.cryptoAmount.value = amount.replace(/,/g, '.');
    if (!amount) {
      this.fiatAmount.value = '';
      this.cryptoAmount.value = '';
      return;
    }
    if (!this.isReadyToTrade && !this.isQuoteFailed) {
      this.fiatAmount.value = t('fetching');
      return;
    } else if (this.isQuoteFailed) {
      this.fiatAmount.value = '';
      return;
    }
    if (!this.#quoteForAmounts()) {
      await this.calculateBestRate();
      return;
    }
    this.#recalculateDerivedAmount();
  }

  /** setCryptoAmountFromFiat: a fiat amount as crypto at the app's price (selling) */
  async setCryptoAmountFromFiat(amount: string): Promise<void> {
    const entered = tryDouble(amount.replace(/,/g, '.'));
    // Cake's prices are there from the start; here the first one may still be on its way over Tor
    if (entered !== null && this.#price() === null) await this.#fetchPrice();
    const price = this.#price();
    if (entered === null || price === null) {
      await this.changeCryptoAmount('');
      return;
    }
    await this.changeCryptoAmount(dartDouble(entered / price));
  }

  /** changeOption */
  changeQuote(q: Quote): void {
    this.selectedQuote.value = q;
    this.#recalculateDerivedAmount();
  }

  changePaymentMethod(m: PaymentMethod): void {
    this.selectedPaymentMethod.value = m;
  }

  #quoteForAmounts(): Quote | null {
    return this.selectedQuote.peek() ?? this.bestRateQuote;
  }

  /** _recalculateDerivedAmount: the side that was not entered, from the quote's rate */
  #recalculateDerivedAmount(): void {
    const rate = this.#quoteForAmounts()?.rate;
    if (rate === undefined || rate <= 0) return;
    const fiat = tryDouble(this.fiatAmount.peek());
    const crypto = tryDouble(this.cryptoAmount.peek());
    const decimals = this.cryptoCurrency.peek().decimals;
    if (this.#enteredSide === 'fiat' && fiat !== null) this.cryptoAmount.value = withMaxDecimals(dartDouble(fiat / rate), decimals);
    else if (crypto !== null) this.fiatAmount.value = withMaxDecimals(dartDouble(crypto * rate), 2);
    else if (fiat !== null) this.cryptoAmount.value = withMaxDecimals(dartDouble(fiat / rate), decimals);
  }

  // --------------------------------------------------------------- quotes --

  /**
   * calculateBestRate: quotes from every provider that lists the pair; by payout (most crypto when buying, the
   * least crypto per fiat when selling), the best of each provider recommended (and Onramper's "success rate" ones),
   * Onramper's first, the cheapest rate badged "Best Rate", the first one selected.
   */
  async calculateBestRate(): Promise<void> {
    const seq = ++this.#rateSeq;
    this.quoteState.value = { kind: 'loading' };
    const crypto = this.cryptoCurrency.peek();
    const fiat = this.fiatCurrency.peek();
    const noProviders = t('no_buy_providers', { curr: crypto.fullName ?? crypto.title });
    const valid = this.providerList.filter((p) => p.supports(crypto, fiat, this.isBuy));
    if (!valid.length) {
      this.quoteState.value = { kind: 'failed', error: noProviders };
      return;
    }
    const method = this.selectedPaymentMethod.peek();
    const results = await Promise.all(valid.map((p) => withTimeout(p.fetchQuote({ crypto, fiat, amount: this.amount, isBuy: this.isBuy, walletAddress: this.wallet.receiveAddress.peek(), paymentType: method?.type, customPaymentMethodType: method?.customPaymentMethodType }).catch(() => null), PROVIDER_TIMEOUT_MS, null)));
    if (seq !== this.#rateSeq) return;
    const quotes = results.flatMap((r) => r ?? []);
    if (!quotes.length) {
      this.sortedRecommendedQuotes.value = [];
      this.sortedQuotes.value = [];
      this.quoteState.value = { kind: 'failed', error: noProviders };
      return;
    }
    const { recommended, others, best, selected } = arrangeQuotes(quotes, this.isBuy);
    this.bestRateQuote = best;
    this.sortedRecommendedQuotes.value = recommended;
    this.sortedQuotes.value = others;
    this.selectedQuote.value = selected;
    this.#recalculateDerivedAmount();
    this.quoteState.value = { kind: 'loaded' };
  }

  // --------------------------------------------------------------- launch --

  /**
   * launchTrade: the provider's page for the selected quote. Providers that catch their own errors answer with an
   * alert; for the others the page fails ("Using Tor is not supported" for a 403).
   */
  async launchTrade(): Promise<{ url?: string; alert?: { title: string; content: string } }> {
    const q = this.selectedQuote.peek();
    if (!q) return {};
    try {
      return { url: await q.provider.launchUrl({ quote: q, amount: this.amount, isBuy: this.isBuy, cryptoCurrencyAddress: this.cryptoCurrencyAddress.peek() }) };
    } catch (e) {
      const message = (e as Error).message ?? String(e);
      if (q.provider.launchError) return { alert: q.provider.launchError(message) };
      const error = message.includes('403') ? 'Using Tor is not supported' : e instanceof BuyKeyError ? message : 'Something went wrong please try again later';
      this.quoteState.value = { kind: 'failed', error };
      return {};
    }
  }
}

/** Money.toString of a fixed-point string: trailing fraction zeros dropped */
function trimFixed(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}
