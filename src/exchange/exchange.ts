// The swap view model (lib/view_model/exchange/exchange_view_model.dart): the
// pair, the amounts (one computed from the other at the best rate), the
// limits over the selected providers, the best rate (refreshed every 10 s),
// the provider selection, and trade creation (the best provider first, then
// the next ones).

import { batch, computed, signal, type Signal } from '@preact/signals';
import { formatFixed } from '../core/amount.ts';
import { doubleToMoney, toMoney, withMaxDecimals } from './amounts.ts';
import { isSynced, type WalletBase } from '../core/wallet.ts';
import { isEvm, isElectrum, walletCurrency, type WalletType } from '../coins/types.ts';
import { settings, updateSettings } from '../app/settings.ts';
import { apiString, fetchPrice, prices } from '../app/prices.ts';
import { walletCache, walletInfos } from '../app/app.ts';
import { t } from '../core/i18n.ts';
import type { WalletToken } from '../coins/tokens.ts';
import { builtin, builtinOf, eqCurrency, fromCurrency, memoLabelType, swapCurrencies, type SwapCurrency, type UserTokens } from './currency.ts';
import { ALL_PROVIDERS, trocador } from './providers/index.ts';
import { trocadorPartners } from './providers/trocador.ts';
import { monitorActiveTrades, saveTrade } from './trades.ts';
import { STATES, type ExchangeProvider, type Limits, type Trade, type TradeRequest } from './types.ts';
import { walletAssetFor } from './send.ts';

export type LimitsState = { kind: 'initial' } | { kind: 'loading' } | { kind: 'success'; limits: Limits } | { kind: 'failure'; error: string };
export type TradeCreation = { kind: 'initial' } | { kind: 'creating' } | { kind: 'created'; trade: Trade } | { kind: 'failed'; title: string; error: string };

/** the 10 s best-rate refresh */
const RATE_REFRESH_MS = 10_000;

/** initialAmountByAssets: the amount quoted before one is entered */
function initialAmount(c: SwapCurrency): number {
  switch (builtinOf(c)?.key) {
    case 'trx': case 'wow': case 'ada': return 1000;
    case 'nano': case 'zano': case 'dash': case 'rune': return 10;
    default: return 1;
  }
}

/** toStringAsPrecision, as roundedDepositAmount/roundedReceiveAmount use it */
function rounded(s: string, digits: number): string {
  if ((s.split('.').pop() ?? '').length <= digits) return s;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n.toPrecision(digits) : '0';
}

/** _initialPairBasedOnWallet */
function initialPair(w: WalletBase): [SwapCurrency, SwapCurrency] {
  const own = fromCurrency(w.currency);
  if (isEvm(w.type)) return [own, builtin('xmr')];
  switch (w.type) {
    case 'monero': return [builtin('xmr'), builtin('btc')];
    case 'haven': return [builtin('xhv'), builtin('btc')];
    default: return [own, builtin('xmr')];
  }
}

