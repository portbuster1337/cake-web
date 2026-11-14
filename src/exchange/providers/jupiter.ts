// Jupiter Ultra (lib/exchange/provider/jupiter_exchange_provider.dart): Solana
// only (SOL and SPL tokens on both sides), float rate, no receive memo. The
// order comes with a transaction that this wallet signs and Jupiter executes
// (lib/solana/cw_solana.dart signAndPrepareJupiterSwapTransaction). Keyless
// requests are allowed at a low rate; a user key is sent when set.

import { exFetch, fromBaseUnits, toBaseUnits, tryJson, QUOTE_TIMEOUT_MS, dartDouble } from '../net.ts';
import { builtinOf, type SwapCurrency } from '../currency.ts';
import { apiKey } from '../keys.ts';
import { SPL_DEFAULT_TOKENS } from '../../coins/tokens.gen.ts';
import { formatFixed } from '../../core/amount.ts';
import { PROVIDERS, STATES, TradeNotCreatedError, TradeNotFoundError, type ExchangeProvider, type Limits, type Trade } from '../types.ts';

const BASE = 'https://api.jup.ag/ultra/v1';
const NATIVE_SOL_MINT = 'So11111111111111111111111111111111111111112';

const isSolana = (c: SwapCurrency) => builtinOf(c)?.key === 'sol' || c.tag === 'SOL';

/** _getTokenMint / solana.getTokenAddress */
function mintOf(c: SwapCurrency): string {
  if (builtinOf(c)?.key === 'sol') return NATIVE_SOL_MINT;
  if (c.tag !== 'SOL') throw new Error(`Unsupported currency: ${c.title} (not a Solana token)`);
  if (c.address) return c.address;
  const t = SPL_DEFAULT_TOKENS.find((x) => x.symbol.toUpperCase() === c.title.toUpperCase());
  if (!t) throw new Error(`Unsupported currency: ${c.title} (mint address not found)`);
  return t.address;
}

