// Fixed-point amounts as bigint (atomic units), like cw_core format_fixed.dart / parse_fixed.dart.

export function formatFixed(amount: bigint, decimals: number, opts: { fractionDigits?: number; trimZeros?: boolean } = {}): string {
  const neg = amount < 0n;
  let a = neg ? -amount : amount;
  const base = 10n ** BigInt(decimals);
  let whole = a / base;
  let frac = (a % base).toString().padStart(decimals, '0');
  if (opts.fractionDigits !== undefined && opts.fractionDigits < decimals) {
    frac = frac.slice(0, opts.fractionDigits);
  }
  if (opts.trimZeros !== false) frac = frac.replace(/0+$/, '');
  const s = frac ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${s}` : s;
}

export class AmountParseError extends Error {}

/** Parse a user-entered decimal ("0,5" and "0.5" both work) into atomic units. */
export function parseFixed(input: string, decimals: number): bigint {
  const s = input.trim().replace(',', '.').replace(/\s/g, '');
  if (!s) return 0n;
  if (!/^\d*\.?\d*$/.test(s) || s === '.') throw new AmountParseError('Invalid amount');
  const [w, f = ''] = s.split('.');
  if (f.length > decimals) throw new AmountParseError(`Too many decimals (max ${decimals})`);
  return BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

export function tryParseFixed(input: string, decimals: number): bigint | null {
  try {
    return parseFixed(input, decimals);
  } catch {
    return null;
  }
}

/** Display amounts the way Cake does on balance cards: up to 12 significant fraction digits, trimmed. */
export function displayAmount(amount: bigint, decimals: number, maxFraction = 12): string {
  return formatFixed(amount, decimals, { fractionDigits: Math.min(decimals, maxFraction) });
}

export function toNumber(amount: bigint, decimals: number): number {
  return Number(formatFixed(amount, decimals));
}

export function fromNumber(n: number, decimals: number): bigint {
  if (!Number.isFinite(n)) return 0n;
  return parseFixed(n.toFixed(Math.min(decimals, 20)), decimals);
}

export function formatFiat(value: number, currency: string): string {
  if (!Number.isFinite(value)) return '';
  return `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

const symbolsCache = new Map<string, { group: string; decimal: string; zero: number }>();

/** Intl's number symbols for one of the app's languages ("pt_BR" → pt-BR), English when unknown */
function numberSymbols(lang: string): { group: string; decimal: string; zero: number } {
  let s = symbolsCache.get(lang);
  if (s) return s;
  let loc = lang.replace('_', '-');
  try {
    if (!Intl.NumberFormat.supportedLocalesOf(loc).length) loc = 'en';
  } catch {
    loc = 'en';
  }
  const parts = new Intl.NumberFormat(loc, { useGrouping: true }).formatToParts(1234567.5);
  const zero = new Intl.NumberFormat(loc, { useGrouping: false }).format(0).codePointAt(0) ?? 48;
  s = { group: parts.find((p) => p.type === 'group')?.value ?? ',', decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.', zero };
  symbolsCache.set(lang, s);
  return s;
}

/**
 * crypto_amount_format.dart withLocalSeperator: the integer part in threes with the language's group separator
 * (NumberFormat("#,###")), then the fraction as it is after the language's decimal separator; a leading "<" or ">"
 * and anything after a space kept
 */
export function withLocalSeparator(s: string, lang = 'en'): string {
  if (s.includes(' ')) {
    const parts = s.split(' ');
    if (parts[0] === '>' || parts[0] === '<') return [parts[0], withLocalSeparator(parts[1], lang), ...parts.slice(2)].join(' ');
    return [withLocalSeparator(parts[0], lang), ...parts.slice(1)].join(' ');
  }
  const sym = numberSymbols(lang);
  const parts = s.replace(/,/g, '').split('.');
  if (parts[0].includes('< 0')) parts[0] = '0';
  // int.tryParse ?? 0
  const n = /^[+-]?\d+$/.test(parts[0]) ? BigInt(parts[0]) : 0n;
  const digits = (n < 0n ? -n : n).toString();
  const local = [...digits].map((d) => String.fromCodePoint(sym.zero + Number(d))).join('');
  let grouped = '';
  for (let i = 0; i < local.length; i++) grouped += (i && (local.length - i) % 3 === 0 ? sym.group : '') + local[i];
  return [`${n < 0n ? '-' : ''}${grouped}`, ...parts.slice(1)].join(sym.decimal);
}
