// NEAR Intents 1Click (lib/exchange/provider/near_Intents_exchange_provider.dart):
// decentralized, fixed rate (EXACT_OUTPUT), no receive memo. Cake sends its own
// JWT and app fee; without them 1Click still quotes (with its default fee), so
// this build sends the user's JWT if one is set and never an app fee.

import { exFetch, toBaseUnits, tryJson, QUOTE_TIMEOUT_MS, dartDouble } from '../net.ts';
import { builtinOf, type SwapCurrency } from '../currency.ts';
import { apiKey } from '../keys.ts';
import { PROVIDERS, STATES, TradeNotCreatedError, type ExchangeProvider, type Limits, type Trade, type TradeState } from '../types.ts';

const BASE = 'https://1click.chaindefuser.com/v0';
const SLIPPAGE = 100;

interface NearToken {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  contractAddress?: string | null;
}

/** kNearDummyAddresses: placeholder refund/recipient addresses for dry quotes */
const DUMMY: Record<string, string> = {
  LTC: 'ltc1qhdwz74m3wuuhppv2mckagqk9e2e49z5j4kucnv',
  BTC: 'bc1qzwdt09dgr5nle2fkv7h5s6axgjqpdyp5g5tumz',
  DOGE: 'D9t7rGQ9mE3hJ2z1w8pGQxkGmKjYwYc8pQ',
  BCH: 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
  ETH: '0x1111111111111111111111111111111111111111',
  BSC: '0x1111111111111111111111111111111111111111',
  POL: '0x1111111111111111111111111111111111111111',
  AVAXC: '0x1111111111111111111111111111111111111111',
  ARB: '0x1111111111111111111111111111111111111111',
  BASE: '0x1111111111111111111111111111111111111111',
  ROB: '0x1111111111111111111111111111111111111111',
  SOL: '11111111111111111111111111111111',
  XRP: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
  TRX: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
  TON: 'UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c',
  XLM: 'GA3D5O2W7YQZJQ3H4Y5QW6N7V8X9Z0A1B2C3D4E5F6G7H8I9J0',
  ADA: 'addr1vyc33hdv5vag52f3d8h0qsngu52vm27x28zkzru333jma9gaxd38v',
  ZEC: 't1VdfFUbyTT7ZSdeEaHuwB7veGD1NXoUhGS',
};

const MEMO_DEPOSIT = new Set(['xrp', 'xlm', 'ton']);

function dummyAddress(c: SwapCurrency): string {
  const tag = (c.tag ?? '').trim().toUpperCase();
  return DUMMY[tag || c.title.toUpperCase()] ?? '';
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
  const k = apiKey('nearintents');
  if (k) h.Authorization = k;
  return h;
}

let tokens: NearToken[] = [];

/** _geSupportedTokens: fetched once (kept once non-empty) */
async function supportedTokens(): Promise<NearToken[]> {
  if (tokens.length) return tokens;
  try {
    const r = await exFetch(`${BASE}/tokens`, { headers: headers(), timeoutMs: QUOTE_TIMEOUT_MS, purpose: 'Near Intents tokens' });
    const list = tryJson<any[]>(r);
    if (Array.isArray(list)) tokens = list.filter((t) => typeof t?.assetId === 'string' && typeof t?.decimals === 'number').map((t) => ({ assetId: t.assetId, decimals: t.decimals, blockchain: String(t.blockchain ?? ''), symbol: String(t.symbol ?? ''), contractAddress: t.contractAddress ?? null }));
  } catch { /* [] */ }
  return tokens;
}

function chainFor(tag: string | null): string | null {
  switch (tag) {
    case 'TRX': return 'tron';
    case 'AVAXC': return 'avax';
    case 'ROB': return 'hood';
    default: return tag ? tag.toLowerCase() : null;
  }
}

