// AnyPay (lib/core/anypay/*, lib/core/universal_address_detector.dart): what a pasted, scanned or
// linked payment request is for — this wallet, another network's wallet (switch to it, or swap to
// it), an EVM network still to be picked — and which token it asks for.

import { parsePaymentRequest, type PaymentRequest } from '../core/paymentUri.ts';
import { currency, currencyFromString, isEvm, walletCurrency, walletTypeForCurrency, WALLET_CURRENCY, type WalletType } from '../coins/types.ts';
import { isValidAddressFor } from '../core/addressValidator.ts';
import { EVM_CHAINS, chainById } from '../coins/evm/chains.ts';
import { EVM_DEFAULT_TOKENS, SPL_DEFAULT_TOKENS, TRON_DEFAULT_TOKENS } from '../coins/tokens.gen.ts';
import type { WalletInfo } from '../core/wallet.ts';

// --------------------------------------------------------------- detection --

/** AddressDetectionResult */
export interface Detection {
  address: string;
  /** a currency key */
  currency: string | null;
  walletType: WalletType | null;
  isValid: boolean;
  chainId?: number;
}

const B58 = 'a-km-zA-HJ-NP-Z1-9';
const BECH = 'ac-hj-np-z02-9';
/** _detectFromRawAddress's patterns, most specific first */
const RAW_PATTERNS: [RegExp, string][] = [
  [/^(lightning:)?(lnbc|lntb|lnbs|lnbcrt)[a-z0-9]+$/i, 'btcln'],
  [/^(lightning:)?(lno1)[a-z0-9]+$/i, 'btcln'],
  [/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, 'btcln'],
  [/^(lightning:)?(lnurl)[a-z0-9]+$/i, 'btcln'],
  [new RegExp(`^(?:1[${B58}]{25,34}|3[${B58}]{25,34}|(?:bc|tb)1q[${BECH}]{25,39}|(?:bc|tb)1p(?:[${BECH}]{39}|[${BECH}]{59}|[${BECH}]{8,89})|(?:bc|tb)1q[${BECH}]{40,80}|sp1[0-9a-zA-Z]{113}|(tsp|sprt)1[0-9a-zA-Z]{113})$`), 'btc'],
  [new RegExp(`^(?:L[${B58}]{25,34}|[3M][${B58}]{25,34}|ltc1q[${BECH}]{25,39}|ltc1p(?:[${BECH}]{39}|[${BECH}]{59}|[${BECH}]{8,89})|ltc1q[${BECH}]{40,80}|(ltc|t)mweb1q[${BECH}]{90,120})$`), 'ltc'],
  [/^([qp])[a-z0-9]{41}$/, 'bch'],
  [/^0x[a-fA-F0-9]{40}$/, 'eth'],
  [new RegExp(`^nano_[${B58}]{60}$`), 'nano'],
  [new RegExp(`^ban_[${B58}]{60}$`), 'banano'],
  [new RegExp(`^T[${B58}]{33}$`), 'trx'],
  [/^@[\w\d.-]+$/, 'zano'],
  [new RegExp(`^4[${B58}]{94}$`), 'xmr'],
  [new RegExp(`^8[${B58}]{94}$`), 'xmr'],
  [new RegExp(`^W[${B58}]{96}$`), 'wow'],
  [new RegExp(`^Z[${B58}]{96}$`), 'zano'],
  [new RegExp(`^([DTS])[ksecS][${B58}]+$`), 'dcr'],
  [new RegExp(`^D[${B58}]{25,34}$`), 'doge'],
  [/^(?:t1[0-9A-Za-z]{33}|t3[0-9A-Za-z]{33}|zs[a-z0-9]{76}|u1[a-z0-9]{1,300})$/, 'zec'],
  [/^[1-9A-HJ-NP-Za-km-z]{43,44}$/, 'sol'],
];

/** getChainIdByCryptoCurrency */
export function chainIdOfCurrency(key: string): number | undefined {
  return Object.values(EVM_CHAINS).find((c) => c.currency === key)?.chainId;
}

/** getCryptoCurrencyByChainId (an unknown chain counts as Ethereum's) */
const currencyOfChain = (chainId: number) => chainById(chainId)?.currency ?? 'eth';

