// Swap core types (lib/exchange/exchange_provider_description.dart, trade_state.dart,
// trade.dart, trade_request.dart, limits.dart, provider/exchange_provider.dart).

import type { SwapCurrency } from './currency.ts';

/** ExchangeProviderDescription: raw (stored in a trade), title, decentralized flag, logo */
export interface ProviderDescription {
  raw: number;
  title: string;
  isCentralized: boolean;
  image: string;
}

const P = (raw: number, title: string, image: string, isCentralized = true): ProviderDescription => ({ raw, title, isCentralized, image: image ? `assets/new-ui/trade_providers/${image}` : '' });

export const PROVIDERS = {
  xmrto: P(0, 'XMR.TO', 'xmrto.svg'),
  changeNow: P(1, 'ChangeNOW', 'changenow.svg'),
  morphToken: P(2, 'MorphToken', 'morph.svg'),
  sideShift: P(3, 'SideShift', 'sideshift.svg'),
  simpleSwap: P(4, 'SimpleSwap', 'simpleswap.svg'),
  trocador: P(5, 'Trocador', 'trocador.svg'),
  exolix: P(6, 'Exolix', 'exolix.svg'),
  all: P(7, 'All trades', ''),
  thorChain: P(8, 'ThorChain', 'thorchain.svg'),
  swapTrade: P(9, 'SwapTrade', 'swaptrade.svg'),
  whyNot: P(10, 'WhyNot', 'whynot.svg'),
  stealthEx: P(11, 'StealthEx', 'stealthex.svg'),
  chainflip: P(12, 'Chainflip', 'chainflip.svg', false),
  xoSwap: P(13, 'XOSwap', 'xoswap.svg'),
  swapsXyz: P(14, 'Swaps.XYZ', 'swaps_xyz.svg'),
  nearIntents: P(15, 'Near Intents', 'near-intents.svg', false),
  jupiter: P(16, 'Jupiter', 'jupiter.svg', false),
} as const;

export function providerByRaw(raw: number): ProviderDescription | undefined {
  return Object.values(PROVIDERS).find((p) => p.raw === raw);
}

// ----------------------------------------------------------------- states --

export interface TradeState {
  raw: string;
  title: string;
}

const S = (raw: string, title: string): TradeState => ({ raw, title });

export const STATES = {
  pending: S('pending', 'Pending'),
  awaiting: S('awaiting', 'Awaiting'),
  confirming: S('confirming', 'Confirming'),
  trading: S('trading', 'Trading'),
  traded: S('traded', 'Traded'),
  complete: S('complete', 'Complete'),
  toBeCreated: S('TO_BE_CREATED', 'To be created'),
  unpaid: S('UNPAID', 'Unpaid'),
  underpaid: S('UNDERPAID', 'Underpaid'),
  paidUnconfirmed: S('PAID_UNCONFIRMED', 'Paid unconfirmed'),
  paid: S('PAID', 'Paid'),
  btcSent: S('BTC_SENT', 'Btc sent'),
  timeout: S('TIMED_OUT', 'Timeout'),
  notFound: S('NOT_FOUND', 'Not found'),
  created: S('created', 'Created'),
  finished: S('finished', 'Finished'),
  waiting: S('waiting', 'Waiting'),
  processing: S('processing', 'Processing'),
  waitingPayment: S('waitingPayment', 'Waiting payment'),
  waitingAuthorization: S('waitingAuthorization', 'Waiting authorization'),
  failed: S('failed', 'Failed'),
  completed: S('completed', 'Completed'),
  expired: S('expired', 'Expired'),
  settling: S('settling', 'Settlement in progress'),
  settled: S('settled', 'Settlement completed'),
  wait: S('wait', 'Waiting'),
  overdue: S('overdue', 'Overdue'),
  refund: S('refund', 'Refund'),
  refunded: S('refunded', 'Refunded'),
  confirmation: S('confirmation', 'Confirmation'),
  confirmed: S('confirmed', 'Confirmed'),
  exchanging: S('exchanging', 'Exchanging'),
  sending: S('sending', 'Sending'),
  success: S('success', 'Success'),
} as const;

/** TradeState.deserialize: the switch's raws and aliases; settling/settled and unknown raws keep the raw as their title */
export function deserializeState(raw: string): TradeState {
  const alias: Record<string, TradeState> = { inProgress: STATES.processing, error: STATES.failed, verifying: STATES.confirmation, sending_confirmation: STATES.sending, done: STATES.success };
  if (alias[raw]) return alias[raw];
  for (const s of Object.values(STATES)) {
    if (s === STATES.settling || s === STATES.settled) continue;
    if (s.raw === raw) return s;
  }
  return { raw, title: raw };
}

export function stateOf(raw: string | undefined): TradeState {
  return deserializeState(raw ?? '');
}

