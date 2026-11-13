// Cake Pay models (lib/cake_pay/src/models/*, lib/entities/country.dart): vendors
// and their cards, orders and their payment data, countries.

import { COUNTRIES } from './countries.gen.ts';

// -------------------------------------------------------------- countries --

export interface Country {
  /** ISO alpha-3, lower case (Country.raw; the flag file) */
  code: string;
  /** ISO alpha-2 (the API's country_code) */
  countryCode: string;
  fullName: string;
}

const ALL: Country[] = COUNTRIES.map(([code, countryCode, fullName]) => ({ code, countryCode, fullName }));

/** Country.allForCakePay: all but the EU and Antarctica */
export const CAKE_PAY_COUNTRIES: Country[] = ALL.filter((c) => c.countryCode !== 'EU' && c.countryCode !== 'AQ');

/** Country.fromCode: by the alpha-3 code */
export const countryFromCode = (code: string): Country | undefined => ALL.find((c) => c.code === code.toLowerCase());

export const countryFlag = (c: Country) => `assets/images/flags/${c.code}.png`;

const CAKE_PAY_NAMES: Record<string, string> = {
  'Slovak Republic': 'Slovakia',
  'Brunei Darussalam': 'Brunei',
  'Federated States of Micronesia': 'Micronesia',
  'Sri lanka': 'Sri Lanka',
  UAE: 'United Arab Emirates',
  UK: 'United Kingdom',
  'CuraÃ§ao': 'Curacao',
};

/** Country.normalizeName: Cake Pay's names of a few countries */
export function normalizeCountryName(name: string): string {
  const k = name.trim();
  return CAKE_PAY_NAMES[k] ?? k;
}

/** _getInitialCountry: Germany for EUR, else the fiat's country, else the USA (FiatCurrency.countryCode) */
export function initialCountry(fiatCountryCode: string): Country {
  if (fiatCountryCode === 'eur') return countryFromCode('deu')!;
  return countryFromCode(fiatCountryCode) ?? countryFromCode('usa')!;
}

// ------------------------------------------------------------------ cards --

export type CardType = 'prepaid' | 'gift' | 'onDemand' | 'custom';

const CARD_TYPES: [CardType, string][] = [['prepaid', 'Prepaid Cards'], ['gift', 'gift'], ['onDemand', 'on_demand'], ['custom', 'custom']];

export interface Denomination {
  value: number;
  cardId: number | null;
  usdValue: number | null;
}

export interface PrepaidRange {
  minValue: number;
  maxValue: number;
  rangeId: string;
}

export interface CakePayCard {
  id: number;
  name: string;
  type: CardType | null;
  description: string;
  termsAndConditions: string;
  howToUse: string;
  expiryAndValidity: string | null;
  cardImageUrl: string | null;
  country: string | null;
  /** FiatCurrency.deserialize: USD when unknown */
  fiatCurrency: string;
  minValueUsd: string | null;
  maxValueUsd: string | null;
  minValue: string | null;
  maxValue: string | null;
  denominations: Denomination[];
  prepaidRange: PrepaidRange[];
}

export interface CakePayVendor {
  id: number;
  name: string;
  available: boolean;
  cakeWarnings: string | null;
  country: string;
  card: CakePayCard | null;
}

/** stripHtmlIfNeeded: tags and entities become spaces */
export const stripHtml = (s: string) => s.replace(/<[^>]*>|&[^;]+;/g, ' ');

