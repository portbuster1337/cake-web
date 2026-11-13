// XOSwap (Exodus) (lib/exchange/provider/xoswap_exchange_provider.dart): keyless
// (App-Name header), fixed rate through its rate tables, receive memos.

import { exFetch, tryJson, QUOTE_TIMEOUT_MS } from '../net.ts';
import type { SwapCurrency } from '../currency.ts';
import { PROVIDERS, TradeNotCreatedError, TradeNotFoundError, deserializeState, type ExchangeProvider, type Limits, type Trade } from '../types.ts';

const BASE = 'https://exchange.exodus.io/v3';
const HEADERS = { 'Content-Type': 'application/json', 'App-Name': 'cake-labs', 'App-Version': '6.5.3' };

const NETWORKS: Record<string, string> = {
  POL: 'matic', ETH: 'ethereum', BTC: 'bitcoin', BSC: 'bsc', SOL: 'solana', TRX: 'tronmainnet', ZEC: 'zcash', ADA: 'cardano', DOGE: 'dogecoin',
  XMR: 'monero', BCH: 'bcash', BSV: 'bitcoinsv', XRP: 'ripple', LTC: 'litecoin', EOS: 'eosio', XLM: 'stellar', BASE: 'basemainnet', ARB: 'arbitrum',
};

const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** _getAssets: a tag-less currency is its title; a token is looked up on its network */
async function assetId(c: SwapCurrency): Promise<string | null> {
  if (c.tag === null) return c.title;
  try {
    const net = NETWORKS[c.tag];
    if (!net) return null;
    const r = await exFetch(`${BASE}/assets?${new URLSearchParams({ networks: net, query: c.title })}`, { headers: HEADERS, timeoutMs: QUOTE_TIMEOUT_MS, purpose: 'XOSwap assets' });
    if (r.status !== 200) return null;
    const list = tryJson<any[]>(r);
    if (!Array.isArray(list)) return null;
    const a = list.find((x) => alnum(String(x?.symbol ?? '')) === c.title);
    return a ? String(a.id) : null;
  } catch {
    return null;
  }
}

async function pairId(from: SwapCurrency, to: SwapCurrency): Promise<string | null> {
  const [a, b] = await Promise.all([assetId(from), assetId(to)]);
  return a && b ? `${a}_${b}` : null;
}

async function ratesFor(from: SwapCurrency, to: SwapCurrency): Promise<any[]> {
  try {
    const id = await pairId(from, to);
    if (!id) return [];
    const r = await exFetch(`${BASE}/pairs/${id}/rates`, { headers: HEADERS, timeoutMs: QUOTE_TIMEOUT_MS, purpose: 'XOSwap rates' });
    if (r.status !== 200) return [];
    const j = tryJson<any[]>(r);
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

const num = (v: unknown) => Number.parseFloat(String(v));

export const xoSwap: ExchangeProvider = {
  description: PROVIDERS.xoSwap,
  title: 'XOSwap',
  isAvailable: true,
  isEnabled: true,
  supportsFixedRate: true,
  supportsOnionAddress: false,
  supportsMemoOrDestinationTag: true,

  async checkIsAvailable() {
    return true;
  },

  async fetchLimits(from, to): Promise<Limits | null> {
    const rates = await ratesFor(from, to);
    if (!rates.length) throw new Error(`No rates found for ${from.title} to ${to.title}`);
    let min = Infinity;
    let max = 0;
    for (const r of rates) {
      const lo = num(r.min?.value);
      const hi = num(r.max?.value);
      if (lo < min) min = lo;
      if (hi > max) max = hi;
    }
    return { min, max };
  },

  async fetchRate(from, to, amount, isFixedRateMode) {
    try {
      const rates = await ratesFor(from, to);
      if (!rates.length) return 0;
      if (!isFixedRateMode) {
        let best = 0;
        for (const r of rates) {
          if (amount >= num(r.min?.value) && amount <= num(r.max?.value)) {
            const out = amount * num(r.amount?.value) - num(r.minerFee?.value);
            if (out > best) best = out;
          }
        }
        return best > 0 ? best / amount : 0;
      }
      let bestInput = Infinity;
      for (const r of rates) {
        const required = (amount + num(r.minerFee?.value)) / num(r.amount?.value);
        if (required >= num(r.min?.value) && required <= num(r.max?.value) && required < bestInput) bestInput = required;
      }
      return bestInput < Infinity ? amount / bestInput : 0;
    } catch {
      return 0;
    }
  },

  async createTrade(request, _fixed, isSendAll): Promise<Trade> {
    try {
      const id = await pairId(request.fromCurrency, request.toCurrency);
      if (!id) throw new TradeNotCreatedError(PROVIDERS.xoSwap);
      const payload: Record<string, unknown> = {
        fromAmount: request.fromAmount,
        fromAddress: request.refundAddress,
        toAmount: request.toAmount,
        toAddress: request.toAddress,
        ...(request.toAddressExtraId ? { toAddressTag: request.toAddressExtraId } : {}),
        pairId: id,
      };
      const r = await exFetch(`${BASE}/orders`, { headers: HEADERS, body: payload, retries: 0, purpose: 'XOSwap order' });
      const j = tryJson<any>(r) ?? {};
      if (r.status !== 201) throw new Error(`${j.error ?? 'Unknown error'}\n${j.message ?? ''}`);
      const depositAmount = String(j.amount?.value);
      const parsed = Number.parseFloat(depositAmount);
      if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('Invalid deposit amount received from API');
      const created = Date.parse(String(j.createdAt));
      return {
        id: String(j.id),
        from: request.fromCurrency,
        to: request.toCurrency,
        providerRaw: PROVIDERS.xoSwap.raw,
        inputAddress: String(j.payInAddress),
        refundAddress: String(j.fromAddress),
        stateRaw: deserializeState(String(j.status)).raw,
        createdAt: Number.isFinite(created) ? created : Date.now(),
        amount: depositAmount,
        receiveAmount: String(j.toAmount?.value),
        payoutAddress: String(j.toAddress),
        extraId: j.payInAddressTag ?? undefined,
        isSendAll,
        toAddressExtraId: request.toAddressExtraId,
      };
    } catch (e) {
      if (e instanceof TradeNotCreatedError) throw e;
      throw new TradeNotCreatedError(PROVIDERS.xoSwap, (e as Error).message);
    }
  },

  async findTradeById(id) {
    const r = await exFetch(`${BASE}/orders/${encodeURIComponent(id)}`, { headers: HEADERS, purpose: 'XOSwap status' });
    const j = tryJson<any>(r) ?? {};
    if (r.status !== 200) {
      if (j.code === 'NOT_FOUND') throw new TradeNotFoundError(id, PROVIDERS.xoSwap, 'Trade not found');
      throw new Error(`${j.error ?? 'Unknown error'}\n${j.message ?? j.details ?? ''}`);
    }
    try {
      const created = Date.parse(String(j.createdAt));
      return {
        id: String(j.id),
        inputAddress: j.payInAddress,
        refundAddress: j.fromAddress,
        stateRaw: deserializeState(String(j.status)).raw,
        createdAt: Number.isFinite(created) ? created : undefined,
        receiveAmount: j.toAmount?.value != null ? String(j.toAmount.value) : undefined,
        payoutAddress: j.toAddress,
        extraId: j.payInAddressTag ?? undefined,
      };
    } catch {
      throw new TradeNotCreatedError(PROVIDERS.xoSwap);
    }
  },

  trackUrl(t) {
    return `https://orders.xoswap.com/${t.id}`;
  },
};
