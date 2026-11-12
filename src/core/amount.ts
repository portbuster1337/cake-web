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