const typeOfCurrency = (key: string): WalletType | null => {
  try {
    return walletTypeForCurrency(currency(key)) ?? null;
  } catch {
    return null;
  }
};

/** UniversalAddressDetector.detectAddress: a payment URI's scheme, else the address's form */
export function detectAddress(input: string): Detection {
  const s = input.trim();
  if (!s) return { address: '', currency: null, walletType: null, isValid: false };
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s);
  if (m && !/\s/.test(s)) {
    const pr = parsePaymentRequest(s);
    const scheme = m[1].toLowerCase();
    let key: string | null = null;
    let chainId: number | undefined;
    if (scheme === 'ethereum') {
      chainId = pr.chainId ?? 1;
      key = currencyOfChain(chainId);
    } else {
      const c = currencyFromString(scheme);
      if (c) {
        key = c.key;
        chainId = chainIdOfCurrency(c.key);
      }
    }
    if (key) return { address: pr.address, currency: key, walletType: typeOfCurrency(key), isValid: true, chainId };
  }
  for (const [re, pattern] of RAW_PATTERNS) {
    if (!re.test(s)) continue;
    // Decred's pattern also takes Dogecoin addresses beginning "DS" (Cake checks it first)
    const key = pattern === 'dcr' && isValidAddressFor(walletCurrency('dogecoin'), s) ? 'doge' : pattern;
    return { address: s, currency: key, walletType: typeOfCurrency(key), isValid: true, chainId: chainIdOfCurrency(key) };
  }
  return { address: s, currency: null, walletType: null, isValid: false };
}

// ----------------------------------------------------------------- request --

export type ChainBinding = { kind: 'explicit'; chainId: number } | { kind: 'chainless' } | { kind: 'none' };

export interface AnyPayRequest {
  rawInput: string;
  pr: PaymentRequest;
  detection: Detection;
  binding: ChainBinding;
}

export const hasContract = (r: AnyPayRequest) => !!r.pr.contract;

function bindingFor(pr: PaymentRequest): ChainBinding {
  const scheme = pr.scheme.toLowerCase();
  if (scheme === 'ethereum') return pr.chainId !== undefined ? { kind: 'explicit', chainId: pr.chainId } : { kind: 'chainless' };
  if (scheme) {
    const c = currencyFromString(scheme);
    const id = c ? chainIdOfCurrency(c.key) : undefined;
    if (id !== undefined) return { kind: 'explicit', chainId: id };
  }
  return { kind: 'none' };
}

/** AnyPayParser.fromRaw */
export function requestFromRaw(input: string): AnyPayRequest {
  const pr = parsePaymentRequest(input);
  return { rawInput: input, pr, detection: detectAddress(input), binding: bindingFor(pr) };
}

/** AnyPayParser._reconstructRawInput (ERC681URI.toString for Ethereum) */
export function rawInputOf(pr: PaymentRequest): string {
  const scheme = pr.scheme.toLowerCase();
  if (!scheme || scheme === 'lightning') return pr.address;
  if (scheme === 'ethereum') {
    const params: string[] = [];
    if (pr.contract) {
      params.push(`address=${pr.address}`);
      if (pr.rawTokenAmount) params.push(`uint256=${pr.rawTokenAmount}`);
      if (pr.amount) params.push(`amount=${pr.amount.replace(',', '.')}`);
    } else if (pr.amount) params.push(`value=${Number(pr.amount.replace(',', '.'))}e18`);
    return `ethereum:${pr.contract ?? pr.address}@${pr.chainId ?? 1}${pr.contract ? '/transfer' : ''}${params.length ? `?${params.join('&')}` : ''}`;
  }
  return `${pr.scheme}:${pr.address}${pr.amount ? `?amount=${pr.amount}` : ''}`;
}

/** AnyPayParser.fromPaymentRequest */
export function requestFromPaymentRequest(pr: PaymentRequest): AnyPayRequest {
  const raw = rawInputOf(pr);
  return { rawInput: raw, pr, detection: detectAddress(raw), binding: bindingFor(pr) };
}

/** AnyPayService.evaluateForEvmChain: the same request, bound to a chain */
export const boundToChain = (r: AnyPayRequest, chainId: number): AnyPayRequest => ({ ...r, binding: { kind: 'explicit', chainId } });

// ------------------------------------------------------------------ tokens --

