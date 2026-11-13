// Trocador (lib/exchange/provider/trocador_exchange_provider.dart): an
// aggregator of partner exchanges; fixed rate, receive memos, and the only
// provider with an onion service (the one used in "Tor only" mode). Needs an
// API key (the user's). The partners the user turned off are skipped.

import { exFetch, dartDouble, tryJson, QUOTE_TIMEOUT_MS, type ExOptions, type ExResponse } from '../net.ts';
import { builtinOf, type SwapCurrency } from '../currency.ts';
import { apiKey } from '../keys.ts';
import { settings } from '../../app/settings.ts';
import { PROVIDERS, TradeNotCreatedError, TradeNotFoundError, deserializeState, type ExchangeProvider, type Limits, type Trade } from '../types.ts';

const CLEARNET = 'https://api.trocador.app';
const ONION = 'http://65bsisadnxvw4kfz7h7a3jwcyenrhluuj3kd5toslfzxbk5q4m3wy6qd.onion';
const KEY = 'trocador';
/** secrets.trocadorExchangeMarkup: Cake's own markup; this build adds none */
const MARKUP = '0';

/** the partners of the last quote, best first (only enabled ones) */
let partners: string[] = [];
let lastTradeId = '';
/** the onion answered or failed this session (null: not tried yet) */
let onionWorks: boolean | null = null;

function headers(): Record<string, string> {
  return { 'API-Key': apiKey(KEY) };
}

/** _getUri: "Tor only" → the onion; otherwise the onion when it answers, else clearnet */
async function get(path: string, params: Record<string, string>, o: ExOptions = {}): Promise<ExResponse> {
  const q = new URLSearchParams(params).toString();
  const rel = `${path}${q ? `?${q}` : ''}`;
  const torOnly = settings.value.exchangeStatus === 'torOnly';
  if (torOnly || onionWorks !== false) {
    try {
      const r = await exFetch(`${ONION}${rel}`, o);
      onionWorks = true;
      return r;
    } catch (e) {
      if (torOnly) throw e;
      onionWorks = false;
    }
  }
  return exFetch(`${CLEARNET}${rel}`, o);
}

function normalizeTag(t: string): string {
  if (t.includes('ARB')) return 'Arbitrum';
  switch (t) {
    case 'ETH': return 'ERC20';
    case 'TRX': return 'TRC20';
    case 'LN': return 'Lightning';
    case 'BSC': return 'BEP20';
    default: return t.toLowerCase();
  }
}

/** _networkFor */
function networkFor(c: SwapCurrency): string {
  const k = builtinOf(c)?.key;
  if (k === 'eth') return 'ERC20';
  if (k === 'maticpoly') return 'Mainnet';
  if (k === 'usdcpoly' || k === 'usdtPoly' || k === 'usdcEPoly') return 'MATIC';
  if (k === 'zec' || k === 'arb') return 'Mainnet';
  return c.tag ? normalizeTag(c.tag) : 'Mainnet';
}

/** _normalizeCurrency */
function currencyOf(c: SwapCurrency): string {
  const k = builtinOf(c)?.key;
  if (k === 'zec') return 'zec';
  if (k === 'usdcEPoly') return 'usdce';
  return c.title.toLowerCase();
}

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export interface TrocadorPartner {
  name: string;
  rating: string;
  insurance?: number;
  enabledMarkup?: boolean;
  eta?: number;
}

/** fetchProviders: GET /exchanges (key as a query parameter), without D-rated partners, by rating */
export async function trocadorPartners(): Promise<TrocadorPartner[]> {
  const r = await get('/exchanges', { api_key: apiKey(KEY) }, { purpose: 'Trocador partners' });
  if (r.status !== 200) throw new Error(`Unexpected http status: ${r.status}`);
  const list: any[] = tryJson<any>(r)?.list ?? [];
  return list
    .filter((p) => p?.rating !== 'D')
    .map((p) => ({ name: String(p.name), rating: String(p.rating ?? ''), insurance: p.insurance, enabledMarkup: p.enabledmarkup, eta: p.eta }))
    .sort((a, b) => (a.rating < b.rating ? -1 : a.rating > b.rating ? 1 : 0));
}

