// Tron wallet engine (cw_tron/lib/tron_wallet.dart + tron_client.dart): key at
// m/44'/195'/0'/0/0, TRX and TRC-20 balances from the full node, Cake's
// bandwidth / energy fee estimate, TRX and TRC-20 transfers built and signed
// here (the protobuf encoding is checked against real transactions), TronGrid
// history with Cake's parsing, and TRON personal-message signing.

import { signal } from '@preact/signals';
import { HDKey } from '@scure/bip32';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { WalletBase, type Balance, type PendingTransaction, type TransactionCredentials, type TransactionInfo, type TransactionPriorityOption, type WalletInfo, type WalletKeysRow, type WalletSecrets } from '../../core/wallet.ts';
import { currency, type Currency } from '../types.ts';
import { formatFixed } from '../../core/amount.ts';
import { engineContext, type EngineContext } from '../../core/engine.ts';
import { getJson, postJson, router } from '../../net/http.ts';
import { bip39Seed } from '../seeds/bip39.ts';
import { t } from '../../core/i18n.ts';
import { TRON_DEFAULT_TOKENS } from '../tokens.gen.ts';
import { normalizeHomoglyphs, tokenIcon, type TokenAsset, type TokenWallet, type WalletToken } from '../tokens.ts';
import { decodeString, decodeUint, SELECTOR } from '../evm/eth.ts';
import { addressFromPrivateKey, decodeTrc20Transfer, encodeRawData, encodeTransaction, isValidTronAddress, refBlock, signPersonalMessage, signTransaction, toBase58, trc20BalanceOf, trc20Transfer, txId, verifyPersonalMessage, type RawDataJson } from './tron.ts';

export const TRON_PATH = "m/44'/195'/0'/0/0";
const POLL_MS = 30_000;
/** _signNativeTransaction defaultFeeLimit */
const DEFAULT_FEE_LIMIT = 269_000n;
/** history always comes from TronGrid (tron_client.dart fetchTransactions) */
const TRONGRID = 'https://api.trongrid.io';
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
/** a transaction is valid for 30 min (expiration); a pending send not seen by then is dropped */
const EXPIRY_MS = 30 * 60_000;

export async function tronPrivateKey(s: WalletSecrets): Promise<Uint8Array> {
  if (s.privateKey) return hexToBytes(s.privateKey);
  if (!s.mnemonic) throw new Error('No key for this wallet');
  return HDKey.fromMasterSeed(await bip39Seed(s.mnemonic, s.passphrase ?? '')).derive(TRON_PATH).privateKey!;
}

/** TronFeeEstimate.calculate */
export function tronFee(o: { energyUsed: bigint; availableEnergy: bigint; energyPrice: bigint; bandwidthUsed: bigint; bandwidthBurned: boolean; bandwidthPrice: bigint; memoFee?: bigint }): { feeLimit: bigint; burn: bigint } {
  const energyToBurn = o.energyUsed > o.availableEnergy ? o.energyUsed - o.availableEnergy : 0n;
  return {
    // the 20 % covers a dynamic energy increase
    feeLimit: (o.energyUsed * o.energyPrice * 120n) / 100n,
    burn: energyToBurn * o.energyPrice + (o.bandwidthBurned ? o.bandwidthUsed * o.bandwidthPrice : 0n) + (o.memoFee ?? 0n),
  };
}

/** bandwidth of a transaction: its size with a (dummy) 65-byte signature, plus 64 */
export function tronBandwidth(raw: Uint8Array): bigint {
  return BigInt(encodeTransaction(raw, [new Uint8Array(65)]).length + 64);
}

interface TronCache {
  v: 1;
  balances: Record<string, Balance>;
  txs: TransactionInfo[];
  /** symbol / decimals of TRC-20 contracts met in history */
  meta: Record<string, { symbol: string; decimals: number }>;
}

interface ChainParams {
  bandwidthPrice: bigint;
  energyPrice: bigint;
  memoFee: bigint;
}

const TRX_KEY = 'trx';

