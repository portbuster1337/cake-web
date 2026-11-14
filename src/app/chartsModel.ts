// The charts tab's model (lib/new-ui/viewmodels/charts/*, lib/new-ui/model/charts/*): Cake's ranges, its
// table of followed assets, the change data and the sorts, and the price strings as Cake's Money prints them.

import { parseFixed } from '../core/amount.ts';

/** chart_range.dart: the span (seconds, 0 for ALL) and the data precision (seconds) */
export const CHART_RANGES = [
  { id: '1H', span: 3600, precision: 300 },
  { id: '1D', span: 86400, precision: 900 },
  { id: '7D', span: 7 * 86400, precision: 3600 },
  { id: '30D', span: 30 * 86400, precision: 4 * 3600 },
  { id: '1Y', span: 365 * 86400, precision: 86400 },
  { id: 'ALL', span: 0, precision: 86400 },
] as const;
export type ChartRangeId = (typeof CHART_RANGES)[number]['id'];
export const DEFAULT_RANGE: ChartRangeId = '30D';

export const rangeOf = (id: ChartRangeId) => CHART_RANGES.find((r) => r.id === id)!;

/** PriceStore.getPrices: the aligned start of a range ending now (seconds) */
export function rangeStart(id: ChartRangeId, nowSec: number): number {
  const r = rangeOf(id);
  return r.span ? Math.floor((nowSec - r.span) / r.precision) * r.precision : 0;
}

/** PriceStore._alignedData: the points on the range's precision, in time order */
export function alignedPoints(points: [number, number][], id: ChartRangeId): [number, number][] {
  const p = rangeOf(id).precision;
  return points.filter(([t]) => t % p === 0).sort((a, b) => a[0] - b[0]);
}

// ------------------------------------------------------------------ Money --

/** cw_core Money: an amount in units of 10^-decimals of a currency */
export interface Money {
  amount: bigint;
  decimals: number;
}

/** format_fixed.dart */
export function dartFormatFixed(value: bigint, decimals: number, fractionalDigits = decimals, trimZeros = true): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const mult = 10n ** BigInt(decimals);
  let fraction = (v % mult).toString().padStart(decimals, '0');
  fraction = fraction.slice(0, Math.max(0, Math.min(fractionalDigits, decimals)));
  if (trimZeros) fraction = fraction.replace(/0+$/, '');
  const s = fraction ? `${v / mult}.${fraction}` : `${v / mult}`;
  return neg ? `-${s}` : s;
}

const transform = (amount: bigint, from: number, to: number) => (to === from ? amount : to > from ? amount * 10n ** BigInt(to - from) : amount / 10n ** BigInt(from - to));

/** PriceApiClient: Money.parse(price.toStringAsFixed(20), currency, strictParsing: false) */
export function priceMoney(price: number, currencyDecimals: number): Money {
  let s = Number.isFinite(price) && Math.abs(price) < 1e21 ? price.toFixed(20) : '0';
  // trimTrailingFractionZeros
  if (s.includes('.')) {
    s = s.replace(/0+$/, '');
    if (s.endsWith('.')) s = s.slice(0, -1);
  }
  const decimals = Math.max(s.split('.')[1]?.length ?? 0, currencyDecimals);
  return { amount: parseFixed(s, decimals), decimals };
}

/** Money.toStringWithPrecision for a currency of `currencyDecimals` */
export function toStringWithPrecision(m: Money, currencyDecimals: number, o: { fractionalDigits?: number; trimZeros?: boolean; meaningfulDecimals?: number } = {}): string {
  const trimZeros = o.trimZeros ?? true;
  if (o.meaningfulDecimals !== undefined && m.amount !== 0n) {
    const digits = (m.amount < 0n ? -m.amount : m.amount).toString().length;
    if (digits <= m.decimals) {
      const meaningful = Math.min(m.decimals - digits + o.meaningfulDecimals, 12);
      if (meaningful > Math.min(o.fractionalDigits ?? currencyDecimals, currencyDecimals)) return dartFormatFixed(m.amount, m.decimals, meaningful, trimZeros);
    }
  }
  return dartFormatFixed(transform(m.amount, m.decimals, currencyDecimals), currencyDecimals, o.fractionalDigits ?? currencyDecimals, trimZeros);
}

/** Money's arithmetic and comparisons: on the larger of the two decimals */
function align(a: Money, b: Money): [bigint, bigint, number] {
  const d = Math.max(a.decimals, b.decimals);
  return [transform(a.amount, a.decimals, d), transform(b.amount, b.decimals, d), d];
}

/** Money.toString(), read back as a double (double.parse) */
const toDouble = (m: Money) => Number(dartFormatFixed(m.amount, m.decimals));

// ----------------------------------------------------------- change data --

/** PriceChangeData */
export interface ChangeData {
  up: boolean;
  /** the change, as a positive amount of the price's currency */
  amount: Money;
  /** the change in percent, two decimals, without its sign */
  percentage: string;
  /** the currency the amount is in (Money.zero(FiatCurrency.usd) without data: 2) */
  amountDecimals: number;
}

/** ChartsLoaded.changeDataFor: the range's last price against its first */
export function changeData(points: [number, number][] | undefined, currencyDecimals: number): ChangeData {
  const has = !!points?.length;
  const cur = has ? currencyDecimals : 2;
  const latest = has ? priceMoney(points![points!.length - 1][1], currencyDecimals) : { amount: 0n, decimals: 2 };
  const first = has ? priceMoney(points![0][1], currencyDecimals) : { amount: 0n, decimals: 2 };
  const [l, f, d] = align(latest, first);
  const up = l >= f;
  let percentage = 0;
  if (first.amount !== 0n) {
    const fd = toDouble(first);
    percentage = Math.abs(((toDouble(latest) - fd) / fd) * 100);
  }
  return { up, amount: { amount: l > f ? l - f : f - l, decimals: d }, percentage: percentage.toFixed(2), amountDecimals: cur };
}