export const trocador: ExchangeProvider = {
  description: PROVIDERS.trocador,
  title: 'Trocador',
  isAvailable: true,
  isEnabled: true,
  supportsFixedRate: true,
  supportsOnionAddress: true,
  supportsMemoOrDestinationTag: true,
  needsApiKey: KEY,

  async checkIsAvailable() {
    return true;
  },

  async fetchLimits(from): Promise<Limits | null> {
    if (!apiKey(KEY)) throw new Error('Trocador needs an API key');
    const r = await get('/coin', { ticker: currencyOf(from), name: from.name }, { headers: headers(), timeoutMs: QUOTE_TIMEOUT_MS, purpose: 'Trocador limits' });
    const list = tryJson<any[]>(r);
    if (!Array.isArray(list) || !list.length) throw new Error('No data');
    const min = Number.parseFloat(String(list[0].minimum));
    const max = Number.parseFloat(String(list[0].maximum));
    if (max === 0) return null;
    return { min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null };
  },

  async fetchRate(from, to, amount, isFixedRateMode, isReceiveAmount) {
    try {
      if (amount === 0 || !apiKey(KEY)) return 0;
      const q: Record<string, string> = { ticker_from: currencyOf(from), ticker_to: currencyOf(to), network_from: networkFor(from), network_to: networkFor(to), payment: isFixedRateMode ? 'True' : 'False', min_kycrating: 'C', markup: MARKUP };
      if (isFixedRateMode) q.amount_to = dartDouble(amount);
      else q.amount_from = dartDouble(amount);
      const r = await get('/new_rate', q, { headers: headers(), timeoutMs: QUOTE_TIMEOUT_MS, purpose: 'Trocador rate' });
      const j = r.json<any>();
      const amountFrom = Number.parseFloat(String(j.amount_from)) || 0;
      const amountTo = Number.parseFloat(String(j.amount_to)) || 0;
      if (amountFrom <= 0 || amountTo <= 0) return 0;
      lastTradeId = str(j.trade_id);
      const states = settings.value.trocadorProviderStates ?? {};
      const quotes: any[] = j.quotes?.quotes ?? [];
      partners = quotes.filter((x) => states[String(x.provider)] !== false).map((x) => String(x.provider));
      if (!partners.length) throw new Error('No enabled providers found for the selected trade.');
      return isReceiveAmount ? amount / amountFrom : amountTo / amount;
    } catch {
      return 0;
    }
  },

  async createTrade(request, isFixedRateMode, isSendAll): Promise<Trade> {
    try {
      if (isFixedRateMode) await trocador.fetchRate(request.fromCurrency, request.toCurrency, Number.parseFloat(request.toAmount) || 0, true, true);
      if (!partners.length) throw new Error('No available provider is enabled');
      const q: Record<string, string> = {
        ticker_from: currencyOf(request.fromCurrency),
        ticker_to: currencyOf(request.toCurrency),
        network_from: networkFor(request.fromCurrency),
        network_to: networkFor(request.toCurrency),
        payment: isFixedRateMode ? 'True' : 'False',
        min_kycrating: 'C',
        markup: MARKUP,
        ...(isFixedRateMode ? { amount_to: request.toAmount } : { amount_from: request.fromAmount }),
        address: request.toAddress,
        ...(request.toAddressExtraId ? { address_memo: request.toAddressExtraId } : {}),
        refund: request.refundAddress,
        refund_memo: '0',
        ...(isFixedRateMode ? { id: lastTradeId } : {}),
        provider: partners[0],
      };
      const r = await get('/new_trade', q, { headers: headers(), retries: 0, purpose: 'Trocador order' });
      if (r.status === 400) {
        const j = tryJson<any>(r) ?? {};
        throw new Error(`${j.error ?? 'Unknown error'}\n${j.message ?? ''}`);
      }
      if (r.status !== 200) throw new Error(`Unexpected http status: ${r.status}`);
      const j = r.json<any>();
      const date = Date.parse(str(j.date));
      return {
        id: str(j.trade_id),
        providerRaw: PROVIDERS.trocador.raw,
        from: request.fromCurrency,
        to: request.toCurrency,
        inputAddress: str(j.address_provider),
        refundAddress: str(j.refund_address),
        stateRaw: deserializeState(str(j.status)).raw,
        password: str(j.password),
        providerId: str(j.id_provider),
        providerName: str(j.provider),
        createdAt: Number.isFinite(date) ? date : Date.now(),
        amount: str(j.amount_from) || request.fromAmount,
        receiveAmount: str(j.amount_to) || request.toAmount,
        payoutAddress: str(j.address_user),
        extraId: str(j.address_provider_memo),
        isSendAll,
        toAddressExtraId: request.toAddressExtraId,
      };
    } catch (e) {
      throw new TradeNotCreatedError(PROVIDERS.trocador, (e as Error).message);
    }
  },

  async findTradeById(id) {
    const r = await get('/trade', { id }, { headers: headers(), purpose: 'Trocador status' });
    if (r.status !== 200) throw new TradeNotFoundError(id, PROVIDERS.trocador);
    const list = tryJson<any[]>(r);
    const j = Array.isArray(list) ? list[0] : null;
    if (!j) throw new TradeNotFoundError(id, PROVIDERS.trocador);
    const date = Date.parse(str(j.date));
    return {
      id: str(j.trade_id),
      payoutAddress: str(j.address_user),
      refundAddress: str(j.refund_address),
      inputAddress: str(j.address_provider),
      amount: str(j.amount_from),
      password: str(j.password),
      providerId: str(j.id_provider),
      providerName: str(j.provider),
      extraId: str(j.address_provider_memo) || undefined,
      createdAt: Number.isFinite(date) ? date : undefined,
      stateRaw: deserializeState(str(j.status)).raw,
    };
  },

  trackUrl(t) {
    return `https://trocador.app/en/checkout/${t.id}`;
  },
};