export interface AnyPayToken {
  walletType: WalletType;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  icon?: string;
}

/** findTokenByAddress: a network's tokens (the wallet's own first, then the default list) */
export type TokenLookup = (walletType: WalletType, address: string) => AnyPayToken | null;

/** the default token lists */
export const defaultTokenLookup: TokenLookup = (walletType, address) => {
  const list = isEvm(walletType) ? EVM_DEFAULT_TOKENS[walletType] ?? [] : walletType === 'solana' ? SPL_DEFAULT_TOKENS : walletType === 'tron' ? TRON_DEFAULT_TOKENS : [];
  const a = address.toLowerCase();
  const t = list.find((x) => x.address.toLowerCase() === a);
  return t ? { walletType, address: t.address, symbol: t.symbol, name: t.name, decimals: t.decimals, icon: t.icon } : null;
};

/** PaymentRequest.resolveTokenAmount: the amount, else the raw amount in the token's decimals (old QRs: 18) */
export function resolveTokenAmount(pr: PaymentRequest, decimals: number): string | undefined {
  if (pr.amount) return pr.amount;
  if (!pr.rawTokenAmount || !/^\d+$/.test(pr.rawTokenAmount)) return undefined;
  const raw = BigInt(pr.rawTokenAmount);
  const d = decimals !== 18 && raw > 10n ** BigInt(decimals + 9) ? 18 : decimals;
  const w = raw / 10n ** BigInt(d);
  const f = (raw % 10n ** BigInt(d)).toString().padStart(d, '0').replace(/0+$/, '');
  return f ? `${w}.${f}` : w.toString();
}

export type Resolution = { kind: 'none' } | { kind: 'resolved'; token: AnyPayToken; chainId?: number; amountOverride?: string } | { kind: 'unknown'; contract: string };

/** the wallets and networks at hand (WalletSnapshot) */
export interface Snapshot {
  type: WalletType;
  /** the current EVM wallet's chain */
  currentChainId: number | null;
  wallets: WalletInfo[];
}

const evmChainIds = () => Object.values(EVM_CHAINS).map((c) => c.chainId);
const typeOfChain = (chainId: number): WalletType | undefined => chainById(chainId)?.type;

/** AnyPayRouter.requestedEvmChainId: the request's chain; a chainless one is the current EVM chain (EIP-681), else mainnet */
export function requestedEvmChainId(r: AnyPayRequest, s: Snapshot): number | null {
  if (r.binding.kind === 'explicit') return r.binding.chainId;
  if (r.binding.kind === 'chainless') return s.currentChainId ?? 1;
  return null;
}

/** AnyPayResolver.resolve */
export function resolveToken(r: AnyPayRequest, s: Snapshot, lookup: TokenLookup): Resolution {
  const contract = r.pr.contract;
  if (!contract) return { kind: 'none' };
  const detected = r.detection.walletType;
  if (detected && isEvm(detected)) {
    const chainId = requestedEvmChainId(r, s) ?? 1;
    const type = typeOfChain(chainId);
    const found = type ? lookup(type, contract) : null;
    if (found) return { kind: 'resolved', token: found, chainId, amountOverride: resolveTokenAmount(r.pr, found.decimals) };
    // old QRs omit mainnet's chain id: the contract may be another network's
    if (r.binding.kind === 'chainless') {
      for (const id of evmChainIds()) {
        if (id === chainId) continue;
        const t = lookup(typeOfChain(id)!, contract);
        if (t) return { kind: 'resolved', token: t, chainId: id, amountOverride: resolveTokenAmount(r.pr, t.decimals) };
      }
    }
    return { kind: 'unknown', contract };
  }
  const token = lookup(detected ?? s.type, contract);
  return token ? { kind: 'resolved', token, amountOverride: resolveTokenAmount(r.pr, token.decimals) } : { kind: 'unknown', contract };
}

// ---------------------------------------------------------------- decision --

export type Decision =
  | { kind: 'current'; token?: AnyPayToken; amountOverride?: string; fallbackCurrency?: string }
  | { kind: 'evmChoice' }
  | { kind: 'crossChain'; targetWalletType: WalletType; targetChainId?: number; wallets: WalletInfo[]; token?: AnyPayToken; amountOverride?: string; canSwap: boolean }
  | { kind: 'unsupportedNetwork'; chainId: number }
  | { kind: 'unsupportedToken'; contract: string }
  | { kind: 'empty' };