const toDouble = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const n = Number(String(v).trim());
  return String(v).trim() !== '' && Number.isFinite(n) ? n : null;
};

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** CakePayCard.fromJson; min_value is raised to 10 USD worth when the card's USD minimum is below 10 */
export function parseCard(json: any, fiats: readonly string[]): CakePayCard {
  const typeString = String(json?.type ?? '').trim().toLowerCase();
  const code = String(json?.currency_code ?? '');
  let minValue = str(json?.min_value);
  const local = toDouble(json?.min_value);
  const usd = toDouble(json?.min_value_usd);
  if (local !== null && local > 0 && usd !== null && usd > 0 && usd < 10) minValue = ((10 * local) / usd).toFixed(2);
  const denominations: Denomination[] = (Array.isArray(json?.denominations) ? json.denominations : [])
    .filter((d: unknown) => d && typeof d === 'object')
    .map((d: any) => ({ value: toDouble(d.value) ?? 0, cardId: typeof d.card_id === 'number' ? d.card_id : Number.isInteger(Number.parseInt(String(d.card_id), 10)) ? Number.parseInt(String(d.card_id), 10) : null, usdValue: toDouble(d.usd_value) }));
  return {
    id: typeof json?.id === 'number' ? json.id : 0,
    name: stripHtml(String(json?.name ?? '')),
    type: CARD_TYPES.find(([, api]) => api.toLowerCase() === typeString)?.[0] ?? null,
    description: stripHtml(String(json?.description ?? '')),
    termsAndConditions: stripHtml(String(json?.terms_and_conditions ?? '')),
    howToUse: stripHtml(String(json?.how_to_use ?? '')),
    expiryAndValidity: str(json?.expiry_and_validity),
    cardImageUrl: str(json?.card_image_url),
    country: str(json?.country),
    fiatCurrency: fiats.includes(code) ? code : 'USD',
    minValueUsd: str(json?.min_value_usd),
    maxValueUsd: str(json?.max_value_usd),
    minValue,
    maxValue: str(json?.max_value),
    denominations,
    prepaidRange: [],
  };
}

/** CakePayVendor.fromJson: the vendor's cards of its own country; all prepaid → one card with every range */
export function parseVendor(json: any, fiats: readonly string[]): CakePayVendor {
  const country = normalizeCountryName(String(json?.country ?? ''));
  let card: CakePayCard | null = null;
  const list = Array.isArray(json?.cards) ? json.cards : [];
  if (list.length) {
    try {
      const cards = list.map((c: any) => parseCard(c, fiats)).filter((c: CakePayCard) => normalizeCountryName(c.country ?? '') === country);
      if (cards.length) {
        if (cards.every((c: CakePayCard) => c.type === 'prepaid')) {
          const ranges = cards.map((c: CakePayCard) => ({ minValue: toDouble(c.minValue) ?? 0, maxValue: toDouble(c.maxValue) ?? 0, rangeId: String(c.id) })).sort((a: PrepaidRange, b: PrepaidRange) => a.minValue - b.minValue);
          card = { ...cards[0], prepaidRange: ranges };
        } else card = cards[0];
      }
    } catch {
      card = null;
    }
  }
  return { id: Number(json?.id), name: stripHtml(String(json?.name ?? '')), available: json?.available === true, cakeWarnings: str(json?.cake_warnings), country, card };
}

// ----------------------------------------------------------------- orders --

export type CakePayPaymentMethod = 'BTC' | 'BTC_LN' | 'XMR' | 'LTC' | 'LTC_MWEB' | 'ZEC';

export const METHOD_LABEL: Record<CakePayPaymentMethod, string> = { BTC: 'Bitcoin', BTC_LN: 'Lightning', XMR: 'Monero', LTC: 'Litecoin', LTC_MWEB: 'MWEB', ZEC: 'Zcash' };

/** getCurrencyCodeFromPaymentMethod */
export const methodCurrency = (m: CakePayPaymentMethod) => (m === 'BTC_LN' ? 'BTC' : m === 'LTC_MWEB' ? 'LTC' : m);

export interface PaymentUrls {
  bip21?: string;
  bip72?: string;
  bip72b?: string;
  bip73?: string;
  bolt11?: string;
}

export interface CryptoPaymentData {
  /** the crypto amount to pay */
  price: string;
  /** amount_from as Dart prints a double ("" when absent) */
  amount: string;
  address: string;
  paymentUrls?: PaymentUrls;
}

export interface OrderCard {
  cardId: number;
  externalId: number | null;
  price: string;
  quantity: number;
  currencyCode: string;
  cardName: string | null;
  cardImagePath: string | null;
}

export interface CakePayOrder {
  orderId: string;
  cards: OrderCard[];
  externalId: string | null;
  amountUsd: number;
  totalReceiveAmount: string;
  quantity: number;
  status: string;
  vouchers: string | null;
  fiatCurrencyCode: string;
  paymentData: {
    methods: Partial<Record<CakePayPaymentMethod, CryptoPaymentData>>;
    invoiceTime: number;
    expirationTime: number;
    commission: number | null;
  };
}

