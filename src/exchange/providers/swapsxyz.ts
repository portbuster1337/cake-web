// Swaps.XYZ (lib/exchange/provider/swapsxyz_exchange_provider.dart): routes between chains; an EVM deposit is a call
// into its router (a token transfer, or swapAndExecute after an approval), other chains pay a deposit address and
// register the transaction. Floating rates only; needs an API key (the user's).

import { exFetch, dartDouble, tryJson, QUOTE_TIMEOUT_MS } from '../net.ts';
import { builtinOf, type SwapCurrency } from '../currency.ts';
import { apiKey } from '../keys.ts';
import { PROVIDERS, STATES, TradeNotCreatedError, TradeNotFoundError, type ExchangeProvider, type Limits, type Trade } from '../types.ts';

const BASE = 'https://api-v2.swaps.xyz/api';
const KEY = 'swapsxyz';
/** the router calls Cake accepts: an ERC-20 transfer, swapAndExecute */
export const TRANSFER_SIG = '0xa9059cbb';
export const SWAP_AND_EXECUTE_SIG = '0x9be111d1';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const EVM_NATIVE = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

interface Chain {
  chainId: number;
  name: string;
  vmId: string;
}

/** TokenPathInfo: a token of a chain (no address: the chain's coin) */
interface TokenPathInfo {
  symbol: string;
  address: string | null;
  decimals: number | null;
  minAmount?: string;
  maxAmount?: string;
}

let chainList: Chain[] = [];
const tokensCache = new Map<number, TokenPathInfo[]>();

const headers = () => ({ 'x-api-key': apiKey(KEY) });

function get(path: string, params: Record<string, string>, purpose: string, timeoutMs = QUOTE_TIMEOUT_MS) {
  const q = new URLSearchParams(params).toString();
  return exFetch(`${BASE}/${path}${q ? `?${q}` : ''}`, { headers: headers(), timeoutMs, purpose });
}

/** _decodeMethodSelector */
export const methodSelector = (data: string) => (data.startsWith('0x') && data.length >= 10 ? data.slice(0, 10) : '');

/** _stripN: amounts and timestamps come as "12000n" */
const stripN = (s: string | null | undefined) => {
  const v = s ?? '0';
  return v.endsWith('n') ? v.slice(0, -1) : v;
};

/** AmountConverter.toBaseUnits (digits only: a Dart "1e-7" fails, as in Cake) */
export function toUnits(amount: string, decimals: number): string {
  let a = amount.trim();
  if (!a) return '0';
  const neg = a.startsWith('-');
  if (neg) a = a.slice(1);
  a = a.replace(/,/g, '');
  const [w, f = ''] = a.split('.');
  const whole = w || '0';
  const frac = (f + '0'.repeat(decimals)).slice(0, decimals);
  if (!/^\d+$/.test(whole) || (frac && !/^\d+$/.test(frac))) throw new Error(`Invalid amount ${amount}`);
  const v = BigInt(whole) * 10n ** BigInt(decimals) + (frac ? BigInt(frac) : 0n);
  return neg ? `-${v}` : v.toString();
}

/** AmountConverter.fromBaseUnits */
export function fromUnits(units: string, decimals: number): string {
  let u = units.trim();
  if (!u) return '0';
  const neg = u.startsWith('-');
  if (neg) u = u.slice(1);
  if (!decimals) return neg ? `-${u}` : u;
  const s = u.length <= decimals ? u.padStart(decimals + 1, '0') : u;
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  const out = frac ? `${int}.${frac}` : int;
  return neg ? `-${out}` : out;
}

/** _normalizeCakeNetwork */
function networkName(network: string): string {
  const n = network.toUpperCase();
  const map: Record<string, string> = { ETH: 'ETHEREUM', BSC: 'BNB SMART CHAIN', POL: 'POLYGON', AVAXC: 'AVALANCHE', TRX: 'TRON', SOL: 'SOLANA', CRO: 'CRONOS', ADA: 'CARDANO', KAS: 'KASPA', TON: 'TONCOIN', BCH: 'BITCOIN CASH', ARB: 'ARBITRUM' };
  return map[n] ?? n;
}

