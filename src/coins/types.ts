// Wallet types and currencies, as defined by Cake Wallet
// (cw_core/lib/wallet_type.dart, currency_for_wallet_type.dart, crypto_currency.dart).

import { CURRENCY_DEFS, SCHEME_CURRENCY, type CurrencyDef } from './currencies.gen.ts';

export type WalletType =
  | 'monero' | 'bitcoin' | 'litecoin' | 'haven' | 'ethereum' | 'nano' | 'banano' | 'bitcoinCash' | 'polygon' | 'solana'
  | 'tron' | 'wownero' | 'zano' | 'decred' | 'dogecoin' | 'base' | 'arbitrum' | 'zcash' | 'bsc' | 'robinhood';

/** tool/configure.dart availableWalletTypes for the Cake Wallet build, in UI order */
export const AVAILABLE_WALLET_TYPES: WalletType[] = [
  'monero', 'bitcoin', 'ethereum', 'bsc', 'robinhood', 'solana', 'zcash', 'tron', 'dogecoin', 'bitcoinCash', 'litecoin', 'base', 'arbitrum', 'polygon', 'nano', 'decred',
];

/** serializeToInt (WalletInfo.type) */
export const WALLET_TYPE_INT: Record<WalletType, number> = {
  monero: 0, bitcoin: 1, litecoin: 2, haven: 3, ethereum: 4, nano: 5, banano: 6, bitcoinCash: 7, polygon: 8, solana: 9, tron: 10,
  wownero: 11, zano: 12, decred: 13, dogecoin: 14, base: 15, arbitrum: 16, zcash: 17, bsc: 18, robinhood: 19,
};

export const EVM_WALLET_TYPES: WalletType[] = ['ethereum', 'polygon', 'base', 'arbitrum', 'bsc', 'robinhood'];
export const ELECTRUM_WALLET_TYPES: WalletType[] = ['bitcoin', 'litecoin', 'bitcoinCash', 'dogecoin'];

export function isEvm(t: WalletType): boolean {
  return EVM_WALLET_TYPES.includes(t);
}

export function isElectrum(t: WalletType): boolean {
  return ELECTRUM_WALLET_TYPES.includes(t);
}

export const WALLET_TYPE_NAME: Record<WalletType, string> = {
  monero: 'Monero', bitcoin: 'Bitcoin', litecoin: 'Litecoin', haven: 'Haven', ethereum: 'Ethereum', bitcoinCash: 'Bitcoin Cash', nano: 'Nano',
  banano: 'Banano', polygon: 'Polygon', solana: 'Solana', tron: 'Tron', wownero: 'Wownero', zano: 'Zano', decred: 'Decred', dogecoin: 'Dogecoin',
  base: 'Base', arbitrum: 'Arbitrum', zcash: 'Zcash', bsc: 'BNB Smart Chain', robinhood: 'Robinhood Chain',
};

export const WALLET_TYPE_TICKER: Record<WalletType, string> = {
  monero: 'XMR', bitcoin: 'BTC', litecoin: 'LTC', haven: 'XHV', ethereum: 'ETH', bitcoinCash: 'BCH', nano: 'XNO', banano: 'BAN', polygon: 'POL',
  solana: 'SOL', tron: 'TRX', wownero: 'WOW', zano: 'ZANO', decred: 'DCR', dogecoin: 'DOGE', base: '', arbitrum: 'ARB', zcash: 'ZEC', bsc: 'BNB', robinhood: '',
};

/** walletTypeToCryptoCurrency -> CryptoCurrency key */
export const WALLET_CURRENCY: Record<WalletType, string> = {
  monero: 'xmr', bitcoin: 'btc', litecoin: 'ltc', haven: 'xhv', ethereum: 'eth', base: 'baseEth', arbitrum: 'arbEth', bsc: 'bnb', robinhood: 'robEth',
  bitcoinCash: 'bch', nano: 'nano', banano: 'banano', polygon: 'maticpoly', solana: 'sol', tron: 'trx', wownero: 'wow', zano: 'zano', decred: 'dcr',
  dogecoin: 'doge', zcash: 'zec',
};

export interface Currency extends CurrencyDef {}

const byKey = new Map<string, Currency>(CURRENCY_DEFS.map((c) => [c.key, c]));
const byRaw = new Map<number, Currency>(CURRENCY_DEFS.map((c) => [c.raw, c]));

export const ALL_CURRENCIES: Currency[] = CURRENCY_DEFS.filter((c) => c.inAll);

export function currency(key: string): Currency {
  const c = byKey.get(key);
  if (!c) throw new Error(`Unknown currency ${key}`);
  return c;
}

export function currencyByRaw(raw: number): Currency | undefined {
  return byRaw.get(raw);
}

export function walletCurrency(t: WalletType): Currency {
  return currency(WALLET_CURRENCY[t]);
}

/** CryptoCurrency.fromString(name, walletCurrency) */
export function currencyFromString(name: string, wallet?: Currency): Currency | undefined {
  const scheme = SCHEME_CURRENCY[name.toLowerCase()];
  if (scheme) return byKey.get(scheme);
  const n = name.toLowerCase();
  const t = ALL_CURRENCIES.find((c) => c.title.toLowerCase() === n && (c.tag === null || c.tag === name || c.tag === wallet?.title || c.tag === wallet?.tag));
  if (t) return t;
  const f = ALL_CURRENCIES.find((c) => c.fullName?.toLowerCase() === n);
  if (f) return f;
  return CURRENCY_DEFS.find((c) => c.name === n);
}

/** cryptoCurrencyOrTokenToWalletType */
export function walletTypeForCurrency(c: Currency): WalletType | undefined {
  const direct = (Object.entries(WALLET_CURRENCY) as [WalletType, string][]).find(([, k]) => k === c.key)?.[0];
  if (c.key === 'btcln') return 'bitcoin';
  if (c.key === 'arb') return 'arbitrum';
  if (c.tag === 'BSC') return 'bsc';
  if (c.tag && c.tag !== 'LN') {
    const base = currencyFromString(c.tag);
    if (base) return (Object.entries(WALLET_CURRENCY) as [WalletType, string][]).find(([, k]) => k === base.key)?.[0];
  }
  return direct;
}

/** The asset URL for a Cake asset path ("assets/new-ui/…" -> res/pictures, "assets/images/…"). */
export function assetUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined;
  if (path.startsWith('assets/new-ui/')) return `./cake/new-ui/${path.slice('assets/new-ui/'.length)}`;
  if (path.startsWith('assets/images/')) return `./cake/images/${path.slice('assets/images/'.length)}`;
  return path;
}

export function currencyIcon(c: Currency | undefined): string | undefined {
  return assetUrl(c?.iconPath);
}

/** Title with network tag, as Cake shows it in pickers ("USDT (ETH)"). */
export function currencyLabel(c: Currency): string {
  return c.tag ? `${c.title} (${c.tag})` : c.title;
}