/** the enabled tokens of every EVM/Solana/Tron wallet (TokenUtilities.loadAllUnique*Tokens) */
async function userTokens(): Promise<UserTokens> {
  const out: UserTokens = { evm: [], sol: [], trx: [] };
  for (const w of walletInfos.value) {
    try {
      if (isEvm(w.type)) out.evm.push({ type: w.type, tokens: (await walletCache.get<WalletToken[]>(w.id, 'evm:tokens')) ?? [] });
      else if (w.type === 'solana') out.sol.push((await walletCache.get<WalletToken[]>(w.id, 'sol:tokens')) ?? []);
      else if (w.type === 'tron') out.trx.push((await walletCache.get<WalletToken[]>(w.id, 'trx:tokens')) ?? []);
    } catch { /* skip */ }
  }
  return out;
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> => Promise.race([p, new Promise<T>((ok) => setTimeout(() => ok(fallback), ms))]);

/** quotes and limits wait this long (Cake: 7 s on clearnet; Tor circuits need more) */
const PROVIDER_TIMEOUT_MS = 25_000;

export class ExchangeVM {
  wallet: WalletBase;
  readonly currencies = signal<SwapCurrency[]>(swapCurrencies());
  readonly depositCurrency: Signal<SwapCurrency>;
  readonly receiveCurrency: Signal<SwapCurrency>;
  /** _depositAmount / _receiveAmount (canonical), null when empty or invalid */
  readonly depositMoney = signal<string | null>(null);
  readonly receiveMoney = signal<string | null>(null);
  /** the refund address */
  readonly depositAddress = signal('');
  readonly receiveAddress = signal('');
  readonly receiveAddressExtraId = signal('');
  readonly receiveAddressDisplayName = signal<string | null>(null);
  /** the receive address came from this wallet (the picker), for the BTC segwit / ZEC transparent fix-ups */
  selectedAddressBookWallet: { id: string; type: WalletType } | null = null;
  readonly isFixedRateMode = signal(false);
  readonly isSendAllEnabled = signal(false);
  readonly isSendFromExternal = signal(false);
  readonly limits = signal<Limits>({ min: 0, max: 0 });
  readonly limitsState = signal<LimitsState>({ kind: 'initial' });
  readonly bestRate = signal(0);
  readonly bestRateProvider = signal<ExchangeProvider | null>(null);
  /** bestRateProvider, 300 ms later (no flicker) */
  readonly providerDisplay = signal<ExchangeProvider | null>(null);
  readonly forcedProvider = signal<ExchangeProvider | null>(null);
  readonly forcedProviderRate = signal(0);
  readonly tradeState = signal<TradeCreation>({ kind: 'initial' });
  readonly noProviderForPair = signal(false);
  readonly depositAvailableAmount = signal('');
  /** selectedProviders (an editable copy of the stored selection) */
  readonly selectedProviders: Signal<ExchangeProvider[]>;
  /** _sortedAvailableProviders: rate → provider, best first (equal rates: the later provider wins) */
  #sorted: [number, ExchangeProvider][] = [];
  #providerLimits = new Map<ExchangeProvider, Limits | null>();
  #timer: ReturnType<typeof setInterval>;
  #displayTimer: ReturnType<typeof setTimeout> | undefined;
  #disposers: (() => void)[] = [];
  #rateSeq = 0;
  #limitsSeq = 0;
  #rateRunning = false;
  #disposed = false;

  constructor(w: WalletBase) {
    this.wallet = w;
    const [d, r] = initialPair(w);
    this.depositCurrency = signal(d);
    this.receiveCurrency = signal(r);
    const stored = settings.value.exchangeProvidersSelection ?? {};
    const decentralizedOnly = !!settings.value.decentralizedOnly;
    this.selectedProviders = signal(this.providerList().filter((p) => (!decentralizedOnly || !p.description.isCentralized) && (stored[p.title] === undefined ? p.isEnabled : !!stored[p.title])));
    void userTokens().then((u) => !this.#disposed && (this.currencies.value = swapCurrencies(u)));
    void this.#initDepositAddress();
    this.#watch(() => {
      const p = this.bestRateProvider.value;
      clearTimeout(this.#displayTimer);
      this.#displayTimer = setTimeout(() => (this.providerDisplay.value = p), 300);
    });
    // receiveAddressDisplayName is reset whenever the receive address changes
    let lastReceive = this.receiveAddress.peek();
    this.#watch(() => {
      const a = this.receiveAddress.value;
      if (a !== lastReceive && this.tradeState.peek().kind !== 'created') this.receiveAddressDisplayName.value = null;
      lastReceive = a;
    });
    if (this.selectedProviders.peek().includes(trocador)) void this.#updateTrocadorPartners();
    this.#timer = setInterval(() => {
      if (this.tradeState.peek().kind !== 'creating') void this.calculateBestRate();
    }, RATE_REFRESH_MS);
    void this.loadLimits();
    void this.fetchFiatPrice(d);
    void this.fetchFiatPrice(r);
    void this.updateDepositAvailableAmount();
  }

  #watch(fn: () => void): void {
    const c = computed(fn);
    this.#disposers.push(c.subscribe(() => {}));
  }

  /** the wallet switcher picked another wallet to send from */
  setWallet(w: WalletBase): void {
    this.wallet = w;
    void this.updateDepositAvailableAmount();
  }

  dispose(): void {
    this.#disposed = true;
    clearInterval(this.#timer);
    clearTimeout(this.#displayTimer);
    for (const d of this.#disposers) d();
  }

  // ------------------------------------------------------------ getters --

  /** the amount texts (asDisplayString: canonical here) */
  get depositAmount(): string {
    return this.depositMoney.value ?? '';
  }
  get receiveAmount(): string {
    return this.receiveMoney.value ?? '';
  }

  /** providerList: "Tor only" → the providers with an onion service */
  providerList(): ExchangeProvider[] {
    return settings.value.exchangeStatus === 'torOnly' ? ALL_PROVIDERS.filter((p) => p.supportsOnionAddress) : ALL_PROVIDERS;
  }

  /** _tradeAvailableProviders */
  tradeAvailableProviders(): ExchangeProvider[] {
    const list = this.providerList();
    return this.selectedProviders.value.filter((p) => list.includes(p));
  }

  get isAvailableInSelected(): boolean {
    const list = this.providerList();
    return this.selectedProviders.value.some((p) => p.isAvailable && list.includes(p));
  }

  get forceDecentralized(): boolean {
    return !!settings.value.decentralizedOnly;
  }

  /** useSameWalletAddress */
  useSameWalletAddress(c: SwapCurrency): boolean {
    const wc = this.wallet.currency;
    return (builtinOf(c)?.key === wc.key) || (builtinOf(c)?.key === 'btcln' && wc.key === 'btc') || (c.tag !== null && c.tag === wc.tag) || c.tag === wc.title;
  }

  /** hasAllAmount */
  get hasAllAmount(): boolean {
    const w = this.wallet;
    const d = this.depositCurrency.value;
    if (['monero', 'bitcoin', 'litecoin', 'bitcoinCash', 'dogecoin'].includes(w.type)) return builtinOf(d)?.key === w.currency.key;
    if (!isEvm(w.type)) return false;
    if (builtinOf(d)?.key === w.currency.key) return true;
    return walletAssetFor(w, d) !== undefined;
  }

  /** balanceDisplay: the deposit asset's available balance in this wallet */
  get balanceDisplay(): string | null {
    const w = this.wallet;
    const d = this.depositCurrency.value;
    const key = isEvm(w.type) || w.type === 'solana' || w.type === 'tron' ? walletAssetFor(w, d) : builtinOf(d)?.key === w.currency.key ? w.currency.key : undefined;
    if (!key) return null;
    const bal = w.balances.value[key]?.available;
    if (bal === undefined) return null;
    return formatFixed(bal, this.#decimalsOf(key));
  }

  #decimalsOf(key: string): number {
    if (key === this.wallet.currency.key) return this.wallet.currency.decimals;
    const a = ((this.wallet as any).assetList?.() ?? []).find((x: any) => x.key === key);
    return a?.decimals ?? this.wallet.currency.decimals;
  }

  roundedDepositAmount(digits: number): string {
    return rounded(this.depositAmount, digits);
  }
  roundedReceiveAmount(digits: number): string {
    return rounded(this.receiveAmount, digits);
  }

  #fiat(amount: string | null, c: SwapCurrency): string {
    if (amount === null) return '';
    const p = prices.value[this.#priceKey(c)];
    if (!p) return '';
    const v = Number.parseFloat(amount) * p;
    return Number.isFinite(v) ? v.toFixed(2) : '';
  }
  get depositAmountFiat(): string {
    return this.#fiat(this.depositMoney.value, this.depositCurrency.value);
  }
  get receiveAmountFiat(): string {
    return this.#fiat(this.receiveMoney.value, this.receiveCurrency.value);
  }
  roundedDepositAmountFiat(digits: number): string {
    const s = this.depositAmountFiat;
    return (s.split('.').pop() ?? '').length <= digits ? s : (Number.parseFloat(s) || 0).toPrecision(digits);
  }
  roundedReceiveAmountFiat(digits: number): string {
    const s = this.receiveAmountFiat;
    return (s.split('.').pop() ?? '').length <= digits ? s : (Number.parseFloat(s) || 0).toPrecision(digits);
  }

  #priceKey(c: SwapCurrency): string {
    return c.address ? apiString(walletCurrency(c.tag === 'SOL' ? 'solana' : c.tag === 'TRX' ? 'tron' : 'ethereum'), c.address) : `crypto.${c.title}`;
  }

  priceOf(c: SwapCurrency): number {
    return prices.value[this.#priceKey(c)] ?? 0;
  }

  /** fetchFiatPrice: once per currency */
  async fetchFiatPrice(c: SwapCurrency): Promise<void> {
    const k = this.#priceKey(c);
    if (prices.peek()[k] !== undefined) return;
    const p = await fetchPrice(k);
    if (p > 0) prices.value = { ...prices.peek(), [k]: p };
  }

  // --------------------------------------------------------- addresses --

  async #initDepositAddress(): Promise<void> {
    const d = this.depositCurrency.peek();
    if (this.useSameWalletAddress(d)) this.depositAddress.value = await this.wallet.addressForExchange().catch(() => this.wallet.receiveAddress.value);
  }

  /** _onCurrencyChange (deposit side): sending from this wallet when it holds the currency, else from outside */
  async onDepositCurrencyChanged(): Promise<void> {
    const d = this.depositCurrency.peek();
    const same = this.useSameWalletAddress(d);
    this.isSendFromExternal.value = !same;
    this.depositAddress.value = same ? await this.wallet.addressForExchange().catch(() => this.wallet.receiveAddress.value) : '';
  }

  /** updateDepositAvailableAmount */
  async updateDepositAvailableAmount(): Promise<void> {
    const d = this.depositCurrency.peek();
    const w = this.wallet;
    if (isEvm(w.type)) {
      const key = walletAssetFor(w, d);
      const bal = key ? w.balances.peek()[key]?.available : undefined;
      if (key && bal !== undefined && eqCurrency(this.depositCurrency.peek(), d)) this.depositAvailableAmount.value = `${formatFixed(bal, this.#decimalsOf(key))} ${d.title}`;
      return;
    }
    const bal = w.balances.peek()[w.currency.key]?.available ?? 0n;
    if (eqCurrency(this.depositCurrency.peek(), d)) this.depositAvailableAmount.value = `${formatFixed(bal, w.currency.decimals)} ${d.title}`;
  }

  // ------------------------------------------------------------ amounts --

  #setFixed(v: boolean): void {
    if (this.isFixedRateMode.peek() === v) return;
    this.isFixedRateMode.value = v;
    // the isFixedRateMode reaction
    this.bestRateProvider.value = null;
    this.bestRate.value = 0;
    void this.loadLimits();
  }

  enableFixedRateMode(): void {
    batch(() => {
      this.isSendAllEnabled.value = false;
      this.#setFixed(true);
    });
  }

  disableFixedRateMode(): void {
    this.#setFixed(false);
  }

  enableSendAllAmount(): void {
    this.isSendAllEnabled.value = true;
    this.#setFixed(false);
    void this.calculateDepositAllAmount();
  }

  #rate(): number {
    return this.forcedProvider.peek() ? this.forcedProviderRate.peek() : this.bestRate.peek();
  }

  /** changeDepositAmount: the receive amount follows at the current rate (not in fixed mode) */
  async changeDepositAmount(amount: string): Promise<void> {
    if (!amount) {
      this.depositMoney.value = null;
      this.receiveMoney.value = null;
      return;
    }
    const dep = toMoney(amount, this.depositCurrency.peek());
    this.depositMoney.value = dep;
    if (dep === null) {
      this.receiveMoney.value = null;
      return;
    }
    if (this.isFixedRateMode.peek()) return;
    const entered = Number.parseFloat(dep) || 0;
    if (this.bestRate.peek() === 0) {
      this.receiveMoney.value = null;
      await this.calculateBestRate();
    }
    this.receiveMoney.value = doubleToMoney(entered * this.#rate(), this.receiveCurrency.peek());
  }

  /** changeReceiveAmount: the deposit amount follows (receive ÷ rate) */
  async changeReceiveAmount(amount: string): Promise<void> {
    if (!amount) {
      this.depositMoney.value = null;
      this.receiveMoney.value = null;
      return;
    }
    const rec = toMoney(amount, this.receiveCurrency.peek());
    this.receiveMoney.value = rec;
    if (rec === null) {
      this.depositMoney.value = null;
      return;
    }
    const entered = Number.parseFloat(rec) || 0;
    if (this.bestRate.peek() === 0) {
      this.depositMoney.value = null;
      await this.calculateBestRate();
    }
    this.depositMoney.value = doubleToMoney(entered / this.#rate(), this.depositCurrency.peek());
  }

  /** setDepositAmountFromFiat / setReceiveAmountFromFiat */
  setDepositAmountFromFiat(fiat: string): void {
    const p = this.priceOf(this.depositCurrency.peek());
    if (!p) return;
    const crypto = (Number.parseFloat(fiat.replace(',', '.')) || 0) / p;
    const s = withMaxDecimals(String(crypto), this.depositCurrency.peek().decimals);
    if (this.depositMoney.peek() !== s) void this.changeDepositAmount(s);
  }

  setReceiveAmountFromFiat(fiat: string): void {
    const p = this.priceOf(this.receiveCurrency.peek());
    if (!p) return;
    const crypto = (Number.parseFloat(fiat.replace(',', '.')) || 0) / p;
    const s = withMaxDecimals(String(crypto), this.receiveCurrency.peek().decimals);
    if (this.receiveMoney.peek() !== s) void this.changeReceiveAmount(s);
  }

  /** calculateDepositAllAmount: what "Max." sends */
  async calculateDepositAllAmount(): Promise<void> {
    const w = this.wallet;
    const d = this.depositCurrency.peek();
    try {
      if (isElectrum(w.type)) {
        const own = await w.addressForExchange().catch(() => w.receiveAddress.value);
        const p = await w.createTransaction({ outputs: [{ address: own, amount: 0n, sendAll: true }], priority: settings.peek().priority[w.type] ?? w.defaultPriority(), coinType: w.type === 'litecoin' ? 'nonMweb' : undefined });
        await this.changeDepositAmount(formatFixed(p.amount, w.currency.decimals));
      } else if (w.type === 'monero') {
        await this.changeDepositAmount(formatFixed(w.balances.peek().xmr?.available ?? 0n, 12));
      } else if (isEvm(w.type)) {
        const key = walletAssetFor(w, d);
        const bal = key ? w.balances.peek()[key]?.available : undefined;
        if (!key || bal === undefined || bal <= 0n) {
          await this.changeDepositAmount(formatFixed(0n, w.currency.decimals));
          return;
        }
        if (key !== w.currency.key) {
          await this.changeDepositAmount(formatFixed(bal, this.#decimalsOf(key)));
          return;
        }
        try {
          const fee = await w.estimateFee(settings.peek().priority[w.type] ?? w.defaultPriority(), bal);
          await this.changeDepositAmount(formatFixed(bal > fee ? bal - fee : 0n, w.currency.decimals));
        } catch {
          await this.changeDepositAmount(formatFixed(bal, w.currency.decimals));
        }
      }
    } catch {
      // a balance too small to send: the amount stays as it was
    }
  }

  // ------------------------------------------------------------ the pair --

  changeDepositCurrency(c: SwapCurrency): void {
    const prev = this.depositCurrency.peek();
    const wasSendAll = this.isSendAllEnabled.peek();
    this.depositCurrency.value = c;
    this.#setFixed(false);
    if (!eqCurrency(prev, c)) this.#onPairChange(wasSendAll);
    void this.fetchFiatPrice(c);
    void this.updateDepositAvailableAmount();
  }

  changeReceiveCurrency(c: SwapCurrency): void {
    const prev = this.receiveCurrency.peek();
    if (!(c.tag === prev.tag || c.tag === prev.title || c.title === prev.tag || eqCurrency(c, prev))) this.receiveAddress.value = '';
    if (!eqCurrency(c, prev)) this.receiveAddressExtraId.value = '';
    this.receiveCurrency.value = c;
    this.#setFixed(false);
    if (!eqCurrency(prev, c)) this.#onPairChange(false);
    void this.fetchFiatPrice(c);
  }

  /** reverseSwapDirection: the old receive amount becomes the deposit amount */
  reverseSwapDirection(): void {
    const amount = this.receiveMoney.peek();
    const dep = this.depositCurrency.peek();
    this.changeDepositCurrency(this.receiveCurrency.peek());
    this.changeReceiveCurrency(dep);
    this.depositMoney.value = amount;
  }

  /** _onPairChange */
  #onPairChange(clearBoth: boolean): void {
    if (clearBoth) {
      this.depositMoney.value = null;
      this.receiveMoney.value = null;
      if (!this.hasAllAmount) this.isSendAllEnabled.value = false;
    } else if (this.isFixedRateMode.peek()) this.depositMoney.value = null;
    else this.receiveMoney.value = null;
    this.bestRate.value = 0;
    this.bestRateProvider.value = null;
    this.#sorted = [];
    void this.loadLimits().then(() => {
      if (clearBoth && this.hasAllAmount) void this.calculateDepositAllAmount();
    });
  }

  // ---------------------------------------------------- limits and rates --

  #excludeForSendAll(p: ExchangeProvider): boolean {
    return this.isSendAllEnabled.peek() && (p.title === 'Swaps.XYZ' || p.title === 'Near Intents');
  }

  #excludeForMemo(p: ExchangeProvider): boolean {
    return memoLabelType(this.receiveCurrency.peek()) !== null && !p.supportsMemoOrDestinationTag;
  }

  /** loadLimits: every selected provider's limits; the lowest minimum and the highest maximum */
  async loadLimits(): Promise<void> {
    const dep = this.depositCurrency.peek();
    const rec = this.receiveCurrency.peek();
    if (eqCurrency(dep, rec)) {
      this.limitsState.value = { kind: 'success', limits: { min: 0, max: 0 } };
      return;
    }
    if (!this.selectedProviders.peek().length) return;
    const seq = ++this.#limitsSeq;
    this.limitsState.value = { kind: 'loading' };
    const fixed = this.isFixedRateMode.peek();
    const from = fixed ? rec : dep;
    const to = fixed ? dep : rec;
    const list = this.providerList();
    const providers = this.selectedProviders.peek().filter((p) => list.includes(p) && !this.#excludeForMemo(p));
    const entries = await Promise.all(providers.map(async (p) => [p, await withTimeout(p.fetchLimits(from, to, fixed).catch(() => null), PROVIDER_TIMEOUT_MS, null)] as const));
    if (seq !== this.#limitsSeq || this.#disposed) return;
    this.#providerLimits = new Map(entries);
    let lowestMin: number | null = Number.MAX_VALUE;
    let highestMax: number | null = 0;
    for (const l of this.#providerLimits.values()) {
      if (!l) continue;
      if (lowestMin !== null && (l.min ?? -1) < lowestMin) lowestMin = l.min;
      if (highestMax !== null && (l.max ?? Number.MAX_VALUE) > highestMax) highestMax = l.max;
    }
    if (lowestMin !== Number.MAX_VALUE) {
      this.limits.value = { min: lowestMin, max: highestMax };
      this.limitsState.value = { kind: 'success', limits: this.limits.value };
    } else {
      this.limitsState.value = { kind: 'failure', error: 'Limits loading failed' };
    }
    void this.calculateBestRate();
  }

  /** calculateBestRate: every eligible provider's rate for the amount; the best wins */
  async calculateBestRate(): Promise<void> {
    const dep = this.depositCurrency.peek();
    const rec = this.receiveCurrency.peek();
    if (eqCurrency(dep, rec)) {
      this.bestRate.value = 0;
      this.bestRateProvider.value = null;
      return;
    }
    if (this.#rateRunning) {
      // one quote round at a time over Tor; the next timer tick picks up any change
      await new Promise<void>((ok) => {
        const id = setInterval(() => {
          if (!this.#rateRunning) {
            clearInterval(id);
            ok();
          }
        }, 100);
      });
    }
    this.#rateRunning = true;
    const seq = ++this.#rateSeq;
    try {
      const fixed = this.isFixedRateMode.peek();
      const entered = Number.parseFloat((fixed ? this.receiveMoney.peek() : this.depositMoney.peek()) ?? '');
      const amount = Number.isFinite(entered) ? entered : initialAmount(fixed ? rec : dep);
      const candidates = this.tradeAvailableProviders()
        .filter((p) => {
          if (this.#excludeForSendAll(p) || this.#excludeForMemo(p)) return false;
          const l = this.#providerLimits.get(p);
          if (!l) return false;
          if (l.min !== null && amount < l.min) return false;
          if (l.max !== null && amount > l.max) return false;
          return true;
        })
        .filter((p) => !fixed || p.supportsFixedRate);
      const rates = await Promise.all(candidates.map((p) => withTimeout(p.fetchRate(dep, rec, amount, fixed, fixed).catch(() => 0), PROVIDER_TIMEOUT_MS, 0)));
      if (seq !== this.#rateSeq || this.#disposed || !eqCurrency(dep, this.depositCurrency.peek()) || !eqCurrency(rec, this.receiveCurrency.peek())) return;
      const map = new Map<number, ExchangeProvider>();
      rates.forEach((r, i) => {
        if (r !== 0 && Number.isFinite(r)) map.set(r, candidates[i]);
      });
      this.#sorted = [...map.entries()].sort((a, b) => b[0] - a[0]);
      if (this.#sorted.length) {
        this.bestRate.value = this.#sorted[0][0];
        this.bestRateProvider.value = this.#sorted[0][1];
      }
      this.noProviderForPair.value = this.#sorted.length === 0;
    } finally {
      this.#rateRunning = false;
    }
  }

  /** setForcedProvider: one quote from that provider, not refreshed */
  setForcedProvider(p: ExchangeProvider | null): void {
    this.forcedProvider.value = p;
    this.forcedProviderRate.value = 0;
    if (!p) return;
    const fixed = this.isFixedRateMode.peek();
    const entered = Number.parseFloat((fixed ? this.receiveMoney.peek() : this.depositMoney.peek()) ?? '');
    const amount = Number.isFinite(entered) ? entered : initialAmount(fixed ? this.receiveCurrency.peek() : this.depositCurrency.peek());
    void p.fetchRate(this.depositCurrency.peek(), this.receiveCurrency.peek(), amount, fixed, fixed).then((r) => {
      if (this.forcedProvider.peek() === p) this.forcedProviderRate.value = r;
    }).catch(() => {});
  }

  // ----------------------------------------------------------- selection --

  addExchangeProvider(p: ExchangeProvider): void {
    if (p.description.isCentralized && this.forceDecentralized) return;
    if (!this.selectedProviders.peek().includes(p)) this.selectedProviders.value = [...this.selectedProviders.peek(), p];
  }

  removeExchangeProvider(p: ExchangeProvider): void {
    this.selectedProviders.value = this.selectedProviders.peek().filter((x) => x !== p);
    if (this.forcedProvider.peek() === p) this.setForcedProvider(null);
  }

  /** saveSelectedProviders */
  saveSelectedProviders(): void {
    this.depositMoney.value = null;
    this.receiveMoney.value = null;
    this.isFixedRateMode.value = false;
    this.bestRateProvider.value = null;
    this.bestRate.value = 0;
    void this.loadLimits();
    const sel = { ...(settings.peek().exchangeProvidersSelection ?? {}) };
    for (const p of this.providerList()) sel[p.title] = this.selectedProviders.peek().includes(p);
    updateSettings({ exchangeProvidersSelection: sel });
    if (this.selectedProviders.peek().includes(trocador)) void this.#updateTrocadorPartners();
  }

  /** toggleForceDecentralizedExchanges */
  toggleForceDecentralized(): void {
    updateSettings({ decentralizedOnly: !settings.peek().decentralizedOnly });
    if (this.forceDecentralized) {
      for (const p of this.selectedProviders.peek()) if (p.description.isCentralized) this.removeExchangeProvider(p);
    } else {
      for (const p of this.providerList()) if (!this.selectedProviders.peek().includes(p) && p.description.isCentralized) this.addExchangeProvider(p);
    }
    // the forceDecentralizedExchanges reaction
    if (this.bestRateProvider.peek()?.description.isCentralized) {
      this.bestRate.value = 0;
      this.bestRateProvider.value = null;
      void this.loadLimits();
    }
  }

  /** updateAllTrocadorProviderStates: the partner list, new partners on */
  async #updateTrocadorPartners(): Promise<void> {
    if (!trocador.needsApiKey || !String(settings.peek().apiKeys?.trocador ?? '').trim()) return;
    try {
      const names = (await trocadorPartners()).map((p) => p.name);
      const old = settings.peek().trocadorProviderStates ?? {};
      const next: Record<string, boolean> = {};
      for (const n of names) next[n] = old[n] ?? true;
      updateSettings({ trocadorProviderStates: next });
    } catch { /* keep the old list */ }
  }

  // --------------------------------------------------------------- trade --

  /** createTrade */
  async createTrade(): Promise<void> {
    if (this.tradeState.peek().kind === 'creating') return;
    this.tradeState.value = { kind: 'creating' };
    try {
      await this.#createTrade();
    } finally {
      if (this.tradeState.peek().kind === 'creating') this.tradeState.value = { kind: 'failed', title: t('trade_not_created'), error: t('none_of_selected_providers_can_exchange') };
    }
  }

  async #createTrade(): Promise<void> {
    const dep = this.depositMoney.peek();
    const rec = this.receiveMoney.peek();
    const depOk = dep !== null && Number.parseFloat(dep) > 0;
    const recOk = rec !== null && Number.parseFloat(rec) > 0;
    if (!depOk || !recOk) {
      const error = !depOk ? `${dep ?? '0'} is not a valid amount for depositAmount` : `${rec ?? '0'} is not a valid amount for receiveAmount`;
      this.tradeState.value = { kind: 'failed', title: t('trade_not_created'), error };
      return;
    }
    if (this.isSendAllEnabled.peek()) {
      await this.calculateDepositAllAmount();
      const amount = Number.parseFloat(this.depositMoney.peek() ?? '');
      const min = this.limits.peek().min;
      if (min !== null && Number.isFinite(amount) && amount < min) {
        this.tradeState.value = { kind: 'failed', title: t('trade_not_created'), error: t('amount_is_below_minimum_limit', { min: String(min) }) };
        return;
      }
    }
    const forced = this.forcedProvider.peek();
    if (forced && this.#excludeForMemo(forced)) {
      this.tradeState.value = { kind: 'failed', title: t('trade_not_created'), error: t('none_of_selected_providers_can_exchange') };
      return;
    }
    const pick = (): [number, ExchangeProvider][] => (forced ? [[this.forcedProviderRate.peek(), forced]] : this.#sorted.filter(([, p]) => this.selectedProviders.peek().includes(p)));
    let providers = pick();
    if (!providers.length) {
      await this.calculateBestRate();
      providers = pick();
      if (!providers.length) {
        this.tradeState.value = { kind: 'failed', title: t('trade_not_created'), error: t('none_of_selected_providers_can_exchange') };
        return;
      }
    }
    // the receive address of an own wallet picked in the receiver sheet: BTC → its segwit address
    const sel = this.selectedAddressBookWallet;
    if (sel?.type === 'bitcoin' && builtinOf(this.receiveCurrency.peek())?.key === 'btc') {
      const addr = await segwitAddressOf(sel.id);
      if (addr) this.receiveAddress.value = addr;
    }
    const hideAfter = ['monero', 'wownero', 'zcash', 'bitcoin', 'litecoin', 'bitcoinCash', 'dogecoin'].includes(this.wallet.type);
    for (const [rate, provider] of providers) {
      if (this.#excludeForSendAll(provider)) continue;
      if (this.isFixedRateMode.peek() && !provider.supportsFixedRate) continue;
      if (this.#excludeForMemo(provider)) continue;
      if (this.isSendFromExternal.peek() && provider.title === 'Swaps.XYZ') continue;
      if (!(await provider.checkIsAvailable())) continue;
      this.bestRate.value = rate;
      this.bestRateProvider.value = provider;
      await this.changeDepositAmount(this.depositMoney.peek() ?? '');
      const request: TradeRequest = {
        fromCurrency: this.depositCurrency.peek(),
        toCurrency: this.receiveCurrency.peek(),
        fromAmount: this.depositMoney.peek() ?? '',
        toAmount: this.receiveMoney.peek() ?? '',
        refundAddress: this.depositAddress.peek(),
        toAddress: this.receiveAddress.peek(),
        toAddressExtraId: this.receiveAddressExtraId.peek().trim(),
        isFixedRate: this.isFixedRateMode.peek(),
      };
      if (hideAfter && request.refundAddress) await this.wallet.hideAddressAfterExchange(request.refundAddress).catch(() => {});
      const amount = Number.parseFloat(this.isFixedRateMode.peek() ? request.toAmount : request.fromAmount);
      if (this.limitsState.peek().kind !== 'success') continue;
      if (!Number.isFinite(amount)) continue;
      const l = this.limits.peek();
      if (l.min !== null && amount < l.min) continue;
      if (l.max !== null && amount > l.max) continue;
      try {
        this.tradeState.value = { kind: 'creating' };
        const trade = await provider.createTrade(request, this.isFixedRateMode.peek(), this.isSendAllEnabled.peek());
        trade.walletId = this.wallet.id;
        trade.chainId = (this.wallet as any).chainId;
        trade.fromWalletAddress = this.wallet.receiveAddress.peek();
        trade.from ??= this.depositCurrency.peek();
        trade.to ??= this.receiveCurrency.peek();
        trade.stateRaw ||= STATES.created.raw;
        await saveTrade(trade);
        monitorActiveTrades(this.wallet.id);
        this.tradeState.value = { kind: 'created', trade };
        return;
      } catch {
        continue;
      }
    }
    this.tradeState.value = { kind: 'failed', title: t('trade_not_created'), error: t('none_of_selected_providers_can_exchange') };
  }

  /** the swap button: no selected providers, no receive address, the wallet syncing, or no deposit amount */
  get swapDisabled(): boolean {
    return !this.selectedProviders.value.length || !this.receiveAddress.value || !isSynced(this.wallet.syncStatus.value) || !this.depositAmount;
  }
}

/** an own Bitcoin wallet's segwit (P2WPKH) receive address, from its stored state */
async function segwitAddressOf(walletId: string): Promise<string | null> {
  try {
    const st = await walletCache.get<any>(walletId, 'utxo');
    const a = (st?.addresses ?? []).find((x: any) => x.type === 'p2wpkh' && !x.change && !x.hidden && !x.used);
    return a?.address ?? null;
  } catch {
    return null;
  }
}
