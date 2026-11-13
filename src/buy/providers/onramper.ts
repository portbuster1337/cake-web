// Onramper (lib/buy/onramper/onramper_buy_provider.dart): an aggregator of
// on-ramps, buy and sell, every pair. Its API needs a key, and its widget link
// carries the wallet address, which Onramper only accepts signed (Signature
// V2). Cake gets both from its own build and its exchange helper; here the key
// is the user's, and the link is signed with the user's Ed25519 signing key.

import { exFetch, tryJson } from '../../exchange/net.ts';
import { dartDouble } from '../../exchange/amounts.ts';
import { builtinOf } from '../../exchange/currency.ts';
import { apiKey } from '../../exchange/keys.ts';
import { pairCurrency } from '../pairs.ts';
import { onramperSignatureV2, onramperSigningSeed } from '../signing.ts';
import { BuyKeyError, paymentTypeId, recommendationOf, type BuyProvider, type PaymentMethod, type PaymentType, type Quote, type Recommendation } from '../types.ts';
import type { SwapCurrency } from '../../exchange/currency.ts';

const API = 'https://api.onramper.com';
const WIDGET = 'https://buy.onramper.com';
const KEY = 'onramper';
const SIGNING_KEY = 'onramperSigningKey';
const TIMEOUT_MS = 30_000;

/** normalizePaymentMethod */
const NORMALIZED: Partial<Record<PaymentType, string>> = {
  bankTransfer: 'banktransfer', creditCard: 'creditcard', debitCard: 'debitcard', applePay: 'applepay', googlePay: 'googlepay', revolutPay: 'revolutpay',
  neteller: 'neteller', skrill: 'skrill', sepa: 'sepabanktransfer', sepaInstant: 'sepainstant', ach: 'ach', achInstant: 'iach', Khipu: 'khipu',
  palomaBanktTansfer: 'palomabanktransfer', ovo: 'ovo', zaloPay: 'zalopay', zaloBankTransfer: 'zalobanktransfer', gcash: 'gcash', imps: 'imps', dana: 'dana',
  ideal: 'ideal', pixPay: 'pix',
};
const BY_STRING: Record<string, PaymentType> = Object.fromEntries(Object.entries(NORMALIZED).map(([k, v]) => [v, k as PaymentType]));
/** _getPaymentTypeByString */
const typeOf = (s: string): PaymentType => BY_STRING[s.toLowerCase()] ?? 'unknown';

/** _tagToNetwork */
function tagToNetwork(tag: string): string {
  switch (tag) {
    case 'POL': return 'POLYGON';
    case 'ARB': return 'ARBITRUM';
    case 'ETH': return 'ETHEREUM';
    case 'TRX': return 'TRON';
    case 'SOL': return 'SOLANA';
    case 'ZEC': return 'ZCASH';
    default: return tag;
  }
}

/** _getNormalizeNetwork: nothing for BTC, ETH and SOL; _EOSIO; _<network of the tag>; else _<full name without spaces> */
function networkSuffix(c: SwapCurrency): string {
  const k = builtinOf(c)?.key;
  if (k === 'btc' || k === 'eth' || k === 'sol') return '';
  if (k === 'eos') return '_EOSIO';
  if (c.tag !== null) return `_${tagToNetwork(c.tag)}`;
  return `_${c.fullName?.replace(/ /g, '') ?? c.title}`;
}

const toDouble = (v: unknown): number | null => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/** Dart's double.roundToDouble: halves away from zero */
const roundHalfAway = (x: number) => Math.sign(x) * Math.round(Math.abs(x));

/** getColorStr: the theme colour as RRGGBB */
function themeColor(name: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v);
  return m ? m[1].toUpperCase() : fallback;
}

/** _onrampMetadata: ramp id → display name and logo, kept for the session */
let metadata: Record<string, { displayName: string; svg: string }> = {};

