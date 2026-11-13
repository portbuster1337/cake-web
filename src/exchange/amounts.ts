// Amount helpers of the swap view model (cw_core/lib/amount/money.dart,
// money_double.dart, the withMaxDecimals string extension).

import { formatFixed, parseFixed, tryParseFixed } from '../core/amount.ts';
import type { SwapCurrency } from './currency.ts';

/** Money.tryParse (strict): a canonical decimal (trailing zeros trimmed), or null */
export function toMoney(s: string, c: Pick<SwapCurrency, 'decimals'>): string | null {
  const v = s.trim().replace(/\s/g, '').replace(',', '.');
  if (!v) return null;
  const a = tryParseFixed(v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') || '0' : v, c.decimals);
  return a === null ? null : formatFixed(a, c.decimals);
}

/** double.tryToMoney: toStringAsFixed(min(decimals, 20)), trailing zeros trimmed */
export function doubleToMoney(x: number, c: Pick<SwapCurrency, 'decimals'>): string | null {
  if (!Number.isFinite(x)) return null;
  const s = x.toFixed(Math.min(c.decimals, 20));
  return toMoney(s, c);
}

/** String.withMaxDecimals */
export function withMaxDecimals(s: string, max: number): string {
  if (/e/i.test(s)) s = Number(s).toFixed(Math.min(max, 20));
  const [w, f] = s.split('.');
  if (f === undefined) return w;
  return max <= 0 ? w : `${w}.${f.slice(0, max)}`;
}


/** Dart's double.toString(): "1.0" for whole numbers, exponent notation for very small and large values */
export function dartDouble(x: number): string {
  if (!Number.isFinite(x)) return String(x);
  if (Number.isInteger(x) && Math.abs(x) < 1e21) return `${x}.0`;
  const s = String(x);
  // JS writes 1e-7 / 1.5e+21; Dart writes 1e-7 / 1.5e+21 as well
  return s;
}

/** BigInt from a decimal amount and the number of decimals (toBaseUnits) */
export function toBaseUnits(amount: string, decimals: number): string {
  const s = amount.trim();
  const m = /^(\d*)(?:[.,](\d*))?$/.exec(s);
  if (!m) throw new Error(`Invalid amount ${amount}`);
  const int = m[1] || '0';
  const frac = (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  return BigInt(int + frac).toString();
}

export function fromBaseUnits(v: string | number | bigint, decimals: number): number {
  return Number(v) / 10 ** decimals;
}

/** a double's decimal expansion without exponent (for amounts sent as base units) */
export function plainNumber(x: number): string {
  if (!Number.isFinite(x)) return '0';
  const s = String(x);
  if (!/e/i.test(s)) return s;
  return x.toFixed(20).replace(/\.?0+$/, '');
}

/** Money.tryParse(trade.amount, strictParsing: false): more decimals than the coin has are cut */
export function amountOf(s: string, decimals: number): bigint {
  const v = s.trim().replace(',', '.');
  const [whole, frac = ''] = v.split('.');
  return parseFixed(frac ? `${whole}.${frac.slice(0, decimals)}` : whole, decimals);
}
