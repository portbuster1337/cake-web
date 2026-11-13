// Swap currencies: Cake's CryptoCurrency for the exchange — the built-in
// currencies (cw_core/lib/crypto_currency.dart) and tokens (Erc20Token,
// SPLToken, TronToken). Built-ins are compared by identity, tokens by their
// contract/mint address (erc20_token.dart:189); "same title and tag" is a
// separate, looser check (titleAndTagEqual).

import { ALL_CURRENCIES, currency, currencyFromString, walletTypeForCurrency, type Currency, type WalletType } from '../coins/types.ts';
import { EVM_DEFAULT_TOKENS, EVM_TOKEN_TAGS, SPL_DEFAULT_TOKENS, TRON_DEFAULT_TOKENS } from '../coins/tokens.gen.ts';
import { tokenIcon, type WalletToken } from '../coins/tokens.ts';
import { CURRENCY_DEFS } from '../coins/currencies.gen.ts';

export interface SwapCurrency {
  /** the built-in currency key ("xmr", "usdterc20"), or "<TAG>:<address>" for a token */
  id: string;
  title: string;
  tag: string | null;
  /** CryptoCurrency.name (lower-case symbol for EVM tokens, the mint for SPL tokens) */
  name: string;
  fullName: string | null;
  decimals: number;
  iconPath: string | null;
  chainIconPath: string | null;
  /** token contract / mint (as the token list writes it); absent for built-ins */
  address?: string;
  groups: string[];
}

const byKey = new Map(CURRENCY_DEFS.map((c) => [c.key, c]));

export function fromCurrency(c: Currency): SwapCurrency {
  return { id: c.key, title: c.title, tag: c.tag, name: c.name, fullName: c.fullName, decimals: c.decimals, iconPath: c.iconPath, chainIconPath: c.chainIconPath, groups: c.groups };
}

export function builtin(key: string): SwapCurrency {
  return fromCurrency(currency(key));
}

/** the built-in Currency behind a swap currency (none for tokens) */
export function builtinOf(c: SwapCurrency | undefined | null): Currency | undefined {
  return c && !c.address ? byKey.get(c.id) : undefined;
}

export function isToken(c: SwapCurrency): boolean {
  return !!c.address;
}

/** Erc20Token / SPLToken / TronToken: title = upper-case symbol, tag = the chain */
export function fromToken(t: Pick<WalletToken, 'symbol' | 'name' | 'address' | 'decimals' | 'icon' | 'groups'>, tag: string): SwapCurrency {
  return {
    id: `${tag}:${t.address.toLowerCase()}`,
    title: t.symbol.toUpperCase(),
    tag,
    name: tag === 'SOL' ? t.address.toLowerCase() : t.symbol.toLowerCase(),
    fullName: t.name,
    decimals: t.decimals,
    iconPath: t.icon ?? tokenIcon(t.symbol) ?? null,
    chainIconPath: null,
    address: t.address,
    groups: t.groups ?? [],
  };
}

/** == : identity for built-ins, the address for tokens */
export function eqCurrency(a: SwapCurrency | null | undefined, b: SwapCurrency | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.address || b.address) return !!a.address && !!b.address && a.address.toLowerCase() === b.address.toLowerCase();
  return a.id === b.id;
}

/** CryptoCurrency.titleAndTagEqual */
export function titleTagEqual(a: SwapCurrency, b: SwapCurrency): boolean {
  return a.title === b.title && a.tag === b.tag;
}

export function isBuiltin(c: SwapCurrency, key: string): boolean {
  return !c.address && c.id === key;
}

/** CryptoCurrency.network */
export function networkOf(c: SwapCurrency): string {
  return c.tag ?? c.title;
}

/** cryptoCurrencyOrTokenToWalletType (cw_core/lib/wallet_type.dart) */
export function walletTypeOf(c: SwapCurrency): WalletType | undefined {
  const b = builtinOf(c);
  if (b) return walletTypeForCurrency(b);
  if (c.tag === 'BSC') return 'bsc';
  if (c.tag && c.tag !== 'LN') {
    const base = currencyFromString(c.tag);
    return base ? walletTypeForCurrency(base) : undefined;
  }
  return undefined;
}