/** _normalizeCakeNativeTokenName */
const tokenSymbol = (title: string) => (title.toUpperCase() === 'ZZEC' ? 'ZEC' : title.toUpperCase());

/** _notSupportedAsSourceToken: Solana and BNB Smart Chain currencies (Cake's list) */
function notSupported(c: SwapCurrency): boolean {
  if (c.address) return false;
  return builtinOf(c)?.key === 'sol' || (c.tag ?? '').toUpperCase() === 'SOL' || c.tag === 'BSC';
}

/** _geSupportedChain: loaded once */
async function supportedChains(): Promise<Chain[]> {
  if (chainList.length) return chainList;
  try {
    const r = await get('getChainList', {}, 'Swaps.XYZ chains');
    if (r.status !== 200) return [];
    const list = tryJson<any[]>(r);
    if (!Array.isArray(list)) return [];
    chainList = list.map((c) => ({ chainId: Number(c.chainId), name: String(c.name), vmId: String(c.vmId) }));
    return chainList;
  } catch {
    return [];
  }
}

/** _findChainByCurrency */
function chainOf(c: SwapCurrency, chains: Chain[]): Chain {
  const network = networkName(c.tag ?? c.title);
  const found = chains.find((x) => x.name.toUpperCase() === network);
  if (!found) throw new Error(`Unsupported chain for ${c.title}`);
  return found;
}

/** _mergeCache: by symbol, an entry with an address or decimals replacing one without */
function mergeCache(chainId: number, incoming: TokenPathInfo[]) {
  const by = new Map((tokensCache.get(chainId) ?? []).map((t) => [t.symbol, t]));
  for (const t of incoming) {
    const cur = by.get(t.symbol);
    if (!cur) by.set(t.symbol, t);
    else if ((t.address && !cur.address) || (t.decimals !== null && cur.decimals === null)) by.set(t.symbol, t);
  }
  tokensCache.set(chainId, [...by.values()]);
}

const tokenInfo = (j: any): TokenPathInfo => ({ symbol: String(j?.symbol ?? '').toUpperCase(), address: typeof j?.address === 'string' ? j.address : null, decimals: Number.isInteger(j?.decimals) ? j.decimals : null, minAmount: j?.minAmount?.toString(), maxAmount: j?.maxAmount?.toString() });

/** _fetchAndCacheTokens: a chain's coin and the tokens its routes reach */
async function fetchTokens(chainId: number): Promise<void> {
  const r = await get('getPaths', { srcChainId: String(chainId), srcToken: ZERO_ADDRESS }, 'Swaps.XYZ tokens');
  if (r.status !== 200) return;
  const body = tryJson<any>(r);
  if (!body || typeof body !== 'object') return;
  const src = body.srcToken;
  if (src && typeof src === 'object') {
    const symbol = String(src.symbol ?? '').toUpperCase();
    if (symbol) mergeCache(chainId, [{ symbol, address: src.isNative === true ? null : typeof src.address === 'string' ? src.address : null, decimals: Number.isInteger(src.decimals) ? src.decimals : null, minAmount: src.minAmount?.toString(), maxAmount: src.maxAmount?.toString() }]);
  }
  for (const p of Array.isArray(body.paths) ? body.paths : []) {
    const id = typeof p?.chainId === 'number' ? Math.trunc(p.chainId) : null;
    if (id === null) continue;
    if (typeof p.tokens === 'string') {
      if (p.tokens.toLowerCase() === 'all' && !tokensCache.has(id)) tokensCache.set(id, []);
      continue;
    }
    if (Array.isArray(p.tokens)) {
      const parsed = p.tokens.filter((t: unknown) => t && typeof t === 'object').map(tokenInfo);
      if (parsed.length) mergeCache(id, parsed);
    }
  }
}

/** _ensureTokensCached */
async function ensureTokens(a: Chain, b: Chain): Promise<void> {
  const need = (c: Chain) => !(tokensCache.get(c.chainId)?.length);
  if (need(a)) await fetchTokens(a.chainId);
  if (need(b)) await fetchTokens(b.chainId);
}

