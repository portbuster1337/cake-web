// Chainflip broker (lib/exchange/provider/chainflip_exchange_provider.dart):
// decentralized, float rate, no receive memo, fourteen assets; the broker
// needs an API key (the user's).

import { exFetch, QUOTE_TIMEOUT_MS } from '../net.ts';
import { builtinOf, type SwapCurrency } from '../currency.ts';
import { apiKey } from '../keys.ts';
import { PROVIDERS, STATES, TradeNotFoundError, type ExchangeProvider, type Limits, type Trade, type TradeState } from '../types.ts';

const BASE = 'https://chainflip-broker.io';
const KEY = 'chainflip';
/** secrets.chainflipAffiliateFee: Cake's commission; this build takes none */
const COMMISSION_BPS = '0';

const SUPPORTED = new Set(['btc', 'eth', 'usdc', 'usdterc20', 'flip', 'wbtc', 'sol', 'usdcsol', 'usdtSol', 'arbEth', 'usdcArb', 'usdtArb', 'trx', 'usdttrc20']);

const supported = (c: SwapCurrency) => SUPPORTED.has(builtinOf(c)?.key ?? '');

/** _normalizeCurrency */
function assetId(c: SwapCurrency): string {
  const k = builtinOf(c)?.key;
  if (k === 'trx') return 'trx.tron';
  if (k === 'usdttrc20') return 'usdt.tron';
  const title = c.title.toLowerCase();
  return c.tag ? `${title}.${c.tag.toLowerCase()}` : `${title}.${title}`;
}

/** _amountToNative: floor(amount × 10^decimals) in floating point */
const toNative = (amount: number, c: SwapCurrency) => Math.trunc(amount * 10 ** c.decimals).toString();
const fromNative = (s: string, c: SwapCurrency) => Number.parseFloat(s) / 10 ** c.decimals;

/** _getRequest: a non-200 answer, or one that merely contains "error", fails */
async function get(path: string, params: Record<string, string>, purpose: string, timeoutMs = QUOTE_TIMEOUT_MS): Promise<any> {
  const q = new URLSearchParams(params).toString();
  const r = await exFetch(`${BASE}${path}${q ? `?${q}` : ''}`, { timeoutMs, purpose, retries: path === '/swap' ? 0 : 1 });
  if (r.status !== 200 || r.text.includes('error')) throw new Error(`Unexpected response: ${r.status} / ${path} / ${r.text.slice(0, 200)}`);
  return r.json<any>();
}

/** _getSwapQuote: the quote with the highest egressAmount */
async function quoteFor(from: SwapCurrency, to: SwapCurrency, amount: number): Promise<any> {
  const list = await get('/quotes-native', { apiKey: apiKey(KEY), sourceAsset: assetId(from), destinationAsset: assetId(to), amount: toNative(amount, from), commissionBps: COMMISSION_BPS }, 'Chainflip quote');
  if (!Array.isArray(list) || !list.length) throw new Error('No quotes');
  return list.reduce((a, b) => (Number(a.egressAmount) > Number(b.egressAmount) ? a : b));
}

const NETWORKS: Record<string, string> = { BITCOIN: 'Bitcoin', ETHEREUM: 'Ethereum', ARBITRUM: 'Arbitrum', SOLANA: 'Solana', TRON: 'Tron' };

function stateFor(s: string): TradeState {
  switch (s) {
    case 'waiting': return STATES.waiting;
    case 'receiving': case 'swapping': case 'sending': case 'sent': return STATES.processing;
    case 'completed': return STATES.success;
    case 'failed': return STATES.failed;
    default: return STATES.notFound;
  }
}

export const chainflip: ExchangeProvider = {
  description: PROVIDERS.chainflip,
  title: 'Chainflip',
  isAvailable: true,
  isEnabled: true,
  supportsFixedRate: false,
  supportsOnionAddress: false,
  supportsMemoOrDestinationTag: false,
  needsApiKey: KEY,

  async checkIsAvailable() {
    return true;
  },

  async fetchLimits(from, to): Promise<Limits | null> {
    if (!supported(from) || !supported(to)) throw new Error('Rate not found');
    if (!apiKey(KEY)) throw new Error('Chainflip needs an API key');
    const j = await get('/assets', {}, 'Chainflip assets');
    const a = (j.assets as any[] | undefined)?.find((x) => x?.id === assetId(from));
    const min = String(a?.minimalAmountNative ?? '0');
    if (min === '0') throw new Error('Rate not found');
    return { min: fromNative(min, from), max: null };
  },

  async fetchRate(from, to, amount) {
    try {
      if (amount === 0 || !supported(from) || !supported(to) || !apiKey(KEY)) return 0;
      const q = await quoteFor(from, to, amount);
      return fromNative(String(q.egressAmountNative ?? '0'), to) / amount;
    } catch {
      return 0;
    }
  },

  async createTrade(request, _fixed, isSendAll): Promise<Trade> {
    const q = await quoteFor(request.fromCurrency, request.toCurrency, Number.parseFloat(request.fromAmount));
    const minimumPrice = (Number(q.estimatedPrice) * (100 - 2)) / 100;
    const params: Record<string, string> = {
      apiKey: apiKey(KEY),
      sourceAsset: assetId(request.fromCurrency),
      destinationAsset: assetId(request.toCurrency),
      destinationAddress: request.toAddress,
      commissionBps: COMMISSION_BPS,
      minimumPrice: String(minimumPrice),
      refundAddress: request.refundAddress,
      boostFee: '6',
      retryDurationInBlocks: '150',
    };
    if ('numberOfChunks' in q && 'chunkIntervalBlocks' in q) {
      params.numberOfChunks = String(q.numberOfChunks);
      params.chunkIntervalBlocks = String(q.chunkIntervalBlocks);
    }
    const s = await get('/swap', params, 'Chainflip order', 60_000);
    return {
      id: `${s.issuedBlock}-${s.network}-${s.channelId}`,
      providerRaw: PROVIDERS.chainflip.raw,
      from: request.fromCurrency,
      to: request.toCurrency,
      inputAddress: String(s.address),
      createdAt: Date.now(),
      amount: request.fromAmount,
      receiveAmount: request.toAmount,
      stateRaw: STATES.waiting.raw,
      payoutAddress: request.toAddress,
      isSendAll,
    };
  },

  async findTradeById(id) {
    const [issuedBlock, network, channelId] = id.split('-');
    const q = new URLSearchParams({ apiKey: apiKey(KEY), issuedBlock, network: NETWORKS[network] ?? network, channelId });
    const r = await exFetch(`${BASE}/status-by-deposit-channel?${q}`, { purpose: 'Chainflip status' });
    if (r.status === 404) throw new TradeNotFoundError(id, PROVIDERS.chainflip);
    if (r.status !== 200 || r.text.includes('error')) throw new Error(`Unexpected response: ${r.status}`);
    const st = r.json<any>().status ?? {};
    const isRefund = st.refundEgress != null;
    return {
      id,
      amount: st.deposit?.amount != null ? String(st.deposit.amount) : '0.0',
      receiveAmount: isRefund ? String(st.refundEgress?.amount ?? '0.0') : String(st.swapEgress?.amount ?? '0.0'),
      stateRaw: stateFor(String(st.state)).raw,
      payoutAddress: st.destinationAddress != null ? String(st.destinationAddress) : undefined,
      outputTransaction: st.swapEgress?.transactionReference != null ? String(st.swapEgress.transactionReference) : undefined,
      isRefund,
    };
  },

  trackUrl(t) {
    return `https://scan.chainflip.io/channels/${t.id}`;
  },
};
