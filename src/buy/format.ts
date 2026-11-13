// Number formatting of the buy/sell pages (cw_core/lib/crypto_amount_format.dart,
// lib/entities/calculate_fiat_amount.dart, cw_core/lib/format_fixed.dart).

/** withLocalSeperator ("en"): thousands grouped, the fraction kept */
export function groupThousands(s: string): string {
  const neg = s.startsWith('-');
  const [int, frac] = (neg ? s.slice(1) : s).replace(/,/g, '').split('.');
  const g = (Number.parseInt(int, 10) || 0).toLocaleString('en-US');
  return `${neg ? '-' : ''}${g}${frac !== undefined ? `.${frac}` : ''}`;
}

/** formatWithCommas: the integer part grouped, a one-digit fraction padded */
export function formatWithCommas(n: string | null | undefined): string {
  if (!n) return '';
  const [int, dec = ''] = n.split('.');
  const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const d = dec.length === 1 ? `${dec}0` : dec;
  return d ? `${g}.${d}` : g;
}

/** Money.toStringWithPrecision(fractionalDigits): cut (not rounded) to that many digits, zeros trimmed */
export function cutDigits(s: string, digits: number, trimZeros = true): string {
  const [int, frac = ''] = s.split('.');
  let f = frac.slice(0, digits);
  if (trimZeros) f = f.replace(/0+$/, '');
  else f = f.padEnd(digits, '0');
  return f ? `${int}.${f}` : int;
}