/** _getTokenAddress: the token's address on the chain, the zero address for its coin, else the symbol (alt-VM assets) */
function tokenAddress(c: SwapCurrency, chain: Chain): string {
  const symbol = tokenSymbol(c.title);
  for (const t of tokensCache.get(chain.chainId) ?? []) {
    if (t.symbol !== symbol) continue;
    if (t.address) return t.address;
    if (t.address === null) return ZERO_ADDRESS;
  }
  return symbol;
}

/** _mapSwapsStatusToTradeState */
function stateOf(s: string): string {
  switch (s) {
    case 'pending':
    case 'processing':
      return STATES.pending.raw;
    case 'success':
    case 'completed':
    case 'complete':
      return STATES.finished.raw;
    case 'failed':
    case 'cancelled':
    case 'canceled':
    case 'error':
      return STATES.failed.raw;
    default:
      return STATES.pending.raw;
  }
}

/** _parseUnixSeconds */
function unixSeconds(v: unknown): number | null {
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'string') {
    const n = Number.parseInt(stripN(v), 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** registerAltVmTx: a broadcast alt-VM (or bridged) deposit made known to Swaps.XYZ */
export async function registerSwapsXyzTx(o: { txId: string; txHash: string; chainId: number; vmId: string }): Promise<boolean> {
  try {
    const r = await exFetch(`${BASE}/registerTxs`, { method: 'POST', body: { txId: o.txId, vmId: o.vmId, txHash: o.txHash, chainId: o.chainId }, headers: headers(), timeoutMs: 60_000, retries: 0, purpose: 'Swaps.XYZ register' });
    if (r.status !== 200) return false;
    const body = tryJson<any[]>(r);
    return Array.isArray(body) && body.length > 0 && body[0]?.success === true;
  } catch {
    return false;
  }
}

export const swapsXyz: ExchangeProvider = {
  description: PROVIDERS.swapsXyz,
  title: 'Swaps.XYZ',
  isAvailable: true,
  isEnabled: true,
  // Swaps.XYZ does not guarantee a fixed-rate trade at the requested amount
  supportsFixedRate: false,
  supportsOnionAddress: false,
  supportsMemoOrDestinationTag: false,
  needsApiKey: KEY,

  async checkIsAvailable() {
    return true;
  },

  async fetchLimits(from, to, isFixedRateMode): Promise<Limits | null> {
    if (!apiKey(KEY)) throw new Error('Swaps.XYZ needs an API key');
    const chains = await supportedChains();
    if (!chains.length) throw new Error('Failed to fetch supported chains');
    const a = isFixedRateMode ? to : from;
    const b = isFixedRateMode ? from : to;
    const src = chainOf(a, chains);
    const dst = chainOf(b, chains);
    await ensureTokens(src, dst);
    const srcToken = tokenAddress(a, src);
    const dstToken = tokenAddress(b, dst);
    const r = await get('getPaths', { srcChainId: String(src.chainId), srcToken, dstChainId: String(dst.chainId), dstToken }, 'Swaps.XYZ limits');
    if (r.status !== 200) throw new Error(`Unexpected http status: ${r.status}`);
    const paths = ((tryJson<any>(r)?.paths ?? []) as any[]).filter((p) => p && typeof p === 'object');
    if (!paths.length) throw new Error(`No paths for ${a.title} -> ${b.title}`);
    let path = paths.find((p) => p.chainId === dst.chainId) ?? paths.find((p) => Array.isArray(p.tokens) || p.amountLimits != null) ?? paths[0];
    if (isFixedRateMode && path.supportsExactAmountOut !== true) throw new Error('This route does not support fixed receive (exact-amount-out)');
    if (!isFixedRateMode && path.supportsExactAmountIn !== true) throw new Error('This route does not support exact send (exact-amount-in)');
    let limits: { minAmount?: unknown; maxAmount?: unknown } | null = null;
    if (isFixedRateMode) {
      if (Array.isArray(path.tokens)) {
        const want = tokenSymbol(b.title);
        const match = path.tokens.find((t: any) => String(t?.symbol ?? '').toUpperCase() === want || (t?.address && String(t.address).toLowerCase() === dstToken.toLowerCase()));
        if (match) limits = { minAmount: match.minAmount, maxAmount: match.maxAmount };
      }
    } else limits = path.amountLimits ?? null;
    const num = (v: unknown) => {
      const n = Number.parseFloat(String(v ?? ''));
      return Number.isFinite(n) ? n : null;
    };
    return { min: num(limits?.minAmount), max: num(limits?.maxAmount) };
  },

  async fetchRate(from, to, amount, _isFixedRateMode, isReceiveAmount) {
    try {
      if (!apiKey(KEY) || notSupported(from) || notSupported(to)) return 0;
      const chains = await supportedChains();
      if (!chains.length) return 0;
      const src = chainOf(from, chains);
      const dst = chainOf(to, chains);
      await ensureTokens(src, dst);
      const srcToken = tokenAddress(from, src);
      const dstToken = tokenAddress(to, dst);
      if (isReceiveAmount) {
        // _pickPath: the first route must take an exact output
        const r = await get('getPaths', { srcChainId: String(src.chainId), srcToken, dstChainId: String(dst.chainId), dstToken }, 'Swaps.XYZ paths');
        const first = r.status === 200 ? (tryJson<any>(r)?.paths ?? [])[0] : undefined;
        if (!first || first.supportsExactAmountOut !== true) return 0;
      }
      const units = toUnits(dartDouble(amount), isReceiveAmount ? to.decimals : from.decimals);
      const r = await get('getQuote', { swapDirection: isReceiveAmount ? 'exact-amount-out' : 'exact-amount-in', srcToken, dstToken, srcChainId: String(src.chainId), dstChainId: String(dst.chainId), amount: units }, 'Swaps.XYZ quote');
      if (r.status !== 200) return 0;
      const rate = Number(tryJson<any>(r)?.exchangeRate);
      return Number.isFinite(rate) ? rate : 0;
    } catch {
      return 0;
    }
  },

  async createTrade(request, isFixedRateMode, isSendAll): Promise<Trade> {
    try {
      const sender = request.refundAddress.trim();
      const recipient = request.toAddress.trim();
      if (!sender || !recipient) throw new Error('Sender (refundAddress) or recipient (toAddress) is empty');
      const chains = await supportedChains();
      if (!chains.length) throw new Error('Failed to fetch supported chains');
      const src = chainOf(request.fromCurrency, chains);
      const dst = chainOf(request.toCurrency, chains);
      await ensureTokens(src, dst);
      const srcToken = tokenAddress(request.fromCurrency, src);
      const dstToken = tokenAddress(request.toCurrency, dst);
      const amountStr = isFixedRateMode ? request.toAmount : request.fromAmount;
      if (!(Number.parseFloat(amountStr) > 0)) throw new Error('Invalid amount');
      const amount = toUnits(amountStr, isFixedRateMode ? request.toCurrency.decimals : request.fromCurrency.decimals);
      const params = { actionType: 'swap-action', sender, srcChainId: String(src.chainId), srcToken, dstChainId: String(dst.chainId), dstToken, slippage: '300', swapDirection: isFixedRateMode ? 'exact-amount-out' : 'exact-amount-in', amount, recipient };
      const r = await exFetch(`${BASE}/getAction?${new URLSearchParams(params)}`, { headers: headers(), timeoutMs: 60_000, retries: 0, purpose: 'Swaps.XYZ action' });
      if (r.status !== 200) throw new Error(`getAction failed: ${r.status} ${r.text}`);
      const data = tryJson<any>(r) ?? {};
      const txId = String(data.txId ?? '');
      const vmId = String(data.vmId ?? '');
      const tx = data.tx && typeof data.tx === 'object' ? data.tx : {};
      const routerData: string | undefined = tx.data == null ? undefined : String(tx.data);
      // only a deposit address, no call data, an ERC-20 transfer or swapAndExecute
      if (routerData !== undefined && routerData !== '0x' && methodSelector(routerData) !== TRANSFER_SIG && methodSelector(routerData) !== SWAP_AND_EXECUTE_SIG) throw new Error('Does not support that method selector');
      if (!txId) throw new Error('No txId returned by getAction');
      const bridgeIds: unknown[] = Array.isArray(data.bridgeIds) ? data.bridgeIds : [];
      const amtIn = data.amountIn && typeof data.amountIn === 'object' ? data.amountIn : {};
      const amtInMax = data.amountInMax && typeof data.amountInMax === 'object' ? data.amountInMax : {};
      const chainId = tx.chainId == null ? undefined : String(tx.chainId);
      return {
        id: txId,
        providerRaw: PROVIDERS.swapsXyz.raw,
        router: chainId,
        providerId: vmId,
        from: request.fromCurrency,
        to: request.toCurrency,
        inputAddress: tx.to == null ? undefined : String(tx.to),
        refundAddress: request.refundAddress,
        stateRaw: STATES.created.raw,
        providerName: 'Swaps.XYZ',
        createdAt: Date.now(),
        amount: request.fromAmount,
        receiveAmount: request.toAmount,
        payoutAddress: request.toAddress,
        isSendAll,
        needToRegisterInSwapXyz: vmId === 'alt-vm' || bridgeIds.includes('alt-vm') || chainId === 'solana' || bridgeIds.includes('solana'),
        sourceTokenAddress: typeof amtIn.address === 'string' ? amtIn.address : srcToken,
        sourceTokenDecimals: Number.isInteger(amtIn.decimals) ? amtIn.decimals : request.fromCurrency.decimals,
        sourceTokenAmountRaw: stripN(String(amtInMax.amount ?? amtIn.amount ?? '0')),
        requiresTokenApproval: data.requiresTokenApproval === true,
        routerData,
        routerValue: String(tx.value ?? '0'),
      };
    } catch (e) {
      throw new TradeNotCreatedError(PROVIDERS.swapsXyz, (e as Error).message);
    }
  },

  async findTradeById(id): Promise<Partial<Trade>> {
    if (!id) throw new Error('Trade id is empty');
    const r = await get('getStatus', { txId: id }, 'Swaps.XYZ status', 60_000);
    if (r.status !== 200) throw new TradeNotFoundError(id, PROVIDERS.swapsXyz, `getStatus failed: ${r.status}`);
    const data = tryJson<any>(r) ?? {};
    if (data.success === false && data.error) throw new TradeNotFoundError(id, PROVIDERS.swapsXyz, `findTradeById error: (${id}) ${data.error.code ?? 'unknown'}`);
    const src = data.srcTx && typeof data.srcTx === 'object' ? data.srcTx : {};
    const dst = data.dstTx && typeof data.dstTx === 'object' ? data.dstTx : {};
    const srcToken = src.paymentToken && typeof src.paymentToken === 'object' ? src.paymentToken : {};
    const dstToken = dst.paymentToken && typeof dst.paymentToken === 'object' ? dst.paymentToken : {};
    const ts = unixSeconds(src.timestamp) ?? unixSeconds(dst.timestamp);
    return {
      stateRaw: stateOf(String(data.status ?? 'NOT_FOUND').toLowerCase()),
      inputAddress: src.toAddress?.toString(),
      payoutAddress: dst.toAddress?.toString(),
      refundAddress: data.sender?.toString(),
      receiveAmount: dstToken.amount != null ? fromUnits(stripN(String(dstToken.amount)), Number(dstToken.decimals) || 0) : undefined,
      txId: typeof src.txHash === 'string' ? src.txHash : undefined,
      createdAt: ts !== null ? ts * 1000 : undefined,
      amount: fromUnits(stripN(srcToken.amount?.toString()), Number(srcToken.decimals) || 0),
    };
  },

  trackUrl(t: Trade) {
    return `https://scan.swaps.xyz/transactions/${t.id}`;
  },
};

/** the token cache and chain list, for tests */
export function resetSwapsXyzCache(): void {
  chainList = [];
  tokensCache.clear();
}