/** currencyToNearAssetId */
function tokenFor(c: SwapCurrency, list: NearToken[]): NearToken | undefined {
  if (!list.length) return undefined;
  if (builtinOf(c)?.key === 'btc') return list.find((t) => t.assetId === '1cs_v1:btc:native:coin');
  const symbol = c.title.toUpperCase();
  const chain = chainFor(c.tag);
  const match = (t: NearToken) => t.symbol.toUpperCase() === symbol && (chain === null || t.blockchain.toLowerCase() === chain);
  return list.find((t) => match(t) && t.contractAddress == null) ?? list.find(match);
}

/** _nearAssetIdToCurrency: listed assets map back to a (title, tag) */
function listed(assetId: string, list: NearToken[]): boolean {
  return list.some((t) => t.assetId === assetId);
}

function deadline(): string {
  return new Date(Date.now() + 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');
}

async function quote(o: { dry: boolean; fixed: boolean; origin: string; destination: string; amount: string; refundTo: string; recipient: string; depositMode: string }): Promise<any | null> {
  const payload = {
    dry: o.dry,
    depositMode: o.depositMode,
    swapType: o.fixed ? 'EXACT_OUTPUT' : 'EXACT_INPUT',
    slippageTolerance: SLIPPAGE,
    originAsset: o.origin,
    depositType: 'ORIGIN_CHAIN',
    destinationAsset: o.destination,
    amount: o.amount,
    refundTo: o.refundTo,
    refundType: 'ORIGIN_CHAIN',
    recipient: o.recipient,
    recipientType: 'DESTINATION_CHAIN',
    deadline: deadline(),
  };
  try {
    const r = await exFetch(`${BASE}/quote`, { headers: headers(), body: payload, timeoutMs: o.dry ? QUOTE_TIMEOUT_MS : 60_000, retries: o.dry ? 1 : 0, purpose: o.dry ? 'Near Intents quote' : 'Near Intents order' });
    return r.status === 201 ? tryJson<any>(r) : null;
  } catch {
    return null;
  }
}

function stateFor(status: string): TradeState {
  switch (status.toUpperCase()) {
    case 'PENDING_DEPOSIT': return STATES.pending;
    case 'PROCESSING': return STATES.processing;
    case 'SUCCESS': return STATES.success;
    case 'INCOMPLETE_DEPOSIT': return STATES.underpaid;
    case 'REFUNDED': return STATES.refunded;
    case 'FAILED': return STATES.failed;
    default: return STATES.notFound;
  }
}

export const nearIntents: ExchangeProvider = {
  description: PROVIDERS.nearIntents,
  title: 'Near Intents',
  isAvailable: true,
  isEnabled: true,
  supportsFixedRate: true,
  supportsOnionAddress: false,
  supportsMemoOrDestinationTag: false,

  async checkIsAvailable() {
    return true;
  },

  async fetchLimits(from, to): Promise<Limits | null> {
    const list = await supportedTokens();
    if (!tokenFor(from, list) || !tokenFor(to, list)) throw new Error(`fetchLimits: unsupported currency pair: ${from.title} ${from.tag ?? ''} to ${to.title} ${to.tag ?? ''}`);
    return { min: null, max: null };
  },

  async fetchRate(from, to, amount, isFixedRateMode) {
    try {
      const list = await supportedTokens();
      const origin = tokenFor(from, list);
      const destination = tokenFor(to, list);
      if (!origin || !destination) return 0;
      const q = await quote({
        dry: true,
        fixed: isFixedRateMode,
        origin: origin.assetId,
        destination: destination.assetId,
        amount: toBaseUnits(dartDouble(amount), isFixedRateMode ? destination.decimals : origin.decimals),
        refundTo: dummyAddress(from),
        recipient: dummyAddress(to),
        depositMode: MEMO_DEPOSIT.has(builtinOf(from)?.key ?? '') ? 'MEMO' : 'SIMPLE',
      });
      if (!q) return 0;
      const amountIn = Number.parseFloat(String(q.quote?.amountInFormatted ?? '0')) || 0;
      const amountOut = Number.parseFloat(String(q.quote?.amountOutFormatted ?? '0')) || 0;
      return amountIn === 0 ? 0 : amountOut / amountIn;
    } catch {
      return 0;
    }
  },

  async createTrade(request, isFixedRateMode, isSendAll): Promise<Trade> {
    try {
      const list = await supportedTokens();
      const origin = tokenFor(request.fromCurrency, list);
      const destination = tokenFor(request.toCurrency, list);
      if (!origin || !destination) throw new Error('Unsupported currency pair');
      const amount = toBaseUnits(isFixedRateMode ? request.toAmount : request.fromAmount, isFixedRateMode ? request.toCurrency.decimals : request.fromCurrency.decimals);
      const q = await quote({ dry: false, fixed: isFixedRateMode, origin: origin.assetId, destination: destination.assetId, amount, refundTo: request.refundAddress, recipient: request.toAddress, depositMode: MEMO_DEPOSIT.has(builtinOf(request.fromCurrency)?.key ?? '') ? 'MEMO' : 'SIMPLE' });
      if (!q) throw new Error('Quote request failed');
      const qo = q.quote ?? {};
      const depositAddress = qo.depositAddress as string;
      if (typeof depositAddress !== 'string' || !depositAddress) throw new Error('No deposit address in quote response');
      const depositAmount = qo.amountInFormatted as string | undefined;
      if (depositAmount == null) throw new Error('Deposit amount is null in quote response');
      const qr = q.quoteRequest ?? {};
      if (!listed(String(qr.originAsset), list)) throw new Error(`Failed to parse from currency from assetId: ${qr.originAsset}`);
      if (!listed(String(qr.destinationAsset), list)) throw new Error(`Failed to parse to currency from assetId: ${qr.destinationAsset}`);
      return {
        id: depositAddress,
        from: request.fromCurrency,
        to: request.toCurrency,
        providerRaw: PROVIDERS.nearIntents.raw,
        providerName: 'Near Intents',
        stateRaw: STATES.created.raw,
        createdAt: Date.now(),
        inputAddress: depositAddress,
        payoutAddress: request.toAddress,
        refundAddress: request.refundAddress,
        amount: String(depositAmount),
        receiveAmount: qo.amountOutFormatted != null ? String(qo.amountOutFormatted) : undefined,
        memo: qo.depositMemo ?? undefined,
        isSendAll,
      };
    } catch (e) {
      throw new TradeNotCreatedError(PROVIDERS.nearIntents, (e as Error).message);
    }
  },

  async findTradeById(id) {
    const r = await exFetch(`${BASE}/status?${new URLSearchParams({ depositAddress: id })}`, { headers: headers(), purpose: 'Near Intents status' });
    if (r.status !== 200) throw new Error(`Near Intents fetch trade failed: ${r.status} ${r.text.slice(0, 200)}`);
    const d = r.json<any>();
    const status = String(d.status ?? 'UNKNOWN');
    const qr = d.quoteResponse?.quoteRequest ?? {};
    const q = d.quoteResponse?.quote ?? {};
    const swap = d.swapDetails ?? {};
    return {
      id,
      inputAddress: q.depositAddress ?? undefined,
      payoutAddress: qr.recipient ?? '',
      refundAddress: qr.refundTo ?? '',
      amount: String(swap.amountInFormatted ?? q.amountInFormatted ?? '0'),
      receiveAmount: swap.amountOutFormatted != null ? String(swap.amountOutFormatted) : q.amountOutFormatted != null ? String(q.amountOutFormatted) : undefined,
      stateRaw: stateFor(status).raw,
      txId: Array.isArray(swap.originChainTxHashes) && swap.originChainTxHashes[0]?.hash ? String(swap.originChainTxHashes[0].hash) : undefined,
      extraId: q.depositMemo ?? undefined,
      isRefund: status === 'REFUNDED',
    };
  },

  trackUrl(t) {
    return `https://explorer.near-intents.org/transactions/${t.id}`;
  },
};
