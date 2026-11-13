// SwapTrade (lib/exchange/provider/swaptrade_exchange_provider.dart): keyless,
// float rate only, no receive memo. The coin list (with each coin's networks)
// is fetched once and kept for the session, like Cake's static map.

import { exFetch, dartDouble, tryJson, QUOTE_TIMEOUT_MS } from '../net.ts';
import { builtinOf, networkOf, type SwapCurrency } from '../currency.ts';
import { PROVIDERS, STATES, TradeNotCreatedError, TradeNotFoundError, deserializeState, type ExchangeProvider, type Limits, type Trade, type TradeRequest, type TradeState } from '../types.ts';

const BASE = 'https://api.swaptrade.io/api/swap';
/** secrets.swapTradeExchangeMarkup: Cake's own markup; this build adds none */
const MARKUP = 0;

let coinNetworks: Map<string, string[]> | null = null;

async function fetchCoins(): Promise<any[]> {
  const r = await exFetch(`${BASE}/get-coins`, { timeoutMs: QUOTE_TIMEOUT_MS, purpose: 'SwapTrade coins' });
  const j = tryJson<any>(r);
  if (j?.success !== true) throw new Error(errorMessage(j ?? r.text));
  const coins: any[] = Array.isArray(j.data) ? j.data : [];
  coinNetworks = new Map(coins.map((c) => [String(c.id).toUpperCase(), String(c.network).toUpperCase().split(',').map((n) => n.trim())]));
  return coins;
}

function errorMessage(body: any): string {
  const errors = body?.errors;
  if (Array.isArray(errors) && errors.length) return String(errors[0]?.msg);
  return String(body?.msg ?? body?.message ?? (typeof body === 'string' ? body : JSON.stringify(body)));
}

const coinOf = (c: SwapCurrency) => c.title.toUpperCase();

async function networkFor(c: SwapCurrency): Promise<string | null> {
  if (!coinNetworks) await fetchCoins();
  const n = networkOf(c).toUpperCase();
  return (coinNetworks!.get(coinOf(c)) ?? []).includes(n) ? n : null;
}

async function pairSupported(from: SwapCurrency, to: SwapCurrency): Promise<boolean> {
  return (await networkFor(from)) !== null && (await networkFor(to)) !== null;
}

/** _tradeState */
function stateFor(status: string): TradeState {
  switch (status) {
    case '1': return STATES.waitingPayment;
    case '2': return STATES.confirming;
    case '3': case '13': return STATES.processing;
    case '4': case '5': return STATES.exchanging;
    case '6': case '7': return STATES.sending;
    case '8': return STATES.completed;
    case '9': return STATES.expired;
    case '10': return STATES.underpaid;
    case '11': return STATES.pending;
    case '12': return STATES.refunded;
    default: return deserializeState(status);
  }
}