/** silent payment and MWEB addresses cannot receive a swap */
const SWAP_INCOMPATIBLE = [/^sp1[0-9a-zA-Z]{113}$/, /^(tsp|sprt)1[0-9a-zA-Z]{113}$/, /^(ltc|t)mweb1q[ac-hj-np-z02-9]{90,120}$/];

/** _nativeRequestCurrency: a URI asking for an amount of the network's coin */
const nativeRequestCurrency = (r: AnyPayRequest) => (!r.pr.scheme || hasContract(r) || !r.pr.amount ? undefined : r.detection.currency ?? undefined);

const tokenFields = (res: Resolution) => (res.kind === 'resolved' ? { token: res.token, amountOverride: res.amountOverride } : {});

/** AnyPayRouter.route */
export function route(r: AnyPayRequest, s: Snapshot, res: Resolution): Decision {
  if (!r.rawInput.trim()) return { kind: 'empty' };
  const detected = r.detection.walletType;
  if (!r.detection.isValid || !detected) return { kind: 'current' };
  if (isEvm(detected)) return routeEvm(r, s, res);
  if (res.kind === 'unknown') return { kind: 'unsupportedToken', contract: res.contract };
  if (detected === s.type) return { kind: 'current', ...tokenFields(res), fallbackCurrency: nativeRequestCurrency(r) };
  return { kind: 'crossChain', targetWalletType: detected, wallets: s.wallets.filter((w) => w.type === detected), ...tokenFields(res), canSwap: !SWAP_INCOMPATIBLE.some((re) => re.test(r.pr.address)) };
}

function routeEvm(r: AnyPayRequest, s: Snapshot, res: Resolution): Decision {
  const requested = requestedEvmChainId(r, s);
  if (requested === null) return isEvm(s.type) ? { kind: 'current' } : { kind: 'evmChoice' };
  if (!typeOfChain(requested)) return { kind: 'unsupportedNetwork', chainId: requested };
  if (res.kind === 'unknown') return { kind: 'unsupportedToken', contract: res.contract };
  const target = res.kind === 'resolved' && res.chainId !== undefined ? res.chainId : requested;
  if (isEvm(s.type) && s.currentChainId === target) return { kind: 'current', ...tokenFields(res), fallbackCurrency: nativeRequestCurrency(r) };
  const type = typeOfChain(target)!;
  return { kind: 'crossChain', targetWalletType: type, targetChainId: target, wallets: s.wallets.filter((w) => w.type === type), ...tokenFields(res), canSwap: true };
}

/** AnyPayService._evaluate */
export function evaluate(r: AnyPayRequest, s: Snapshot, lookup: TokenLookup = defaultTokenLookup): Decision {
  try {
    return route(r, s, resolveToken(r, s, lookup));
  } catch {
    return { kind: 'current' };
  }
}

/** AnyPayFlow.handleEvaluation: an alias (name@host) is not AnyPay's; Ethereum URIs carry @chainId */
export const isAliasInput = (r: AnyPayRequest) => !r.rawInput.toLowerCase().startsWith('ethereum:') && (r.rawInput.includes('@') || r.pr.address.includes('@'));

// -------------------------------------------------------------------- swap --

/** AnyPaySwapIntent: what the swap is to deliver, and where */
export interface SwapIntent {
  recipientAddress: string;
  targetWalletType: WalletType;
  /** the network's coin (a currency key), unless a token */
  receiveCurrency: string;
  token?: AnyPayToken;
  receiveAmount?: string;
}

/** AnyPayService.buildSwapIntent: the token, else the target chain's coin, else the detected currency */
export function swapIntent(r: AnyPayRequest, targetWalletType: WalletType, targetChainId?: number, token?: AnyPayToken): SwapIntent {
  const receiveCurrency = targetChainId !== undefined ? chainById(targetChainId)?.currency ?? WALLET_CURRENCY[targetWalletType] : r.detection.currency ?? WALLET_CURRENCY[targetWalletType];
  const receiveAmount = token ? resolveTokenAmount(r.pr, token.decimals) : r.pr.amount || undefined;
  return { recipientAddress: r.pr.address, targetWalletType, receiveCurrency, token, receiveAmount };
}
