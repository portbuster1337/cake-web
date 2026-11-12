// Wallet abstractions mirroring Cake Wallet's cw_core (wallet_base.dart,
// sync_status.dart, transaction_info.dart, pending_transaction.dart,
// wallet_info.dart). Every coin implements WalletBase.

import { signal, type Signal } from '@preact/signals';
import type { WalletType, Currency } from '../coins/types.ts';
import { t } from './i18n.ts';

// ------------------------------------------------------------- sync status --

export type SyncStatus =
  | { kind: 'notConnected' }
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'attempting' }
  | { kind: 'startingScan'; beginHeight: number }
  | { kind: 'syncing'; blocksLeft: number; progress: number; startedAt: number }
  | { kind: 'synchronizing' }
  | { kind: 'synced' }
  | { kind: 'syncedTip'; tip: number }
  | { kind: 'failed'; error?: string }
  | { kind: 'lostConnection' }
  | { kind: 'unsupported' }
  | { kind: 'timedOut' }
  | { kind: 'processing'; message?: string };

export function syncProgress(s: SyncStatus): number {
  if (s.kind === 'syncing') return s.progress;
  if (s.kind === 'synced' || s.kind === 'syncedTip') return 1;
  return 0;
}

export function isSynced(s: SyncStatus): boolean {
  return s.kind === 'synced' || s.kind === 'syncedTip';
}

/** lib/core/sync_status_title.dart */
export function syncStatusTitle(s: SyncStatus): string {
  switch (s.kind) {
    case 'syncing':
      if (s.blocksLeft === 1) return t('block_remaining');
      return t('Blocks_remaining', { status: s.blocksLeft });
    case 'syncedTip':
      return t('silent_payments_scanned_tip', { tip: s.tip });
    case 'synced':
      return t('sync_synced');
    case 'failed':
      return s.error ?? t('sync_offline');
    case 'lostConnection':
      return t('sync_offline');
    case 'notConnected':
      return t('sync_not_connected');
    case 'attempting':
      return t('sync_attempting');
    case 'connecting':
      return t('sync_connecting');
    case 'connected':
      return t('connected');
    case 'unsupported':
      return t('sync_unsupported_node');
    case 'timedOut':
      return t('sync_timed_out');
    case 'synchronizing':
      return t('sync_syncing');
    case 'startingScan':
      return `${t('sync_starting_scan')} (${s.beginHeight})`;
    case 'processing':
      return s.message ?? t('processing');
  }
}

// ------------------------------------------------------------ transactions --

export type TransactionDirection = 'incoming' | 'outgoing';

export interface TransactionInfo {
  id: string;
  /** asset this entry is about (wallet currency or token key) */
  currency: string;
  direction: TransactionDirection;
  /** atomic units, always positive */
  amount: bigint;
  fee?: bigint;
  /** unix ms */
  date: number;
  height?: number;
  confirmations: number;
  isPending: boolean;
  isFailed?: boolean;
  /** Monero/Zcash/... account and subaddress indices */
  accountIndex?: number;
  addressIndex?: number;
  addressIndices?: number[];
  /** counterparty / own receiving addresses */
  to?: string;
  from?: string;
  outputAddresses?: string[];
  inputAddresses?: string[];
  /** BTC: replace-by-fee signalled and still unconfirmed */
  isReplaceable?: boolean;
  /** EVM/Solana/Tron token transfers */
  tokenSymbol?: string;
  tokenDecimals?: number;
  /** Monero tx key (when known), payment id */
  key?: string;
  paymentId?: string;
  /** free-form extra fields for the details page */
  extra?: Record<string, string>;
  /** Nano/Tron etc: memo */
  memo?: string;
  /** a swap/transfer between own wallets */
  isSelfTransfer?: boolean;
  /** EVM: the tx did not execute */
  evmSignatureName?: string;
}

// -------------------------------------------------------------- balances --

export interface Balance {
  /** spendable now */
  available: bigint;
  /** total incl. locked/unconfirmed */
  full: bigint;
  /** incoming not yet spendable */
  pending?: bigint;
  frozen?: bigint;
  /** e.g. Litecoin MWEB / secondary balances */
  secondaryAvailable?: bigint;
  secondaryFull?: bigint;
}

export const ZERO_BALANCE: Balance = { available: 0n, full: 0n, pending: 0n, frozen: 0n };

// -------------------------------------------------------------- sending --

export type PriorityId = string;

export interface TransactionPriorityOption {
  id: PriorityId;
  /** label string key (e.g. "slow", "fast") or literal */
  label: string;
  /** sat/vB or gwei etc. shown next to the label */
  rateLabel?: string;
  /** custom rate entry (BTC custom fee) */
  isCustom?: boolean;
}

export interface OutputCredentials {
  address: string;
  /** resolved from a name (OpenAlias, ENS, …) */
  extractedAddress?: string;
  parsedName?: string;
  /** atomic units; ignored if sendAll */
  amount: bigint;
  sendAll: boolean;
  /** token/asset key to send (EVM/Solana/Tron/Zano) */
  asset?: string;
  memo?: string;
  note?: string;
  paymentId?: string;
}

export interface TransactionCredentials {
  outputs: OutputCredentials[];
  priority?: PriorityId;
  /** custom fee rate (sat/vB) for BTC custom priority */
  feeRate?: number;
  /** coin control: only spend these outpoints ("txid:vout") */
  selectedUtxos?: string[];
  /** Monero/... account to spend from */
  accountIndex?: number;
  /** Litecoin: mweb / nonMweb */
  coinType?: 'any' | 'mweb' | 'nonMweb';
}