export const swapTrade: ExchangeProvider = {
  description: PROVIDERS.swapTrade,
  title: 'SwapTrade',
  isAvailable: true,
  isEnabled: true,
  supportsFixedRate: false,
  supportsOnionAddress: false,
  supportsMemoOrDestinationTag: false,

  async checkIsAvailable() {
    return true;
  },

  async fetchLimits(from, to): Promise<Limits | null> {
    try {
      const coins = await fetchCoins();
      if (!(await pairSupported(from, to))) return null;
      const coin = coins.find((c) => String(c.id).toUpperCase() === coinOf(from));
      if (!coin) return null;
      const min = Number.parseFloat(String(coin.min ?? '')) || 0;
      const max = Number.parseFloat(String(coin.max ?? '')) || 0;
      if (max === 0) return null;
      return { min, max };
    } catch {
      return null;
    }
  },

  async fetchRate(from, to, amount, isFixedRateMode) {
    try {
      if (amount === 0) return 0;
      if (!(await pairSupported(from, to))) return 0;
      if (isFixedRateMode) return 0;
      if (builtinOf(from)?.key === 'btcln' || builtinOf(to)?.key === 'btcln') return 0;
      const body = { coin_send: coinOf(from), coin_receive: coinOf(to), amount: dartDouble(amount), ref: 'cake' };
      const r = await exFetch(`${BASE}/get-rate`, { body, timeoutMs: QUOTE_TIMEOUT_MS, purpose: 'SwapTrade rate' });
      const j = tryJson<any>(r);
      if (j?.success !== true) return 0;
      const rate = Number.parseFloat(String(j.data?.price));
      return rate > 0 ? rate / amount : 0;
    } catch {
      return 0;
    }
  },

  async createTrade(request: TradeRequest, _fixed, isSendAll): Promise<Trade> {
    const sendNetwork = await networkFor(request.fromCurrency).catch(() => null);
    const receiveNetwork = await networkFor(request.toCurrency).catch(() => null);
    if (!sendNetwork || !receiveNetwork) {
      throw new TradeNotCreatedError(PROVIDERS.swapTrade, `SwapTrade has no network for ${request.fromCurrency.title} ${request.fromCurrency.tag ?? ''} or ${request.toCurrency.title} ${request.toCurrency.tag ?? ''}`);
    }
    try {
      const body = {
        coin_send: coinOf(request.fromCurrency),
        coin_send_network: sendNetwork,
        coin_receive: coinOf(request.toCurrency),
        coin_receive_network: receiveNetwork,
        amount_send: request.fromAmount,
        recipient: request.toAddress,
        ref: 'cake',
        markup: MARKUP,
        refund_address: request.refundAddress,
      };
      const r = await exFetch(`${BASE}/create-order`, { body, retries: 0, purpose: 'SwapTrade order' });
      const j = tryJson<any>(r);
      if (j?.success !== true) throw new Error(`Unexpected http status: ${r.status}\nSwapTrade: ${errorMessage(j ?? r.text)}`);
      const d = j.data ?? {};
      const receiveAmount = d.amount_receive != null ? String(d.amount_receive) : undefined;
      return {
        id: String(d.order_id),
        inputAddress: String(d.server_address),
        amount: request.fromAmount,
        receiveAmount: receiveAmount ?? request.toAmount,
        from: request.fromCurrency,
        to: request.toCurrency,
        providerRaw: PROVIDERS.swapTrade.raw,
        createdAt: Date.now(),
        stateRaw: STATES.created.raw,
        payoutAddress: request.toAddress,
        isSendAll,
      };
    } catch (e) {
      throw new TradeNotCreatedError(PROVIDERS.swapTrade, (e as Error).message);
    }
  },

  async findTradeById(id) {
    try {
      const r = await exFetch(`${BASE}/order`, { body: { order_id: id }, purpose: 'SwapTrade status' });
      const j = tryJson<any>(r);
      if (j?.success !== true) throw new Error(`Unexpected http status: ${r.status}\nSwapTrade: ${errorMessage(j ?? r.text)}`);
      const d = j.data ?? {};
      const status = String(d.status);
      const created = Date.parse(d.created_at ?? '');
      return {
        id: String(d.order_id),
        inputAddress: d.server_address,
        amount: d.amount_send,
        payoutAddress: d.recipient,
        stateRaw: stateFor(status).raw,
        receiveAmount: d.amount_receive != null ? String(d.amount_receive) : undefined,
        memo: d.memo ?? undefined,
        createdAt: Number.isFinite(created) ? created : undefined,
        refundAddress: d.refund_address === '' || d.refund_address == null ? undefined : d.refund_address,
        isRefund: status === '12',
        outputTransaction: d.outgoing_tx === '' || d.outgoing_tx == null ? undefined : d.outgoing_tx,
      };
    } catch (e) {
      throw new TradeNotFoundError(id, PROVIDERS.swapTrade, (e as Error).message);
    }
  },

  trackUrl(t) {
    return `https://swaptrade.io/send/${t.id}`;
  },
};
