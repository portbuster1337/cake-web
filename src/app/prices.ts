// Fiat prices (Cake: lib/core/fiat_conversion_service.dart, lib/new-ui/model/charts/price_api_client.dart).
// Cake's own price API, through Tor: clearnet host in "Enabled" mode, its
// onion service in "Tor only" mode, nothing when "Disabled".

import { signal } from '@preact/signals';
import { getJson, qs } from '../net/http.ts';
import { settings } from './settings.ts';
import type { Currency } from '../coins/types.ts';

const CLEARNET = 'https://prices.cakewallet.com';
const ONION = 'http://cakeprcgc6mywkgmft2qd7qkkzddsfdmvcia7geilte7qhd2vazgi6id.onion';

/** lib/entities/fiat_currency.dart (51 codes, in Cake's order) */
export const FIAT_CURRENCIES = ['AMD', 'ARS', 'AUD', 'BDT', 'BGN', 'BRL', 'CAD', 'CHF', 'CLP', 'CNY', 'COP', 'CZK', 'DKK', 'EGP', 'EUR', 'GBP', 'GHS', 'GTQ', 'HKD', 'HRK', 'HUF', 'IDR', 'ILS', 'INR', 'IRR', 'ISK', 'JPY', 'KRW', 'MAD', 'MXN', 'MYR', 'NGN', 'NOK', 'NZD', 'PHP', 'PKR', 'PLN', 'RON', 'RUB', 'SAR', 'SEK', 'SGD', 'THB', 'TWD', 'UAH', 'USD', 'VEF', 'VND', 'ZAR', 'TRY', 'KES'];

/** fiat code -> flag file (assets/images/flags/<code>.png) */
export const FIAT_FLAG: Record<string, string> = {
  AMD: 'arm', ARS: 'arg', AUD: 'aus', BDT: 'bgd', BGN: 'bgr', BRL: 'bra', CAD: 'cad', CHF: 'che', CLP: 'chl', CNY: 'chn', COP: 'col', CZK: 'czk', DKK: 'dnk', EGP: 'egy',
  EUR: 'eur', GBP: 'gbr', GHS: 'gha', GTQ: 'gtm', HKD: 'hkg', HRK: 'hrv', HUF: 'hun', IDR: 'idn', ILS: 'isr', INR: 'ind', IRR: 'irn', ISK: 'isl', JPY: 'jpn', KRW: 'kor',
  MAD: 'mar', MXN: 'mex', MYR: 'mys', NGN: 'nga', NOK: 'nor', NZD: 'nzl', PHP: 'phl', PKR: 'pak', PLN: 'pol', RON: 'rou', RUB: 'rus', SAR: 'sau', SEK: 'swe', SGD: 'sgp',
  THB: 'tha', TWD: 'twn', UAH: 'ukr', USD: 'usa', VEF: 'ven', VND: 'vnm', ZAR: 'zaf', TRY: 'tur', KES: 'ken',
};

/** price per currency api string, in the current fiat */
export const prices = signal<Record<string, number>>({});

export function apiString(c: Currency, contract?: string): string {
  if (contract) {
    if (c.tag === 'SOL') return `sol.${contract}`;
    if (c.tag === 'TRX') return `trx.${contract}`;
    return `evm.${contract.toLowerCase()}`;
  }
  return `crypto.${c.title}`;
}

function host(): string | null {
  const m = settings.value.fiatApiMode;
  if (m === 'disabled') return null;
  return m === 'torOnly' ? ONION : CLEARNET;
}

export async function fetchPrice(base: string, fiat = settings.value.fiatCurrency): Promise<number> {
  const h = host();
  if (!h) return 0;
  try {
    const r = await getJson<{ results: Record<string, number> }>(`${h}/v3/rates${qs({ base, quote: `fiat.${fiat}` })}`, { scope: 'prices', purpose: 'fiat price', retries: 1, timeoutMs: 60_000 });
    const v = Object.values(r?.results ?? {})[0];
    return typeof v === 'number' ? v : 0;
  } catch {
    return 0;
  }
}

export async function fetchHistory(base: string, startSec: number, intervalSec: number, fiat = settings.value.fiatCurrency): Promise<[number, number][]> {
  const h = host();
  if (!h) return [];
  const r = await getJson<{ results: Record<string, number> }>(`${h}/v3/rates${qs({ start: startSec, end: Math.floor(Date.now() / 1000), interval: intervalSec, quote: `fiat.${fiat}`, base })}`, { scope: 'prices', purpose: 'price history', retries: 1, timeoutMs: 90_000 });
  return Object.entries(r?.results ?? {}).map(([k, v]) => [Number(k), v] as [number, number]).sort((a, b) => a[0] - b[0]);
}

const watched = new Set<string>();
let timer: ReturnType<typeof setInterval> | undefined;

export function watchPrice(base: string): void {
  watched.add(base);
  void refreshPrices([base]);
  if (!timer) timer = setInterval(() => void refreshPrices([...watched]), 30_000);
}

export async function refreshPrices(list = [...watched]): Promise<void> {
  if (settings.value.fiatApiMode === 'disabled') return;
  const res = await Promise.all(list.map(async (b) => [b, await fetchPrice(b)] as const));
  const next = { ...prices.value };
  for (const [b, p] of res) if (p > 0) next[b] = p;
  prices.value = next;
}

export function resetPrices(): void {
  prices.value = {};
  void refreshPrices();
}

export function fiatValue(amount: number, base: string): number | null {
  const p = prices.value[base];
  return p ? amount * p : null;
}

/** calculate_fiat_amount_raw.dart: "< 0.01" for tiny values, else 2 decimals with separators */
export function formatFiatAmount(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '---';
  if (v > 0 && v <= 0.01) return '< 0.01';
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