type TronBlock = { blockID: string; block_header: { raw_data: { number: number; timestamp: number } } };

/** at most `n` calls at a time (TronGrid allows 3 requests/s per IP without a key) */
async function limited<T>(n: number, jobs: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]();
    }
  }));
  return out;
}

export class TronWallet extends WalletBase implements TokenWallet {
  readonly currency: Currency = currency('trx');
  readonly ctx: EngineContext;
  readonly tokenList = signal<WalletToken[]>([]);
  readonly tokenStandard = 'TRC-20';
  address = '';
  #priv!: Uint8Array;
  #rpcUrl = '';
  #txs = new Map<string, TransactionInfo>();
  #meta: Record<string, { symbol: string; decimals: number }> = {};
  #params: { at: number; v: ChainParams } | null = null;
  #fees: { at: number; native: bigint; trc20: bigint } | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #syncing = false;
  #historyRunning = false;

  constructor(info: WalletInfo, secrets: WalletSecrets) {
    super(info, secrets);
    this.ctx = engineContext(info);
  }

  get hasTokens(): boolean {
    return true;
  }
  get tokens(): WalletToken[] {
    return this.tokenList.value;
  }

  async init(): Promise<void> {
    this.#priv = await tronPrivateKey(this.secrets);
    this.address = addressFromPrivateKey(this.#priv);
    this.receiveAddress.value = this.address;
    this.addresses.value = [{ address: this.address, label: '', index: 0 }];
    const saved = (await this.ctx.cacheGet<WalletToken[]>('trx:tokens')) ?? [];
    const byAddr = new Map(saved.map((x) => [x.address, x]));
    const list: WalletToken[] = [];
    for (const d of TRON_DEFAULT_TOKENS) {
      const ex = byAddr.get(d.address);
      list.push({ address: d.address, name: d.name, symbol: d.symbol, decimals: d.decimals, enabled: ex?.enabled ?? d.enabled, icon: tokenIcon(d.symbol.split('.')[0], d.icon) });
      byAddr.delete(d.address);
    }
    for (const x of byAddr.values()) list.push(x);
    this.tokenList.value = list;
    await this.ctx.cachePut('trx:tokens', list);
    const c = await this.ctx.cacheGet<TronCache>('trx');
    if (c) {
      this.balances.value = c.balances ?? {};
      for (const tx of c.txs ?? []) this.#txs.set(tx.id, tx);
      this.#meta = c.meta ?? {};
      this.#publishTxs();
    }
  }

  // ------------------------------------------------------------- rpc --

  /** TronHTTPProvider: TronGrid's key header when the URL is TronGrid's and the user set a key */
  #headers(url: string): Record<string, string> | undefined {
    const key = ((this.ctx.settings() as any).apiKeys?.trongrid ?? '').trim();
    return key && url.includes('trongrid') ? { 'TRON-PRO-API-KEY': key } : undefined;
  }

  #post<T = any>(path: string, body: unknown, purpose: string): Promise<T> {
    const url = `${this.#rpcUrl}${path}`;
    return postJson<T>(url, body, { scope: this.ctx.scope, timeoutMs: 45_000, retries: 3, purpose, headers: this.#headers(url) });
  }

  async #trigger(contract: string, data: string, purpose: string): Promise<any> {
    return this.#post('/wallet/triggerconstantcontract', { owner_address: this.address, contract_address: contract, data, visible: true }, purpose);
  }

