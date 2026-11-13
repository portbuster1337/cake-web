// WhyNot (lib/exchange/provider/whynot_exchange_provider.dart): a
// LetsExchange-compatible API; fixed rate, receive memos; needs a bearer token
// (the user's API key; no affiliate id in this build).

import { exFetch, dartDouble, QUOTE_TIMEOUT_MS } from '../net.ts';
import type { SwapCurrency } from '../currency.ts';
import { apiKey } from '../keys.ts';
import { PROVIDERS, TradeNotCreatedError, deserializeState, type ExchangeProvider, type Limits, type Trade } from '../types.ts';

const BASE = 'https://api.y-not.io/api/v1';
const KEY = 'whynot';
const AFFILIATE_ID = '';

function headers(): Record<string, string> {
  return { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: apiKey(KEY) };
}

/** _getNetworkType */
function networkOf(c: SwapCurrency): string | null {
  if (c.tag) {
    switch (c.tag) {
      case 'TRX': return 'TRC20';
      case 'ETH': return 'ERC20';
      case 'BSC': return 'BEP20';
      case 'ARB': return 'ARBITRUM';
      default: return c.tag;
    }
  }
  return c.title.toUpperCase() === 'ARB' ? 'ARBITRUM' : c.title;
}

const bch = (a: string) => (a.startsWith('bitcoincash:') ? a.slice(12) : a);

async function info(params: Record<string, unknown>, fixed: boolean): Promise<any> {
  const r = await exFetch(`${BASE}${fixed ? '/info-revert' : '/info'}`, { headers: headers(), body: params, timeoutMs: QUOTE_TIMEOUT_MS, purpose: 'WhyNot info' });
  if (r.status !== 200) throw new Error(`WhyNot failed to fetch info WhyNot fetch info failed: ${r.text.slice(0, 200)}`);
  return r.json<any>();
}

function pairParams(from: SwapCurrency, to: SwapCurrency, amount: string, fixed: boolean): Record<string, unknown> {
  const nf = networkOf(from);
  const nt = networkOf(to);
  return { from: from.title, to: to.title, ...(nf !== null ? { network_from: nf } : {}), ...(nt !== null ? { network_to: nt } : {}), amount, affiliate_id: AFFILIATE_ID, float: !fixed };
}

export const whyNot: ExchangeProvider = {
  description: PROVIDERS.whyNot,
  title: 'WhyNot',
  isAvailable: true,
  isEnabled: true,
  supportsFixedRate: true,
  supportsOnionAddress: false,
  supportsMemoOrDestinationTag: true,
  needsApiKey: KEY,

  async checkIsAvailable() {
    return true;
  },

  /** the VM passes (receive, deposit) in fixed mode: swapped back, so limits are always in deposit units */
  async fetchLimits(from, to, isFixedRateMode): Promise<Limits | null> {
    if (!apiKey(KEY)) throw new Error('WhyNot needs an API key');
    const a = isFixedRateMode ? to : from;
    const b = isFixedRateMode ? from : to;
    try {
      const j = await info(pairParams(a, b, '1', isFixedRateMode), isFixedRateMode);
      const min = Number.parseFloat(String(j.min_amount));
      const max = Number.parseFloat(String(j.max_amount));
      return { min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null };
    } catch {
      throw new Error('Failed to fetch limits');
    }
  },

  async fetchRate(from, to, amount, isFixedRateMode) {
    try {
      if (!apiKey(KEY)) return 0;
      const j = await info(pairParams(from, to, dartDouble(amount), isFixedRateMode), isFixedRateMode);
      const get = Number.parseFloat(String(j.amount)) || 0;
      if (get === 0) return 0;
      return isFixedRateMode ? amount / get : get / amount;
    } catch {
      return 0;
    }
  },

  async createTrade(request, isFixedRateMode, isSendAll): Promise<Trade> {
    try {
      const nf = networkOf(request.fromCurrency);
      const nt = networkOf(request.toCurrency);
      const i = await info(pairParams(request.fromCurrency, request.toCurrency, isFixedRateMode ? request.toAmount : request.fromAmount, isFixedRateMode), isFixedRateMode);
      const rateId = typeof i.rate_id === 'string' ? i.rate_id : undefined;
      const body: Record<string, unknown> = {
        coin_from: request.fromCurrency.title,
        coin_to: request.toCurrency.title,
        ...(!isFixedRateMode ? { deposit_amount: request.fromAmount } : {}),
        withdrawal: bch(request.toAddress),
        ...(isFixedRateMode ? { withdrawal_amount: request.toAmount } : {}),
        withdrawal_extra_id: request.toAddressExtraId,
        return: bch(request.refundAddress),
        ...(rateId !== undefined ? { rate_id: rateId } : {}),
        ...(nf !== null ? { network_from: nf } : {}),
        ...(nt !== null ? { network_to: nt } : {}),
        affiliate_id: AFFILIATE_ID,
        float: !isFixedRateMode,
      };
      const r = await exFetch(`${BASE}${isFixedRateMode ? '/transaction-revert' : '/transaction'}`, { headers: headers(), body, retries: 0, purpose: 'WhyNot order' });
      if (r.status !== 200) throw new Error(`WhyNot create trade failed: ${r.text.slice(0, 300)}`);
      const j = r.json<any>();
      const now = Date.now();
      return {
        id: String(j.transaction_id),
        providerRaw: PROVIDERS.whyNot.raw,
        from: request.fromCurrency,
        to: request.toCurrency,
        inputAddress: String(j.deposit),
        refundAddress: j.return ?? undefined,
        payoutAddress: String(j.withdrawal),
        amount: String(j.deposit_amount),
        receiveAmount: String(j.withdrawal_amount),
        stateRaw: deserializeState(String(j.status)).raw,
        extraId: j.deposit_extra_id ?? undefined,
        createdAt: now,
        expiredAt: now + 30 * 60_000,
        isSendAll,
        toAddressExtraId: request.toAddressExtraId,
      };
    } catch (e) {
      throw new TradeNotCreatedError(PROVIDERS.whyNot, (e as Error).message);
    }
  },

  async findTradeById(id) {
    const r = await exFetch(`${BASE}/transaction/${encodeURIComponent(id)}`, { headers: headers(), purpose: 'WhyNot status' });
    if (r.status !== 200) throw new Error(`WhyNot fetch trade failed: ${r.text.slice(0, 200)}`);
    const j = r.json<any>();
    const status = String(j.status);
    return {
      id,
      inputAddress: j.deposit,
      payoutAddress: j.withdrawal,
      refundAddress: j.return ?? undefined,
      amount: j.deposit_amount,
      receiveAmount: j.withdrawal_amount != null ? String(j.withdrawal_amount) : undefined,
      stateRaw: deserializeState(status).raw,
      isRefund: status === 'refund',
      extraId: j.deposit_extra_id ?? undefined,
    };
  },

  trackUrl(t) {
    return `https://receipt.whynot.exchange/${t.id}`;
  },
};