export function createOnramper(): BuyProvider {
  const headers = () => ({ Authorization: apiKey(KEY), accept: 'application/json' });
  const get = (path: string, params: Record<string, string>, purpose: string) => exFetch(`${API}${path}${Object.keys(params).length ? `?${new URLSearchParams(params)}` : ''}`, { headers: headers(), scope: 'buy', timeoutMs: TIMEOUT_MS, purpose });

  const provider: BuyProvider = {
    title: 'Onramper',
    description: 'onramper_option_description',
    icon: 'assets/images/onramper_dark.png',
    lightIcon: 'assets/images/onramper_light.png',
    isAggregator: true,
    needsApiKey: KEY,
    recommendedFiat: null,

    supports(c) {
      return !!apiKey(KEY) && !!pairCurrency(c);
    },

    /** fetchRecommendedDefaults, then GET /supported/payment-types/{source}?type&destination */
    async paymentTypes(fiat, crypto, isBuy) {
      if (!apiKey(KEY)) return [];
      await fetchRecommendedDefaults(isBuy);
      const normalized = crypto.title + networkSuffix(crypto);
      const source = (isBuy ? fiat : normalized).toLowerCase();
      const destination = (isBuy ? normalized : fiat).toLowerCase();
      try {
        const r = await get(`/supported/payment-types/${source}`, { type: isBuy ? 'buy' : 'sell', destination }, 'Onramper payment methods');
        if (r.status !== 200) return [];
        const list: any[] = tryJson<any>(r)?.message ?? [];
        // PaymentMethod.fromOnramperJson
        return list.map((j): PaymentMethod => ({
          type: paymentTypeId(j?.paymentTypeId) ?? 'unknown',
          customPaymentMethodType: j?.paymentTypeId ?? undefined,
          customTitle: j?.name ?? 'Unknown',
          customIconPath: j?.icon ?? 'assets/new-ui/buy_payment_methods/debit_card.svg',
          customDescription: j?.description ?? undefined,
        }));
      } catch {
        return [];
      }
    },

    async fetchQuote(a) {
      if (!apiKey(KEY)) return null;
      let paymentMethod: string | undefined;
      if (a.paymentType === 'all') paymentMethod = undefined;
      else if (a.paymentType === 'unknown') paymentMethod = a.customPaymentMethodType;
      else if (a.paymentType) paymentMethod = NORMALIZED[a.paymentType];
      const normalized = a.crypto.title + networkSuffix(a.crypto).toUpperCase();
      const params: Record<string, string> = { amount: dartDouble(a.amount), ...(paymentMethod ? { paymentMethod } : {}), clientName: 'CakeWallet', ...(a.isBuy ? {} : { type: 'sell' }) };
      const source = a.isBuy ? a.fiat : normalized;
      const destination = a.isBuy ? normalized : a.fiat;
      try {
        const r = await get(`/quotes/${source}/${destination}`, params, 'Onramper quotes');
        if (r.status !== 200) return null;
        const data = tryJson<any[]>(r);
        if (!Array.isArray(data) || !data.length) return null;
        if (!Object.keys(metadata).length) metadata = await onrampMetadata();
        const out: Quote[] = [];
        for (const item of data) {
          if (item?.errors != null) continue;
          const ramp = item.ramp as string | undefined;
          if (!ramp || !metadata[ramp]) continue;
          out.push(fromOnramperJson(item, a.isBuy, typeOf(String(item.paymentMethod ?? '')), a.customPaymentMethodType, a.fiat, a.crypto));
        }
        return out.length ? out : null;
      } catch {
        return null;
      }
    },

    async launchUrl({ quote, amount, isBuy, cryptoCurrencyAddress }) {
      const c = quote.crypto;
      const defaultCrypto = c.title + networkSuffix(c).toLowerCase();
      const paymentMethod = quote.paymentType === 'unknown' ? quote.customPaymentMethodType : NORMALIZED[quote.paymentType];
      const networkWallets = `${tagToNetwork(c.tag ?? c.title).toLowerCase()}:${cryptoCurrencyAddress}`;
      const signedFields = { apiKey: apiKey(KEY), networkWallets };
      // getOnramperSignatureParams: Cake's exchange helper; here the user's own signing key
      const raw = apiKey(SIGNING_KEY);
      if (!raw) throw new BuyKeyError('Onramper needs your Onramper signing key to open its page (Settings → Connection and sync → API keys)');
      const signature = onramperSignatureV2(signedFields, onramperSigningSeed(raw));
      const surface = themeColor('--surface', '1B284A');
      const q = new URLSearchParams({
        ...signedFields,
        txnType: isBuy ? 'buy' : 'sell',
        txnFiat: quote.fiat,
        txnCrypto: defaultCrypto,
        txnAmount: dartDouble(amount),
        skipTransactionScreen: 'true',
        ...(paymentMethod ? { txnPaymentMethod: paymentMethod } : {}),
        txnOnramp: quote.rampId ?? '',
        supportSwap: 'false',
        primaryColor: themeColor('--primary', '7A93EC'),
        secondaryColor: surface,
        containerColor: surface,
        primaryTextColor: themeColor('--on-surface', 'D7E2F7'),
        secondaryTextColor: themeColor('--on-surface-variant', '8C9FBB'),
        cardColor: themeColor('--surface-container', '24335C'),
        ...signature,
      });
      return `${WIDGET}?${q}`;
    },
  };

  /** fetchRecommendedDefaults: the recommended payment method and, by the action's fiat side, the fiat */
  async function fetchRecommendedDefaults(isBuy: boolean): Promise<void> {
    try {
      const r = await get('/supported/defaults/all', { type: isBuy ? 'buy' : 'sell' }, 'Onramper defaults');
      if (r.status !== 200) return;
      const rec = tryJson<any>(r)?.message?.recommended ?? {};
      const fiat = rec[isBuy ? 'source' : 'target'];
      provider.recommendedFiat = typeof fiat === 'string' ? fiat.toUpperCase() : null;
    } catch { /* keep the previous one */ }
  }

  async function onrampMetadata(): Promise<typeof metadata> {
    try {
      const r = await get('/supported/onramps/all', {}, 'Onramper ramps');
      if (r.status !== 200) return {};
      const list: any[] = tryJson<any>(r)?.message ?? [];
      return Object.fromEntries(list.map((o) => [String(o.id), { displayName: String(o.displayName), svg: String(o.icons?.svg ?? '') }]));
    } catch {
      return {};
    }
  }

  /** Quote.fromOnramperJson */
  function fromOnramperJson(json: any, isBuy: boolean, paymentType: PaymentType, customPaymentMethodType: string | undefined, fiat: string, crypto: SwapCurrency): Quote {
    const networkFee = toDouble(json.networkFee) ?? 0;
    const transactionFee = toDouble(json.transactionFee) ?? 0;
    const rampId = String(json.ramp ?? '');
    const ramp = metadata[rampId];
    let min = 0;
    let max = Infinity;
    for (const pm of Array.isArray(json.availablePaymentMethods) ? json.availablePaymentMethods : []) {
      const limits = pm?.details?.limits;
      if (limits && typeof limits === 'object' && Object.keys(limits).length) {
        const first = Object.values<any>(limits)[0];
        if (first) {
          const lo = toDouble(first.min);
          const hi = toDouble(first.max);
          min = lo === null ? 0 : roundHalfAway(lo);
          max = hi === null ? Infinity : roundHalfAway(hi);
          break;
        }
      }
    }
    return {
      rate: toDouble(json.rate) ?? 0,
      feeAmount: Number((networkFee + transactionFee).toFixed(2)),
      networkFee,
      transactionFee,
      payout: typeof json.payout === 'number' ? json.payout : 0,
      rampId,
      rampName: ramp?.displayName ?? '',
      rampIconPath: ramp?.svg ?? '',
      paymentType,
      customPaymentMethodType,
      quoteId: String(json.quoteId ?? ''),
      recommendations: (Array.isArray(json.recommendations) ? json.recommendations : []).map((x: unknown) => recommendationOf(String(x))).filter((x: Recommendation | null): x is Recommendation => x !== null),
      provider,
      isBuyAction: isBuy,
      limits: { min, max },
      fiat,
      crypto,
    };
  }

  return provider;
}