function headers(json = false): Record<string, string> {
  const h: Record<string, string> = {};
  const k = apiKey('jupiter');
  if (k) h['x-api-key'] = k;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

/** _getJupiterErrorMessage */
export function jupiterErrorMessage(code: number | undefined, message: string): string {
  if (code === undefined || code === null) return `Jupiter swap failed: ${message}`;
  switch (Math.trunc(code)) {
    case -2000: return 'Transaction failed to land on the network. Please try again.';
    case -2001: return 'Unknown error occurred. Please try again.';
    case -2002: return 'Invalid transaction. Please try creating a new swap.';
    case -2003: return 'Quote expired. The swap quote is no longer valid. Please create a new swap.';
    case -2004: return 'Swap was rejected. This may be due to:\n- Insufficient funds for the swap or fees\n- Slippage tolerance exceeded (price moved too much)\n- Network congestion\nPlease check your balance and try again with a new quote.';
    case -2005: return 'Internal error occurred. Please try again.';
    default:
      if (message.includes('SlippageToleranceExceeded') || message.includes('slippage')) return 'Slippage tolerance exceeded. The price moved too much during the swap. Please try again with a new quote.';
      if (message.includes('InsufficientFunds') || message.includes('insufficient')) return 'Insufficient funds. Please ensure you have enough SOL for the swap and fees.';
      if (message.includes('Blockhash') || message.includes('expired')) return 'Transaction expired. Please create a new swap.';
      return `Jupiter swap failed (code: ${code}): ${message}. Please try again.`;
  }
}

/** a failed swap that still has a signature (to look up on an explorer) */
export class JupiterSwapFailedError extends Error {
  readonly signature: string;
  constructor(message: string, signature: string) {
    super(message);
    this.signature = signature;
  }
}

/** executeSwap: POST /execute with the signed transaction; the signature on success */
export async function executeJupiterSwap(signedTransaction: string, requestId: string): Promise<string> {
  if (!signedTransaction) throw new Error('Invalid transaction: transaction is empty');
  if (!requestId) throw new Error('Invalid requestId: requestId is empty');
  const r = await exFetch(`${BASE}/execute`, { headers: headers(true), body: { signedTransaction, requestId }, retries: 0, timeoutMs: 90_000, purpose: 'Jupiter execute' });
  const j = tryJson<any>(r) ?? {};
  const status = j.status as string | undefined;
  const signature = j.signature as string | undefined;
  const code = typeof j.code === 'number' ? j.code : undefined;
  const error = typeof j.error === 'string' ? j.error : 'Unknown error';
  switch (status) {
    case 'Success':
      if (!signature || /^1+$/.test(signature)) throw new Error(`Invalid transaction signature received from Jupiter. Status: ${status}`);
      return signature;
    case 'Failed': {
      const msg = jupiterErrorMessage(code, error);
      if (signature) throw new JupiterSwapFailedError(msg, signature);
      throw new Error(msg);
    }
    case 'Pending':
    case 'Processing':
      throw new Error('Jupiter swap is still processing. Please wait and try checking the transaction status.');
    default:
      throw new Error(`Jupiter swap returned unknown status: ${status}. Error: ${error}. Code: ${code}`);
  }
}

export const jupiter: ExchangeProvider = {
  description: PROVIDERS.jupiter,
  title: 'Jupiter',
  isAvailable: true,
  isEnabled: true,
  supportsFixedRate: false,
  supportsOnionAddress: false,
  supportsMemoOrDestinationTag: false,

  async checkIsAvailable() {
    return true;
  },

  async fetchLimits(from, to): Promise<Limits | null> {
    if (isSolana(from) && isSolana(to)) return { min: null, max: null };
    throw new Error('not supported');
  },

  async fetchRate(from, to, amount) {
    try {
      if (!isSolana(from) || !isSolana(to) || amount <= 0) return 0;
      const q = new URLSearchParams({ inputMint: mintOf(from), outputMint: mintOf(to), amount: toBaseUnits(dartDouble(amount), from.decimals) });
      const r = await exFetch(`${BASE}/order?${q}`, { headers: headers(), timeoutMs: QUOTE_TIMEOUT_MS, purpose: 'Jupiter quote' });
      if (r.status !== 200) return 0;
      const j = r.json<any>();
      return fromBaseUnits(BigInt(String(j.outAmount)), to.decimals) / amount;
    } catch {
      return 0;
    }
  },

  async createTrade(request, _fixed, isSendAll): Promise<Trade> {
    try {
      if (!isSolana(request.fromCurrency) || !isSolana(request.toCurrency)) throw new Error('not supported currencies');
      const params: Record<string, string> = {
        inputMint: mintOf(request.fromCurrency),
        outputMint: mintOf(request.toCurrency),
        amount: toBaseUnits(request.fromAmount, request.fromCurrency.decimals),
        taker: request.refundAddress,
      };
      if (request.refundAddress !== request.toAddress) params.receiver = request.toAddress;
      const r = await exFetch(`${BASE}/order?${new URLSearchParams(params)}`, { headers: headers(), retries: 0, purpose: 'Jupiter order' });
      if (r.status !== 200) throw new TradeNotCreatedError(PROVIDERS.jupiter);
      const j = r.json<any>();
      if ('errorCode' in j || 'errorMessage' in j) throw new TradeNotCreatedError(PROVIDERS.jupiter);
      const transaction = j.transaction as string | undefined;
      const requestId = j.requestId as string | undefined;
      const lamports = (k: string) => Math.trunc(Number(j[k] ?? 0)) || 0;
      const totalFee = (lamports('signatureFeeLamports') + lamports('prioritizationFeeLamports') + lamports('rentFeeLamports')) / 1e9 + lamports('integratorFeeLamports') / 1e9;
      if (!transaction) throw new TradeNotCreatedError(PROVIDERS.jupiter, 'No transaction returned from Jupiter order endpoint');
      if (!requestId) throw new TradeNotCreatedError(PROVIDERS.jupiter, 'No requestId returned from Jupiter order endpoint');
      return {
        id: requestId,
        from: request.fromCurrency,
        to: request.toCurrency,
        providerRaw: PROVIDERS.jupiter.raw,
        inputAddress: request.toAddress,
        refundAddress: request.refundAddress,
        stateRaw: STATES.created.raw,
        createdAt: Date.now(),
        amount: request.fromAmount,
        receiveAmount: formatFixed(BigInt(String(j.outAmount ?? '0')), request.toCurrency.decimals),
        payoutAddress: request.toAddress,
        isSendAll,
        routerData: transaction,
        routerValue: requestId,
        fee: totalFee,
      };
    } catch (e) {
      if (e instanceof TradeNotCreatedError) throw e;
      throw new TradeNotCreatedError(PROVIDERS.jupiter, (e as Error).message);
    }
  },

  /** Jupiter has no status lookup: the trade is final once its transaction is executed */
  async findTradeById(id) {
    throw new TradeNotFoundError(id, PROVIDERS.jupiter);
  },

  trackUrl(t) {
    return t.txId ? `https://solscan.io/tx/${t.txId}` : undefined;
  },
};