/** TradeMonitor's final states */
export const FINAL_STATES = new Set(['completed', 'success', 'confirmed', 'settled', 'finished', 'expired', 'failed', 'NOT_FOUND']);

// ------------------------------------------------------------------ trade --

/** Trade (lib/exchange/trade.dart): optional fields are null when absent */
export interface Trade {
  id: string;
  providerRaw: number;
  from?: SwapCurrency;
  to?: SwapCurrency;
  stateRaw: string;
  /** ms since the epoch */
  createdAt?: number;
  expiredAt?: number;
  /** amount to deposit (canonical decimal) */
  amount: string;
  receiveAmount?: string;
  /** where the user sends (the provider's deposit address) */
  inputAddress?: string;
  /** the provider's deposit memo / destination tag */
  extraId?: string;
  outputTransaction?: string;
  refundAddress?: string;
  payoutAddress?: string;
  walletId?: string;
  /** memo / destination tag the user entered for the receive address */
  toAddressExtraId?: string;
  password?: string;
  providerId?: string;
  providerName?: string;
  fromWalletAddress?: string;
  memo?: string;
  txId?: string;
  isRefund?: boolean;
  isSendAll?: boolean;
  router?: string;
  needToRegisterInSwapXyz?: boolean;
  sourceTokenAddress?: string;
  sourceTokenDecimals?: number;
  routerData?: string;
  routerValue?: string;
  sourceTokenAmountRaw?: string;
  requiresTokenApproval?: boolean;
  chainId?: number;
  /** Jupiter: total fee in SOL */
  fee?: number;
}

/** Trade.mergeFindTradeByIdResult: only these fields, each when the update has it */
export function mergeTrade(t: Trade, u: Partial<Trade>): Trade {
  const out: Trade = { ...t };
  if (u.stateRaw) out.stateRaw = u.stateRaw;
  if (out.createdAt === undefined && u.createdAt !== undefined) out.createdAt = u.createdAt;
  const keys = ['expiredAt', 'isRefund', 'receiveAmount', 'inputAddress', 'extraId', 'outputTransaction', 'refundAddress', 'payoutAddress', 'password', 'providerId', 'providerName', 'memo', 'txId'] as const;
  for (const k of keys) if (u[k] !== undefined && u[k] !== null) (out as any)[k] = u[k];
  return out;
}

/** formatAmount (cw_core/lib/format_amount.dart): ".00" when there is no separator, "00" after a trailing one */
export function formatTradeAmount(a: string | undefined): string {
  const s = a ?? '';
  if (!s) return s;
  if (s.endsWith('.') || s.endsWith(',')) return `${s}00`;
  if (!s.includes('.') && !s.includes(',')) return `${s}.00`;
  return s;
}

// ------------------------------------------------------------ provider io --

export interface TradeRequest {
  fromCurrency: SwapCurrency;
  toCurrency: SwapCurrency;
  toAddress: string;
  refundAddress: string;
  fromAmount: string;
  toAmount: string;
  toAddressExtraId: string;
  isFixedRate: boolean;
}

/** min/max in deposit units (receive units in fixed mode); null = unbounded */
export interface Limits {
  min: number | null;
  max: number | null;
}

export class TradeNotCreatedError extends Error {
  constructor(p: ProviderDescription, description = '') {
    super(`Trade for ${p.title} is not created. ${description}`.trim());
  }
}

export class TradeNotFoundError extends Error {
  constructor(id: string, p?: ProviderDescription, description = '') {
    super(`Trade ${id} of ${p?.title ?? ''} not found. ${description}`.replace(/\s+/g, ' ').trim());
  }
}

/** ExchangeProvider */
export interface ExchangeProvider {
  readonly description: ProviderDescription;
  /** ExchangeProvider.title, also the key of the stored provider selection */
  readonly title: string;
  readonly isAvailable: boolean;
  readonly isEnabled: boolean;
  readonly supportsFixedRate: boolean;
  readonly supportsOnionAddress: boolean;
  readonly supportsMemoOrDestinationTag: boolean;
  /** an API key this build does not have: the user's own (Settings → Connections → API keys) */
  readonly needsApiKey?: string;
  fetchLimits(from: SwapCurrency, to: SwapCurrency, isFixedRateMode: boolean): Promise<Limits | null>;
  /** receive units per one deposit unit; 0 = no quote */
  fetchRate(from: SwapCurrency, to: SwapCurrency, amount: number, isFixedRateMode: boolean, isReceiveAmount: boolean): Promise<number>;
  createTrade(request: TradeRequest, isFixedRateMode: boolean, isSendAll: boolean): Promise<Trade>;
  findTradeById(id: string): Promise<Partial<Trade>>;
  checkIsAvailable(): Promise<boolean>;
  trackUrl(t: Trade): string | undefined;
}