  /** the newest block header (the small getblock; getnowblock carries every transaction of the block) */
  async #block(): Promise<TronBlock> {
    try {
      const b = await this.#post<any>('/wallet/getblock', { detail: false }, 'block');
      if (b?.blockID && b.block_header?.raw_data?.number !== undefined) return b;
    } catch { /* older nodes */ }
    return this.#post('/wallet/getnowblock', {}, 'block');
  }

  async #chainParams(): Promise<ChainParams> {
    if (this.#params && Date.now() - this.#params.at < 10 * 60_000) return this.#params.v;
    const r = await getJson<{ chainParameter?: { key: string; value?: number }[] }>(`${this.#rpcUrl}/wallet/getchainparameters`, { scope: this.ctx.scope, timeoutMs: 45_000, retries: 3, purpose: 'chain parameters', headers: this.#headers(this.#rpcUrl) });
    const p = new Map((r?.chainParameter ?? []).map((x) => [x.key, BigInt(x.value ?? 0)]));
    const v = { bandwidthPrice: p.get('getTransactionFee') ?? 1000n, energyPrice: p.get('getEnergyFee') ?? 100n, memoFee: p.get('getMemoFee') ?? 0n };
    this.#params = { at: Date.now(), v };
    return v;
  }

  /** AccountResourceModel: free + staked bandwidth left, energy left */
  async #resources(): Promise<{ bandwidth: bigint; energy: bigint }> {
    const r = await this.#post<any>('/wallet/getaccountresource', { address: this.address, visible: true }, 'resources');
    const n = (k: string) => BigInt(r?.[k] ?? 0);
    const energy = n('EnergyLimit') - n('EnergyUsed');
    return { bandwidth: n('freeNetLimit') + n('NetLimit') - n('NetUsed') - n('freeNetUsed'), energy: energy < 0n ? 0n : energy };
  }

  // --------------------------------------------------------- network --

  async connect(): Promise<void> {
    this.#rpcUrl = this.ctx.node().url.replace(/\/+$/, '');
    this.syncStatus.value = { kind: 'connecting' };
    const b = await this.#block();
    this.height.value = Number(b.block_header.raw_data.number);
    this.syncStatus.value = { kind: 'connected' };
    void this.#feeEstimates().catch(() => {});
  }

  async startSync(): Promise<void> {
    if (this.#closed) return;
    this.syncStatus.value = { kind: 'attempting' };
    await this.#sync(true);
    clearInterval(this.#timer);
    this.#timer = setInterval(() => void this.#sync(false), POLL_MS);
  }

  async #sync(first: boolean): Promise<void> {
    if (this.#syncing || this.#closed) return;
    this.#syncing = true;
    try {
      await this.#updateBalances();
      if (first) await this.#updateHistory().catch(() => {});
      else if (!this.#historyRunning) void this.#updateHistory().catch(() => {});
      await this.save();
      if (first || this.syncStatus.value.kind !== 'synced') this.syncStatus.value = { kind: 'synced' };
    } catch (e) {
      if (!this.#closed) this.syncStatus.value = { kind: 'failed', error: (e as Error).message };
    } finally {
      this.#syncing = false;
    }
  }

  async #updateBalances(): Promise<void> {
    const enabled = this.tokens.filter((x) => x.enabled);
    const [acct, ...tok] = await limited<any>(3, [
      () => this.#post<any>('/wallet/getaccount', { address: this.address, visible: true }, 'balance'),
      ...enabled.map((x) => () => this.#trigger(x.address, trc20BalanceOf(this.address), 'token balance').catch(() => null)),
    ]);
    const prev = this.balances.value;
    const trx = BigInt(acct?.balance ?? 0);
    const next: Record<string, Balance> = { [TRX_KEY]: { available: trx, full: trx } };
    enabled.forEach((x, i) => {
      const r = tok[i];
      const hexv = r?.constant_result?.[0];
      if (typeof hexv !== 'string' || r?.result?.result === false) {
        if (prev[x.address]) next[x.address] = prev[x.address];
        return;
      }
      const v = decodeUint(hexv);
      next[x.address] = { available: v, full: v };
    });
    this.balances.value = next;
  }

  // ---------------------------------------------------------- history --

  /** TronGrid sometimes turns a Tor exit away (403) or rate-limits it (429): other circuits */
  async #grid<T = any>(path: string, purpose: string): Promise<T> {
    const url = `${TRONGRID}${path}`;
    for (let attempt = 0; ; attempt++) {
      try {
        return await getJson<T>(url, { scope: this.ctx.scope, timeoutMs: 60_000, retries: 2, purpose, headers: this.#headers(url) });
      } catch (e) {
        if ((e as { status?: number })?.status !== 403 || attempt >= 2) throw e;
        router().rotateIsolation(url, this.ctx.scope);
      }
    }
  }

  /** TRC-20 symbol / decimals: the token list, the cache, or the contract itself (_getTrc20Currency) */
  async #tokenMeta(contract: string): Promise<{ symbol: string; decimals: number }> {
    const tk = this.tokens.find((x) => x.address === contract);
    if (tk) return { symbol: tk.symbol, decimals: tk.decimals };
    if (this.#meta[contract]) return this.#meta[contract];
    try {
      const [s, d] = await Promise.all([this.#trigger(contract, SELECTOR.symbol, 'token info'), this.#trigger(contract, SELECTOR.decimals, 'token info')]);
      const symbol = s?.constant_result?.[0] ? decodeString(s.constant_result[0]) : '';
      const dec = d?.constant_result?.[0] ? Number(decodeUint(d.constant_result[0])) : NaN;
      const m = { symbol, decimals: Number.isFinite(dec) ? dec : 6 };
      if (symbol && Number.isFinite(dec)) this.#meta[contract] = m;
      return m;
    } catch {
      return { symbol: '', decimals: 6 };
    }
  }

  #tokenInfoRow(id: string, contract: string, meta: { symbol: string; decimals: number }, base: Omit<TransactionInfo, 'id' | 'currency' | 'tokenSymbol' | 'tokenDecimals' | 'extra'>): TransactionInfo {
    const tk = this.tokens.find((x) => x.address === contract);
    return { ...base, id, currency: contract, tokenSymbol: meta.symbol, tokenDecimals: meta.decimals, extra: { contract, ...(tk?.icon && !tk.isPotentialScam ? { icon: tk.icon } : {}) } };
  }

  async #updateHistory(): Promise<void> {
    if (this.#historyRunning) return;
    this.#historyRunning = true;
    try {
      await this.#checkPending();
      if ((this.ctx.settings() as any).useTronGrid === false) return;
      const q = '?only_confirmed=true&limit=200';
      const [main, trc] = await Promise.all([
        this.#grid<{ data?: any[] }>(`/v1/accounts/${this.address}/transactions${q}`, 'history'),
        this.#grid<{ data?: any[] }>(`/v1/accounts/${this.address}/transactions/trc20${q}`, 'history (TRC-20)').catch(() => ({ data: [] as any[] })),
      ]);
      // fetchTransactions
      for (const tx of main?.data ?? []) {
        try {
          const ret = tx.ret?.[0];
          if (!ret?.contractRet || ret.contractRet !== 'SUCCESS') continue;
          const c = tx.raw_data?.contract?.[0];
          if (!c || c.type === 'TransferAssetContract') continue;
          const v = c.parameter?.value ?? {};
          const transfer = v.contract_address ? decodeTrc20Transfer(v.data) : null;
          const saved = this.#txs.get(tx.txID);
          if (!transfer && saved && !saved.isPending && saved.currency !== TRX_KEY) continue;
          const from = v.owner_address ? toBase58(v.owner_address) : '';
          const to = !v.contract_address ? (v.to_address ? toBase58(v.to_address) : undefined) : transfer ? transfer.to : toBase58(v.contract_address);
          const amount = !v.contract_address ? BigInt(v.amount ?? 0) : transfer ? transfer.amount : BigInt(v.call_value ?? 0);
          const base = { direction: from === this.address ? ('outgoing' as const) : ('incoming' as const), amount, fee: BigInt(ret.fee ?? 0), date: Number(tx.block_timestamp ?? 0), height: tx.blockNumber ? Number(tx.blockNumber) : undefined, confirmations: 1, isPending: false, from, to };
          if (transfer) {
            const contract = toBase58(v.contract_address);
            this.#txs.set(tx.txID, this.#tokenInfoRow(tx.txID, contract, await this.#tokenMeta(contract), base));
          } else {
            this.#txs.set(tx.txID, { ...base, id: tx.txID, currency: TRX_KEY });
          }
        } catch { /* malformed row */ }
      }
      // fetchTrc20ExcludedTransactions: incoming TRC-20 transfers (the receiver is neither owner nor to of the transaction)
      for (const r of trc?.data ?? []) {
        try {
          if (r.type !== 'Transfer') continue;
          const saved = this.#txs.get(r.transaction_id);
          if (saved && !saved.isPending && saved.currency !== TRX_KEY) continue;
          const contract = r.token_info?.address ? toBase58(r.token_info.address) : '';
          const meta = { symbol: r.token_info?.symbol ?? 'TRX', decimals: Number(r.token_info?.decimals ?? 6) };
          const base = { direction: r.from === this.address ? ('outgoing' as const) : ('incoming' as const), amount: BigInt(r.value ?? '0'), fee: saved?.fee ?? 0n, date: Number(r.block_timestamp ?? 0), confirmations: 1, isPending: false, from: r.from, to: r.to };
          this.#txs.set(r.transaction_id, contract ? this.#tokenInfoRow(r.transaction_id, contract, meta, base) : { ...base, id: r.transaction_id, currency: TRX_KEY, tokenSymbol: meta.symbol, tokenDecimals: meta.decimals });
        } catch { /* malformed row */ }
      }
      this.#publishTxs();
      await this.save();
    } finally {
      this.#historyRunning = false;
    }
  }

  /** sends from here: the node knows them once they are in a block; a failed or expired one is dropped */
  async #checkPending(): Promise<void> {
    const pending = [...this.#txs.values()].filter((x) => x.isPending);
    for (const x of pending) {
      try {
        const r = await this.#post<any>('/wallet/gettransactioninfobyid', { value: x.id }, 'receipt');
        if (r?.blockNumber) {
          const result = r.receipt?.result;
          if (result && result !== 'SUCCESS') this.#txs.delete(x.id);
          else this.#txs.set(x.id, { ...x, isPending: false, height: Number(r.blockNumber), confirmations: 1, fee: r.fee !== undefined ? BigInt(r.fee) : x.fee, date: r.blockTimeStamp ? Number(r.blockTimeStamp) : x.date });
        } else if (Date.now() - x.date > EXPIRY_MS + 5 * 60_000) {
          this.#txs.delete(x.id);
        }
      } catch { /* next time */ }
    }
    if (pending.length) this.#publishTxs();
  }

  #publishTxs(): void {
    this.transactions.value = [...this.#txs.values()].sort((a, b) => (a.isPending === b.isPending ? b.date - a.date : a.isPending ? -1 : 1));
  }

  // ------------------------------------------------------------- fees --

  priorities(): TransactionPriorityOption[] {
    return [];
  }

  defaultPriority(): string {
    return 'medium';
  }

  #transferRaw(to: string, amount: bigint, block: TronBlock): RawDataJson {
    const ref = refBlock(block);
    return {
      ref_block_bytes: ref.ref_block_bytes,
      ref_block_hash: ref.ref_block_hash,
      expiration: Date.now() + EXPIRY_MS,
      contract: [{ type: 'TransferContract', parameter: { type_url: 'type.googleapis.com/protocol.TransferContract', value: { owner_address: this.address, to_address: to, amount } } }],
      timestamp: ref.timestamp,
    };
  }

  #triggerRaw(contract: string, data: string, block: TronBlock): RawDataJson {
    const ref = refBlock(block);
    return {
      ref_block_bytes: ref.ref_block_bytes,
      ref_block_hash: ref.ref_block_hash,
      expiration: Date.now() + EXPIRY_MS,
      contract: [{ type: 'TriggerSmartContract', parameter: { type_url: 'type.googleapis.com/protocol.TriggerSmartContract', value: { owner_address: this.address, contract_address: contract, data } } }],
      timestamp: ref.timestamp,
    };
  }

  /** getEstimatedFee / getTRCEstimatedFee: a 1000 TRX self-transfer and a USDT transfer(self, 0), bandwidth always burned */
  async #feeEstimates(): Promise<{ native: bigint; trc20: bigint }> {
    if (this.#fees && Date.now() - this.#fees.at < 10 * 60_000) return this.#fees;
    const [params, res, block] = await Promise.all([this.#chainParams(), this.#resources(), this.#block()]);
    const native = tronFee({ energyUsed: 0n, availableEnergy: res.energy, energyPrice: params.energyPrice, bandwidthUsed: tronBandwidth(encodeRawData(this.#transferRaw(this.address, 1_000_000_000n, block))), bandwidthBurned: true, bandwidthPrice: params.bandwidthPrice }).burn;
    let trc20 = 0n;
    try {
      const data = trc20Transfer(this.address, 0n);
      const r = await this.#trigger(USDT, data, 'fee estimate');
      trc20 = tronFee({ energyUsed: BigInt(r?.energy_used ?? 0), availableEnergy: res.energy, energyPrice: params.energyPrice, bandwidthUsed: tronBandwidth(encodeRawData(this.#triggerRaw(USDT, data, block))), bandwidthBurned: true, bandwidthPrice: params.bandwidthPrice }).burn;
    } catch { /* stays 0, like Cake */ }
    this.#fees = { at: Date.now(), native, trc20 };
    return this.#fees;
  }

  async estimateFee(_priority: string, _amount?: bigint, asset?: string): Promise<bigint> {
    const f = await this.#feeEstimates().catch(() => ({ native: 0n, trc20: 0n }));
    return asset && asset !== TRX_KEY ? f.trc20 : f.native;
  }

  // ---------------------------------------------------------- sending --

  validateAddress(address: string): boolean {
    return isValidTronAddress(address);
  }

  async createTransaction(c: TransactionCredentials): Promise<PendingTransaction> {
    const assetKey = c.outputs[0]?.asset ?? TRX_KEY;
    const token = assetKey === TRX_KEY ? undefined : this.tokens.find((x) => x.address === assetKey);
    if (assetKey !== TRX_KEY && (!token || !token.enabled)) throw new Error(`Currency ${assetKey} is not accessible in the wallet, try to enable it first.`);
    const title = token ? token.symbol.toUpperCase() : 'TRX';
    const wrongBalance = new Error(`Wrong balance. Not enough ${title} on your balance.`);
    if (c.outputs.length !== 1) throw wrongBalance;
    const out = c.outputs[0];
    const to = (out.extractedAddress || out.address).trim();
    if (!isValidTronAddress(to)) throw new Error(t('error_text_address'));
    const trxBal = this.balances.value[TRX_KEY]?.available ?? 0n;
    const avail = token ? this.balances.value[token.address]?.available ?? 0n : trxBal;
    const amount = out.sendAll ? avail : out.amount;
    if (avail < amount || amount < 0n) throw wrongBalance;
    return token ? this.#trc20Transfer(token, to, amount, trxBal) : this.#nativeTransfer(to, amount, trxBal, out.sendAll);
  }

  #feeError(burn: bigint, newline: boolean): Error {
    return new Error(`You don't have enough TRX to cover the transaction fee for this transaction. Please top up.${newline ? '\n' : ' '}Transaction fee: ${formatFixed(burn, 6)} TRX`);
  }

  async #nativeTransfer(to: string, amount: bigint, trxBal: bigint, sendAll: boolean): Promise<PendingTransaction> {
    const [params, res, block] = await Promise.all([this.#chainParams(), this.#resources(), this.#block()]);
    let total = amount;
    // send-all: free bandwidth covers a transfer (269 bytes), else leave the estimated fee (+5000 sun)
    if (sendAll && res.bandwidth < 269n) total = amount - ((this.#fees?.native ?? (await this.#feeEstimates().catch(() => ({ native: 0n }))).native) + 5000n);
    if (total <= 0n) throw new Error('Wrong balance. Not enough TRX on your balance.');
    const raw0 = this.#transferRaw(to, total, block);
    const size = tronBandwidth(encodeRawData(raw0));
    const { burn } = tronFee({ energyUsed: 0n, availableEnergy: res.energy, energyPrice: params.energyPrice, bandwidthUsed: size, bandwidthBurned: res.bandwidth < size, bandwidthPrice: params.bandwidthPrice });
    if (burn > trxBal) throw this.#feeError(burn, true);
    const feeLimit = burn !== 0n ? burn : DEFAULT_FEE_LIMIT;
    return this.#pending(encodeRawData({ ...raw0, fee_limit: Number(feeLimit) }), total, feeLimit, to);
  }

  async #trc20Transfer(token: WalletToken, to: string, amount: bigint, trxBal: bigint): Promise<PendingTransaction> {
    const data = trc20Transfer(to, amount);
    const [params, res, block, sim] = await Promise.all([this.#chainParams(), this.#resources(), this.#block(), this.#trigger(token.address, data, 'energy estimate')]);
    if (sim?.result?.result !== true) throw new Error('An error occurred while creating the transfer request. Please try again.');
    if (sim.energy_used === undefined || sim.energy_used === null) throw new Error('Could not estimate the energy for this transfer. Please try again.');
    const raw0 = this.#triggerRaw(token.address, data, block);
    const size = tronBandwidth(encodeRawData(raw0));
    const fee = tronFee({ energyUsed: BigInt(sim.energy_used), availableEnergy: res.energy, energyPrice: params.energyPrice, bandwidthUsed: size, bandwidthBurned: res.bandwidth < size, bandwidthPrice: params.bandwidthPrice });
    if (fee.burn > trxBal) throw this.#feeError(fee.burn, false);
    return this.#pending(encodeRawData({ ...raw0, fee_limit: Number(fee.feeLimit) }), amount, fee.burn, to, token);
  }

  #pending(raw: Uint8Array, amount: bigint, fee: bigint, to: string, token?: WalletToken): PendingTransaction {
    const sig = signTransaction(raw, this.#priv);
    const id = txId(raw);
    const signed = encodeTransaction(raw, [sig]);
    return {
      id,
      amount,
      fee,
      hex: bytesToHex(signed),
      amountFormatted: formatFixed(amount, token ? token.decimals : 6),
      feeFormatted: formatFixed(fee, 6),
      commit: async () => {
        const r = await this.#post<any>('/wallet/broadcasthex', { transaction: bytesToHex(signed) }, 'broadcast');
        if (r?.result !== true) {
          const m = String(r?.message ?? r?.Error ?? r?.code ?? 'broadcast failed');
          throw new Error(/^[0-9a-f]+$/i.test(m) && m.length % 2 === 0 ? new TextDecoder().decode(hexToBytes(m)) : m);
        }
        const base = { direction: 'outgoing' as const, amount, fee, date: Date.now(), confirmations: 0, isPending: true, from: this.address, to };
        this.#txs.set(id, token ? this.#tokenInfoRow(id, token.address, { symbol: token.symbol, decimals: token.decimals }, base) : { ...base, id, currency: TRX_KEY });
        this.#publishTxs();
        await this.save();
        setTimeout(() => void this.#sync(false), 6_000);
      },
    };
  }

  // ----------------------------------------------------------- tokens --

  assetList(): TokenAsset[] {
    const b = this.balances.value;
    return [
      { key: TRX_KEY, name: 'TRON', symbol: 'TRX', decimals: 6, balance: b[TRX_KEY]?.available ?? 0n, api: 'crypto.TRX', icon: this.currency.iconPath ?? undefined, isNative: true },
      ...this.tokens.filter((x) => x.enabled).map((x) => ({ key: x.address, name: x.name, symbol: x.symbol, decimals: x.decimals, balance: b[x.address]?.available ?? 0n, api: `trx.${x.address}`, icon: x.isPotentialScam ? undefined : x.icon, address: x.address, isNative: false, isPotentialScam: x.isPotentialScam })),
    ];
  }

  isDefaultToken(address: string): boolean {
    return TRON_DEFAULT_TOKENS.some((d) => d.address === address.trim());
  }

  validateTokenAddress(address: string): boolean {
    return isValidTronAddress(address);
  }

  /** the add-token checks Cake applies to Tron: the native symbol or a default token's symbol on another contract */
  isSuspiciousToken(x: { name: string; symbol: string; address: string }): boolean {
    if (this.isDefaultToken(x.address)) return false;
    const sym = normalizeHomoglyphs(x.symbol.trim().toUpperCase());
    return sym === 'TRX' || TRON_DEFAULT_TOKENS.some((d) => d.symbol.toUpperCase() === sym);
  }

  /** getTronToken: name / symbol / decimals from the contract */
  async tokenInfo(address: string): Promise<{ name: string; symbol: string; decimals: number } | null> {
    const a = address.trim();
    if (!isValidTronAddress(a)) return null;
    try {
      const n = await this.#trigger(a, SELECTOR.name, 'token info').catch(() => null);
      const s = await this.#trigger(a, SELECTOR.symbol, 'token info').catch(() => null);
      const d = await this.#trigger(a, SELECTOR.decimals, 'token info').catch(() => null);
      const get = (r: any) => r?.constant_result?.[0] as string | undefined;
      if (!get(s) && !get(n)) return null;
      return { name: get(n) ? decodeString(get(n)!) : '', symbol: get(s) ? decodeString(get(s)!) : '', decimals: get(d) ? Number(decodeUint(get(d)!)) : 0 };
    } catch {
      return null;
    }
  }

  async checkContractRisk(): Promise<boolean> {
    return false;
  }

  async addToken(tok: WalletToken): Promise<void> {
    const a = tok.address.trim();
    const icon = tok.isPotentialScam ? undefined : tok.icon || tokenIcon(tok.symbol.split('.')[0]);
    this.tokenList.value = [...this.tokens.filter((x) => x.address !== a), { ...tok, address: a, icon }];
    await this.ctx.cachePut('trx:tokens', this.tokens);
    void this.#sync(false);
  }

  async deleteToken(address: string): Promise<void> {
    const tok = this.tokens.find((x) => x.address === address);
    this.tokenList.value = this.tokens.filter((x) => x.address !== address);
    const { [address]: _gone, ...rest } = this.balances.value;
    this.balances.value = rest;
    // _removeTokenTransactionsInHistory: by symbol
    for (const [id, tx] of this.#txs) if (tok && tx.tokenSymbol === tok.symbol) this.#txs.delete(id);
    this.#publishTxs();
    await this.ctx.cachePut('trx:tokens', this.tokens);
    await this.save();
  }

  async setTokenEnabled(address: string, enabled: boolean): Promise<void> {
    this.tokenList.value = this.tokens.map((x) => (x.address === address ? { ...x, enabled } : x));
    if (!enabled) {
      const { [address]: _gone, ...rest } = this.balances.value;
      this.balances.value = rest;
    }
    await this.ctx.cachePut('trx:tokens', this.tokens);
    await this.save();
    if (enabled) void this.#sync(false);
  }

  // ----------------------------------------------------------- others --

  async signMessage(message: string): Promise<string> {
    return signPersonalMessage(message, this.#priv);
  }

  async verifyMessage(message: string, signature: string, address?: string): Promise<boolean> {
    if (!address) return false;
    return verifyPersonalMessage(message, signature, address);
  }

  async keys(): Promise<WalletKeysRow[]> {
    return [{ label: t('private_key'), value: bytesToHex(this.#priv) }];
  }

  explorerUrl(txid: string): string {
    return `https://tronscan.org/#/transaction/${txid}`;
  }

  async save(): Promise<void> {
    const c: TronCache = { v: 1, balances: this.balances.value, txs: [...this.#txs.values()], meta: this.#meta };
    await this.ctx.cachePut('trx', c);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    await this.save().catch(() => {});
    this.#priv?.fill(0);
  }
}