/** ChartViewPriceHeader / ChartsAssetGrid: the last price, or "..." */
export function lastPrice(points: [number, number][] | undefined, currencyDecimals: number): Money | null {
  return points?.length ? priceMoney(points[points.length - 1][1], currencyDecimals) : null;
}

/** ChartsAssetCard.displayPrice: no decimals above 10 000, the price as it is below 1, else two decimals */
export function gridPrice(price: string): string {
  if (!/^-?\d+(\.\d+)?$/.test(price)) return price;
  const v = Number(price);
  if (v > 10000) return v.toFixed(0);
  if (v < 1) return price;
  return v.toFixed(2);
}

/** a chart point under the finger: no decimals when the price is whole (chart_header.dart) */
export function scrubPrice(m: Money, currencyDecimals: number): string {
  return toStringWithPrecision(m, currencyDecimals, { fractionalDigits: m.amount % 10n ** BigInt(m.decimals) === 0n ? 0 : 2, trimZeros: false, meaningfulDecimals: 2 });
}

/** DateFormat("M/d/y HH:mm") in local time */
export function scrubTime(sec: number): string {
  const d = new Date(sec * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ------------------------------------------------------------------ sorts --

/** price_data_sort_criteria.dart */
export type SortCriterion = 'marketcap' | 'gains' | 'losses' | 'alphabetical';
export const SORT_CRITERIA: SortCriterion[] = ['marketcap', 'gains', 'losses', 'alphabetical'];
export const SORT_ICONS: Record<SortCriterion, string> = {
  marketcap: 'charts_sort_criteria/marketcap.svg',
  gains: 'charts_sort_criteria/gains.svg',
  losses: 'charts_sort_criteria/losses.svg',
  alphabetical: 'charts_sort_criteria/alpha.svg',
};

/** cryptoCurrenciesByMarketcap */
export const MARKETCAP_ORDER = ['btc', 'eth', 'usdt', 'xrp', 'bnb', 'sol', 'usdc', 'doge', 'trx', 'ton', 'bch', 'ltc', 'xmr', 'matic', 'arb', 'dai', 'paxg', 'zec', 'dcr', 'nano', 'zano', 'deuro', 'wow'];

/** String.compareTo (code units) */
const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** double.compareTo (-0.0 before 0.0) */
function compareDoubles(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  if (Object.is(a, -0) && Object.is(b, 0)) return -1;
  if (Object.is(a, 0) && Object.is(b, -0)) return 1;
  return 0;
}

/** PriceChangeData.compareTo: the signed percentage */
const signed = (c: ChangeData) => Number(c.percentage) * (c.up ? 1 : -1);

export interface SortableAsset {
  key: string;
  title: string;
  fullName: string | null;
}

/** ChartsLoaded.currencies: the assets in the criterion's order (a stable sort, as Dart's for short lists) */
export function sortAssets<T extends SortableAsset>(list: T[], criterion: SortCriterion, change: (a: T) => ChangeData): T[] {
  const name = (a: T) => a.fullName ?? a.title;
  const cmp = (a: T, b: T): number => {
    switch (criterion) {
      case 'alphabetical':
        return compareStrings(name(a), name(b));
      case 'gains':
        return compareDoubles(signed(change(b)), signed(change(a)));
      case 'losses':
        return compareDoubles(signed(change(a)), signed(change(b)));
      case 'marketcap': {
        const ai = MARKETCAP_ORDER.indexOf(a.key);
        const bi = MARKETCAP_ORDER.indexOf(b.key);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return compareStrings(name(a), name(b));
      }
    }
  };
  return [...list].sort(cmp);
}

// ------------------------------------------------------- followed assets --

/** a row of Cake's ChartsAssets table: the asset's api string ("crypto.BTC") and whether it is pinned */
export interface ChartsAssetRow {
  api: string;
  fav: boolean;
}

/** default_settings_migration.dart: Bitcoin (pinned), Monero, Ethereum */
export const DEFAULT_ASSETS: ChartsAssetRow[] = [
  { api: 'crypto.BTC', fav: true },
  { api: 'crypto.XMR', fav: false },
  { api: 'crypto.ETH', fav: false },
];

/** ChartsAsset.insert: INSERT OR REPLACE, so a row written again moves to the end */
export const insertAsset = (rows: ChartsAssetRow[], api: string, fav: boolean): ChartsAssetRow[] => [...rows.filter((r) => r.api !== api), { api, fav }];

/** ChartsAsset.remove */
export const removeAsset = (rows: ChartsAssetRow[], api: string): ChartsAssetRow[] => rows.filter((r) => r.api !== api);

/** ChartsBloc._init: Bitcoin when the table is empty, the first row pinned when none is; the session's assets and pin */
export function initAssets(stored: ChartsAssetRow[]): { rows: ChartsAssetRow[]; assets: string[]; pinned: string } {
  let rows = stored;
  let assets = stored.map((r) => ({ ...r }));
  if (!assets.length) {
    assets = [{ api: 'crypto.BTC', fav: true }];
    rows = insertAsset(rows, 'crypto.BTC', true);
  }
  if (!assets.some((r) => r.fav)) {
    assets[0] = { api: assets[0].api, fav: true };
    rows = insertAsset(rows, assets[0].api, true);
  }
  return { rows, assets: assets.map((r) => r.api), pinned: assets.find((r) => r.fav)!.api };
}

/** CryptoCurrency.apiString */
export const apiString = (title: string) => `crypto.${title}`;
