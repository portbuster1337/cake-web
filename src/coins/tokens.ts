// Token helpers shared by the EVM, Solana and Tron wallets: icons, Cake's
// spam heuristics (evm_chain_wallet.dart isTokenPropertiesSuspicious,
// solana_wallet.dart) and the homoglyph table (cw_core/lib/utils/homoglyph_normalizer.dart).

import { CURRENCY_DEFS } from './currencies.gen.ts';

export interface WalletToken {
  /** contract (EVM, lower-case like Cake stores it; Tron base58) or mint (Solana) */
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  enabled: boolean;
  icon?: string;
  isPotentialScam?: boolean;
  groups?: string[];
  /** Solana short code */
  mint?: string;
}

/** what the Home assets list, Send and Receive need about an asset */
export interface TokenAsset {
  key: string;
  name: string;
  symbol: string;
  decimals: number;
  balance: bigint;
  /** price API base (crypto.ETH, evm.0x…, sol.…, trx.…) */
  api: string;
  icon?: string;
  /** token contract/mint (absent for the native coin) */
  address?: string;
  isNative: boolean;
  isPotentialScam?: boolean;
  groups?: string[];
}

const HOMOGLYPHS: Record<string, string> = {"А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "У": "Y", "Х": "X", "а": "a", "в": "b", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x", "Ѕ": "S", "ѕ": "s", "І": "I", "і": "i", "Ј": "J", "ј": "j", "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X", "α": "a", "β": "b", "ε": "e", "ζ": "z", "η": "h", "ι": "i", "κ": "k", "μ": "m", "ν": "n", "ο": "o", "ρ": "p", "τ": "t", "υ": "y", "χ": "x"};

export function normalizeHomoglyphs(s: string): string {
  let out = '';
  for (const ch of s) out += HOMOGLYPHS[ch] ?? ch;
  return out;
}

const SUSPICIOUS_MARKERS = ['t.me', '.me', 'telegram', 'http', 'https', '.com', '.org', '.top', '.live', '.xyz', 'www', '🎁', 'airdrop', 'distribution'];
const SUSPICIOUS_WORD = /\b(bot|claim|reward)\b/i;

export function hasSuspiciousData(normalized: string): boolean {
  const lower = normalized.toLowerCase();
  return SUSPICIOUS_MARKERS.some((m) => lower.includes(m)) || SUSPICIOUS_WORD.test(lower);
}

/** native symbols of other chains that a token must not impersonate */
export const FOREIGN_NATIVE_SYMBOLS = new Set(['ICP', 'SOL', 'TRX', 'ATOM', 'DOT', 'ADA', 'XRP', 'XLM', 'XMR', 'ALGO', 'NEAR', 'TON', 'HBAR', 'APT', 'SUI', 'KAS']);

export function isTokenPropertiesSuspicious(t: { name: string; symbol: string; address: string }, o: { nativeSymbol: string; whitelist: Set<string>; defaultSymbols: Set<string>; foreignNatives?: Set<string> }): boolean {
  const whitelisted = o.whitelist.has(t.address.toLowerCase());
  const name = normalizeHomoglyphs(t.name.trim().toUpperCase());
  const symbol = normalizeHomoglyphs(t.symbol.trim().toUpperCase());
  if (hasSuspiciousData(name) || hasSuspiciousData(symbol)) return true;
  if (whitelisted) return false;
  return symbol === o.nativeSymbol.toUpperCase() || o.defaultSymbols.has(symbol) || (o.foreignNatives ?? FOREIGN_NATIVE_SYMBOLS).has(symbol);
}

const ICON_BY_TITLE = new Map<string, string>();
for (const c of CURRENCY_DEFS) if (c.iconPath && !ICON_BY_TITLE.has(c.title.toUpperCase())) ICON_BY_TITLE.set(c.title.toUpperCase(), c.iconPath);

/** default-token icon rule: own icon, else the CryptoCurrency.all icon with the same title */
export function tokenIcon(symbol: string, own?: string): string | undefined {
  if (own) return own;
  return ICON_BY_TITLE.get(symbol.toUpperCase());
}

/** wallets with token lists (EVM, Solana, Tron): what Home settings / Edit token use */
export interface TokenWallet {
  readonly tokens: WalletToken[];
  /** "ERC-20" / "BEP-20" / "SPL" / "TRC-20" */
  readonly tokenStandard: string;
  assetList(): TokenAsset[];
  isDefaultToken(address: string): boolean;
  validateTokenAddress(address: string): boolean;
  isSuspiciousToken(t: { name: string; symbol: string; address: string }): boolean;
  tokenInfo(address: string): Promise<{ name: string; symbol: string; decimals: number; icon?: string } | null>;
  /** true when the contract looks risky (unverified / flagged); unknown counts as risky */
  checkContractRisk(address: string): Promise<boolean>;
  /** Solana: verified on Jupiter (counts as trusted) */
  isVerifiedToken?(address: string): Promise<boolean>;
  addToken(t: WalletToken): Promise<void>;
  deleteToken(address: string): Promise<void>;
  setTokenEnabled(address: string, enabled: boolean): Promise<void>;
}

export function isTokenWallet(w: unknown): w is TokenWallet {
  return !!w && typeof (w as TokenWallet).assetList === 'function' && Array.isArray((w as TokenWallet).tokens);
}
