// ChangeNOW (lib/exchange/provider/changenow_exchange_provider.dart): fixed
// rate, receive memos; needs an API key (the user's).

import { exFetch, dartDouble, tryJson, QUOTE_TIMEOUT_MS } from '../net.ts';
import { builtinOf, type SwapCurrency } from '../currency.ts';
import { apiKey } from '../keys.ts';
import { PROVIDERS, STATES, TradeNotCreatedError, TradeNotFoundError, deserializeState, type ExchangeProvider, type Limits, type Trade } from '../types.ts';

const BASE = 'https://api.changenow.io/v2/exchange';
const KEY = 'changenow';

let lastUsedRateId = '';

const flow = (fixed: boolean) => (fixed ? 'fixed-rate' : 'standard');

function normalizeTag(t: string): string {
  switch (t) {
    case 'POL': return 'matic';
    case 'LN': return 'lightning';
    case 'AVAXC': return 'cchain';
    case 'ARB': return 'arbitrum';
    case 'ROB': return 'hood';
    default: return t.toLowerCase();
  }
}

/** _networkFor */
function networkFor(c: SwapCurrency): string {
  const k = builtinOf(c)?.key;
  if (k === 'usdt') return 'btc';
  if (k === 'arb') return 'arbitrum';
  if (k === 'nano') return 'nano';
  return c.tag ? normalizeTag(c.tag) : c.title.toLowerCase();
}

/** _normalizeCurrency */
function currencyOf(c: SwapCurrency): string {
  if (c.title === 'USDC' && c.tag === 'POLY') throw new Error('Only Bridged USDC (USDC.e) is allowed in ChangeNow');
  const k = builtinOf(c)?.key;
  if (k === 'zec') return 'zec';
  if (k === 'maticpoly') return 'matic';
  return c.title.toLowerCase();
}

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = { 'x-changenow-api-key': apiKey(KEY) };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