export interface PendingTransaction {
  id: string;
  amountFormatted: string;
  feeFormatted: string;
  amount: bigint;
  fee: bigint;
  hex?: string;
  /** number of txs (Monero may split) */
  count?: number;
  /** extra rows for the confirmation sheet */
  extra?: Record<string, string>;
  commit(): Promise<void>;
}

// ------------------------------------------------------------- addresses --

export interface WalletAddressEntry {
  address: string;
  label: string;
  index: number;
  account?: number;
  type?: string;
  isUsed?: boolean;
  isChange?: boolean;
  isHidden?: boolean;
  balance?: bigint;
  txCount?: number;
}

export interface WalletAccount {
  index: number;
  label: string;
  balance?: bigint;
  address?: string;
}

// --------------------------------------------------------------- wallet --

export interface DerivationInfo {
  derivationType?: string;
  derivationPath?: string;
  scriptType?: string;
  description?: string;
}

/** cw_core/lib/wallet_info.dart (non-secret metadata) */
export interface WalletInfo {
  id: string;
  name: string;
  type: WalletType;
  isRecovery: boolean;
  restoreHeight: number;
  /** creation timestamp, ms */
  date: number;
  address: string;
  /** primary addresses per address type / account */
  addresses?: Record<string, string>;
  derivationInfo?: DerivationInfo;
  hardwareWalletType?: string | null;
  /** wallets made from the same seed share this (wallet groups) */
  hashedWalletIdentifier?: string;
  parentAddress?: string;
  isNonSeedWallet?: boolean;
  /** seed type used: electrum / bip39 / legacy / polyseed / nano ... */
  seedType?: string;
  showIntroCakePayCard?: boolean;
  /** user hid this wallet's balance etc. */
  sortOrder?: number;
  isWatchOnly?: boolean;
  /** network (mainnet/testnet) */
  network?: string;
}

/** Secrets kept only in the vault. */
export interface WalletSecrets {
  mnemonic?: string;
  passphrase?: string;
  /** hex seed (Nano), private key (EVM/Solana/Tron), WIF… */
  privateKey?: string;
  hexSeed?: string;
  /** Monero: keys for restore-from-keys wallets */
  spendKey?: string;
  viewKey?: string;
  /** engine-specific persisted secret data (Monero wallet files) */
  engineData?: Record<string, unknown>;
}

export interface WalletKeysRow {
  label: string;
  value: string;
}

export abstract class WalletBase {
  readonly info: WalletInfo;
  readonly secrets: WalletSecrets;
  abstract readonly currency: Currency;

  readonly syncStatus: Signal<SyncStatus> = signal<SyncStatus>({ kind: 'notConnected' });
  /** keyed by currency key (wallet coin and tokens) */
  readonly balances: Signal<Record<string, Balance>> = signal({});
  readonly transactions: Signal<TransactionInfo[]> = signal([]);
  readonly addresses: Signal<WalletAddressEntry[]> = signal([]);
  /** address shown on the receive screen */
  readonly receiveAddress: Signal<string> = signal('');
  readonly accounts: Signal<WalletAccount[]> = signal([]);
  readonly currentAccount: Signal<number> = signal(0);
  readonly height: Signal<number> = signal(0);

  constructor(info: WalletInfo, secrets: WalletSecrets) {
    this.info = info;
    this.secrets = secrets;
  }

  get id(): string {
    return this.info.id;
  }
  get name(): string {
    return this.info.name;
  }
  get type(): WalletType {
    return this.info.type;
  }

  // capabilities (wallet_base.dart)
  get hasRescan(): boolean {
    return false;
  }
  get hasCoinControl(): boolean {
    return false;
  }
  get hasAccountsSupport(): boolean {
    return false;
  }
  get hasMultipleOutputs(): boolean {
    return false;
  }
  get canSignMessages(): boolean {
    return true;
  }
  get hasTokens(): boolean {
    return false;
  }
  get isWatchOnly(): boolean {
    return !!this.info.isWatchOnly;
  }

  get seed(): string | undefined {
    return this.secrets.mnemonic;
  }
  get passphrase(): string | undefined {
    return this.secrets.passphrase;
  }

  /** rows for the "Wallet keys" page */
  abstract keys(): Promise<WalletKeysRow[]>;

  abstract connect(): Promise<void>;
  abstract startSync(): Promise<void>;
  async stopSync(): Promise<void> {}
  abstract close(): Promise<void>;

  abstract priorities(): TransactionPriorityOption[];
  abstract defaultPriority(): PriorityId;
  /** estimated fee for one output of `amount` at `priority` (atomic units) */
  abstract estimateFee(priority: PriorityId, amount?: bigint, asset?: string): Promise<bigint>;
  abstract createTransaction(c: TransactionCredentials): Promise<PendingTransaction>;

  abstract validateAddress(address: string, asset?: string): boolean;

  async rescan(_height?: number): Promise<void> {}
  async save(): Promise<void> {}

  async signMessage(_message: string, _address?: string): Promise<string> {
    throw new Error('Message signing is not supported for this wallet');
  }
  async verifyMessage(_message: string, _signature: string, _address?: string): Promise<boolean> {
    throw new Error('Message verification is not supported for this wallet');
  }

  /** a new receive address (subaddress / next unused) */
  async newAddress(_label?: string, _type?: string): Promise<WalletAddressEntry | null> {
    return null;
  }
  async setAddressLabel(_address: string, _label: string): Promise<void> {}

  /** explorer URL for a tx */
  abstract explorerUrl(txid: string): string | undefined;
}