/** _getCurrencyChainIconPath: the currency's chain badge, else that of its tag's currency */
export function chainIconOf(c: SwapCurrency): string | null {
  if (c.chainIconPath) return c.chainIconPath;
  if (c.tag) return currencyFromString(c.tag)?.chainIconPath ?? null;
  return null;
}

export type MemoLabelType = 'destinationTag' | 'memo';

/** currencies_with_memo.dart */
export function memoLabelType(c: SwapCurrency): MemoLabelType | null {
  if (c.address) return null;
  if (c.id === 'xrp') return 'destinationTag';
  if (c.id === 'xlm' || c.id === 'ton' || c.id === 'eos' || c.id === 'hbar') return 'memo';
  return null;
}

/** amount_parsing_proxy.dart getCryptoSymbol (no satoshi display here): the title, cut to 8 characters */
export function symbolOf(c: SwapCurrency): string {
  return c.title.length > 8 ? c.title.slice(0, 8) : c.title;
}

// ------------------------------------------------------------------ lists --

/** _listContainsToken: the same token, or a built-in with its title and its tag (or no tag at all) */
function listContains(list: SwapCurrency[], t: SwapCurrency): boolean {
  return list.some((item) => (item.address ? item.address.toLowerCase() === t.address!.toLowerCase() : item.title.toUpperCase() === t.title.toUpperCase() && (item.tag?.toUpperCase() === t.tag?.toUpperCase() || item.tag === null)));
}

export interface UserTokens {
  evm: { type: WalletType; tokens: WalletToken[] }[];
  sol: WalletToken[][];
  trx: WalletToken[][];
}

/**
 * depositCurrencies / receiveCurrencies (exchange_view_model.dart:197-208, token_utilities.dart): CryptoCurrency.all
 * without BTT, then the EVM tokens (every chain's defaults, then the enabled tokens of every EVM wallet), the SPL
 * tokens and the TRC-20 tokens that the list does not have yet.
 */
export function swapCurrencies(user: UserTokens = { evm: [], sol: [], trx: [] }): SwapCurrency[] {
  const list = ALL_CURRENCIES.filter((c) => c.key !== 'btt').map(fromCurrency);
  const add = (tokens: SwapCurrency[]) => {
    const seen = new Set<string>();
    const fresh: SwapCurrency[] = [];
    for (const t of tokens) {
      const key = `${t.tag}|${t.address!.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        if (!listContains(list, t)) fresh.push(t);
      }
    }
    list.push(...fresh);
  };
  const evm: SwapCurrency[] = [];
  for (const [type, tokens] of Object.entries(EVM_DEFAULT_TOKENS)) for (const t of tokens) evm.push(fromToken(t, EVM_TOKEN_TAGS[type]));
  for (const w of user.evm) for (const t of w.tokens) if (t.enabled) evm.push(fromToken(t, EVM_TOKEN_TAGS[w.type]));
  add(evm);
  add([...SPL_DEFAULT_TOKENS.map((t) => fromToken(t, 'SOL')), ...user.sol.flat().filter((t) => t.enabled).map((t) => fromToken(t, 'SOL'))]);
  add([...TRON_DEFAULT_TOKENS.map((t) => fromToken(t, 'TRX')), ...user.trx.flat().filter((t) => t.enabled).map((t) => fromToken(t, 'TRX'))]);
  return list;
}

/**
 * CryptoCurrency.safeParseCurrencyFromString: a currency named by a provider (title, network tag) as a built-in;
 * null when nothing matches.
 */
export function parseSwapCurrency(raw: string, tag?: string | null): SwapCurrency | null {
  if (!raw) return null;
  let t = (tag ?? '').trim();
  if (t.toLowerCase() === 'lightning') t = 'LN';
  const all = ALL_CURRENCIES;
  if (t) {
    const c = all.find((x) => x.title.toLowerCase() === raw.toLowerCase() && (x.tag ?? '').toLowerCase() === t.toLowerCase());
    return c ? fromCurrency(c) : null;
  }
  const same = all.find((x) => x.title.toLowerCase() === raw.toLowerCase() && (x.tag ?? '').toLowerCase() === raw.toLowerCase());
  if (same) return fromCurrency(same);
  const f = currencyFromString(raw) ?? currencyFromString(raw.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  return f ? fromCurrency(f) : null;
}