/** Dart's double.toString of a number */
const dartNum = (n: number) => (Number.isInteger(n) && Math.abs(n) < 1e21 ? `${n}.0` : String(n));

function paymentDataOf(m: any): CryptoPaymentData {
  const u = m?.paymentUrls;
  return {
    price: String(m.price),
    amount: typeof m.amount_from === 'number' ? dartNum(m.amount_from) : '',
    address: String(m.address),
    paymentUrls: u ? { bip21: str(u.BIP21) ?? undefined, bip72: str(u.BIP72) ?? undefined, bip72b: str(u.BIP72b) ?? undefined, bip73: str(u.BIP73) ?? undefined, bolt11: str(u.BOLT11) ?? undefined } : undefined,
  };
}

const ORDER_KEYS: [CakePayPaymentMethod, string][] = [['BTC', 'BTC'], ['BTC_LN', 'BTC_LN'], ['XMR', 'XMR'], ['LTC', 'LTC'], ['LTC_MWEB', 'LTC_MWEB'], ['ZEC', 'ZEC_CHAIN']];

/** CakePayOrder.fromMap */
export function parseOrder(map: any): CakePayOrder {
  const cards: any[] = Array.isArray(map.cards) ? map.cards : [];
  const first = cards[0] ?? {};
  const pd = map.payment_data ?? {};
  const methods: Partial<Record<CakePayPaymentMethod, CryptoPaymentData>> = {};
  for (const [m, k] of ORDER_KEYS) if (pd[k] != null) methods[m] = paymentDataOf(pd[k]);
  return {
    orderId: String(map.order_id),
    cards: cards.map((c) => ({ cardId: Number(c.card_id), externalId: typeof c.external_id === 'number' ? c.external_id : null, price: String(c.price), quantity: Number(c.quantity), currencyCode: String(c.currency_code), cardName: str(c.name), cardImagePath: str(c.card_image_url) })),
    externalId: str(map.external_id),
    amountUsd: Number(map.amount_usd),
    totalReceiveAmount: str(first.subtotal) ?? '',
    quantity: Number(first.quantity),
    status: String(map.status),
    vouchers: str(map.vouchers),
    fiatCurrencyCode: str(first.currency_code) ?? '',
    paymentData: { methods, invoiceTime: Number(pd.invoice_time), expirationTime: Number(pd.expiration_time), commission: typeof pd.commission === 'number' ? pd.commission : null },
  };
}

/** getPaymentDataFor: a BIP21 link wins (its path is the address, its amount the price) */
export function paymentDataFor(method: CakePayPaymentMethod | null, order: CakePayOrder | null): CryptoPaymentData | null {
  if (!order || !method) return null;
  const d = order.paymentData.methods[method];
  if (!d) return null;
  const bip21 = d.paymentUrls?.bip21;
  if (bip21) {
    const i = bip21.indexOf(':');
    const rest = i >= 0 ? bip21.slice(i + 1) : bip21;
    const [path, query = ''] = rest.split('?');
    const amount = new URLSearchParams(query).get('amount');
    return { price: amount ?? d.price, address: path, amount: d.amount, paymentUrls: d.paymentUrls };
  }
  return d;
}

/** CakePayOrderProviderAdapter: Cake Pay's order status as a TradeState raw */
export function orderState(status: string): string {
  switch (status) {
    case 'new': return 'pending';
    case 'expired_but_still_pending': return 'overdue';
    case 'expired': return 'expired';
    case 'failed': return 'failed';
    case 'paid': return 'PAID';
    case 'paid_partial': return 'UNDERPAID';
    case 'pending_purchase': case 'purchase_processing': return 'processing';
    case 'purchased': return 'confirmed';
    case 'pending_email': return 'awaiting';
    case 'complete': return 'complete';
    case 'pending_refund': return 'refund';
    case 'refunded': return 'refunded';
    default: return 'NOT_FOUND';
  }
}

/** formatDuration: HH:MM:SS */
export function formatDuration(ms: number): string {
  const s = Math.trunc(ms / 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.trunc(s / 3600))}:${p(Math.trunc(s / 60) % 60)}:${p(s % 60)}`;
}