export const changeNow: ExchangeProvider = {
  description: PROVIDERS.changeNow,
  title: 'ChangeNOW',
  isAvailable: true,
  isEnabled: true,
  supportsFixedRate: true,
  supportsOnionAddress: false,
  supportsMemoOrDestinationTag: true,
  needsApiKey: KEY,

  async checkIsAvailable() {
    return true;
  },

  async fetchLimits(from, to, isFixedRateMode): Promise<Limits | null> {
    if (!apiKey(KEY)) throw new Error('ChangeNOW needs an API key');
    const q = new URLSearchParams({ fromCurrency: currencyOf(from), toCurrency: currencyOf(to), fromNetwork: networkFor(from), toNetwork: networkFor(to), flow: flow(isFixedRateMode) });
    const r = await exFetch(`${BASE}/range?${q}`, { headers: headers(), timeoutMs: QUOTE_TIMEOUT_MS, purpose: 'ChangeNOW limits' });
    if (r.status === 400) {
      const j = tryJson<any>(r) ?? {};
      throw new Error(`${j.error}\n${j.message}`);
    }
    if (r.status !== 200) throw new Error(`Unexpected http status: ${r.status}`);
    const j = r.json<any>();
    const min = Number.parseFloat(String(j.minAmount));
    const max = j.maxAmount == null ? null : Number.parseFloat(String(j.maxAmount));
    if (max === 0) return null;
    return { min: Number.isFinite(min) ? min : null, max: max !== null && Number.isFinite(max) ? max : null };
  },

  async fetchRate(from, to, amount, isFixedRateMode, isReceiveAmount) {
    try {
      if (amount === 0 || !apiKey(KEY)) return 0;
      const q: Record<string, string> = { fromCurrency: currencyOf(from), toCurrency: currencyOf(to), fromNetwork: networkFor(from), toNetwork: networkFor(to), type: isReceiveAmount ? 'reverse' : 'direct', flow: flow(isFixedRateMode) };
      if (isReceiveAmount) q.toAmount = dartDouble(amount);
      else q.fromAmount = dartDouble(amount);
      const r = await exFetch(`${BASE}/estimated-amount?${new URLSearchParams(q)}`, { headers: headers(), timeoutMs: QUOTE_TIMEOUT_MS, purpose: 'ChangeNOW rate' });
      const j = r.json<any>();
      const fromAmount = Number.parseFloat(String(j.fromAmount ?? '')) || 0;
      const toAmount = Number.parseFloat(String(j.toAmount ?? '')) || 0;
      if (fromAmount <= 0 || toAmount <= 0) return 0;
      if (typeof j.rateId === 'string' && j.rateId) lastUsedRateId = j.rateId;
      return isReceiveAmount ? amount / fromAmount : toAmount / amount;
    } catch {
      return 0;
    }
  },

  async createTrade(request, isFixedRateMode, isSendAll): Promise<Trade> {
    try {
      const body: Record<string, unknown> = {
        fromCurrency: currencyOf(request.fromCurrency),
        toCurrency: currencyOf(request.toCurrency),
        fromNetwork: networkFor(request.fromCurrency),
        toNetwork: networkFor(request.toCurrency),
        ...(isFixedRateMode ? { toAmount: request.toAmount } : { fromAmount: request.fromAmount }),
        address: request.toAddress,
        ...(request.toAddressExtraId ? { extraId: request.toAddressExtraId } : {}),
        flow: flow(isFixedRateMode),
        type: isFixedRateMode ? 'reverse' : 'direct',
        refundAddress: request.refundAddress,
        // Platform.operatingSystem / the distribution: this build is the web client
        payload: { app: 'cakewallet', device: 'web', distribution: 'github', version: 653 },
      };
      if (isFixedRateMode) {
        await changeNow.fetchRate(request.fromCurrency, request.toCurrency, Number.parseFloat(request.toAmount) || 0, true, true);
        body.rateId = lastUsedRateId;
      }
      const r = await exFetch(BASE, { headers: headers(true), body, retries: 0, purpose: 'ChangeNOW order' });
      if (r.status === 400) {
        const j = tryJson<any>(r) ?? {};
        throw new Error(`${j.error}\n${j.message}`);
      }
      if (r.status !== 200) throw new Error(`Unexpected http status: ${r.status}`);
      const j = r.json<any>();
      return {
        id: String(j.id),
        providerRaw: PROVIDERS.changeNow.raw,
        from: request.fromCurrency,
        to: request.toCurrency,
        inputAddress: String(j.payinAddress),
        refundAddress: String(j.refundAddress),
        extraId: j.payinExtraId ?? undefined,
        createdAt: Date.now(),
        amount: j.fromAmount != null ? String(j.fromAmount) : request.fromAmount,
        receiveAmount: j.toAmount != null ? String(j.toAmount) : request.toAmount,
        stateRaw: STATES.created.raw,
        payoutAddress: j.payoutAddress ?? undefined,
        isSendAll,
        toAddressExtraId: request.toAddressExtraId,
      };
    } catch (e) {
      throw new TradeNotCreatedError(PROVIDERS.changeNow, (e as Error).message);
    }
  },

  async findTradeById(id) {
    const r = await exFetch(`${BASE}/by-id?${new URLSearchParams({ id })}`, { headers: headers(), purpose: 'ChangeNOW status' });
    if (r.status === 404) throw new TradeNotFoundError(id, PROVIDERS.changeNow);
    if (r.status === 400) throw new TradeNotFoundError(id, PROVIDERS.changeNow, String(tryJson<any>(r)?.message ?? ''));
    if (r.status !== 200) throw new Error(`Unexpected http status: ${r.status}`);
    const j = r.json<any>();
    const valid = Date.parse(String(j.validUntil ?? ''));
    return {
      id,
      inputAddress: j.payinAddress ?? undefined,
      amount: j.expectedAmountFrom != null ? String(j.expectedAmountFrom) : undefined,
      stateRaw: deserializeState(String(j.status)).raw,
      extraId: j.payinExtraId ?? undefined,
      outputTransaction: j.payoutHash ?? undefined,
      expiredAt: Number.isFinite(valid) ? valid : undefined,
      payoutAddress: j.payoutAddress ?? undefined,
    };
  },

  trackUrl(t) {
    return `https://changenow.io/exchange/txs/${t.id}`;
  },
};
