// EVM wallet engine (cw_evm/lib/evm_chain_wallet.dart + clients/*) for
// Ethereum, Polygon, Base, Arbitrum, BNB Smart Chain and Robinhood Chain:
// one key at m/44'/60'/0'/0/0, native + ERC-20 balances over JSON-RPC,
// Cake's priority fees and buffered max fee, EIP-1559 transactions on
// Ethereum and EIP-155 ones elsewhere, Etherscan V2 history (with the
// user's key) or Blockscout's Etherscan-compatible API (keyless), and the
// node's receipts for transactions sent from here.

import { signal } from '@preact/signals';
import { HDKey } from '@scure/bip32';
import { bytesToHex } from '@noble/hashes/utils.js';
import { WalletBase, type Balance, type PendingTransaction, type TransactionCredentials, type TransactionInfo, type TransactionPriorityOption, type WalletInfo, type WalletKeysRow, type WalletSecrets } from '../../core/wallet.ts';
import { currency, type Currency } from '../types.ts';
import { formatFixed } from '../../core/amount.ts';
import { engineContext, type EngineContext } from '../../core/engine.ts';
import { getJson, jsonRpc, jsonRpcBatch, qs, router, RpcError } from '../../net/http.ts';
import { bip39Seed } from '../seeds/bip39.ts';
import { t } from '../../core/i18n.ts';
import { bufferedMaxFeePerGas, chainOf, METHOD_SIGNATURES, type EvmChain, type EvmPriority } from './chains.ts';
import { addressFromPrivateKey, decodeString, decodeUint, encodeCall, erc20BalanceOf, erc20Transfer, fromQuantity, hex, isValidEvmAddress, memoData, SELECTOR, signPersonalMessage, signTransaction, toQuantity, unhex, verifyPersonalMessage } from './eth.ts';
import { EVM_DEFAULT_TOKENS } from '../tokens.gen.ts';
import { isTokenPropertiesSuspicious, tokenIcon, type TokenAsset, type TokenWallet, type WalletToken } from '../tokens.ts';

const GWEI = 1_000_000_000n;
const TIP: Record<EvmPriority, bigint> = { slow: 1n, medium: 2n, fast: 4n };
const SPAM_THRESHOLD_WEI = 10_000_000_000_000n;
const POLL_MS = 20_000;

export const EVM_PATH = "m/44'/60'/0'/0";

export async function evmPrivateKey(s: WalletSecrets): Promise<Uint8Array> {
  if (s.privateKey) return unhex(s.privateKey);
  if (!s.mnemonic) throw new Error('No key for this wallet');
  const seed = await bip39Seed(s.mnemonic, s.passphrase ?? '');
  return HDKey.fromMasterSeed(seed).derive(`${EVM_PATH}/0`).privateKey!;
}

/** Etherscan txlist/tokentx/txlistinternal row */
export interface ScanRow {
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  gasUsed?: string;
  gasPrice?: string;
  contractAddress?: string;
  confirmations?: string;
  blockNumber?: string;
  tokenSymbol?: string;
  tokenDecimal?: string;
  isError?: string;
  input?: string;
}

function netFlow(r: ScanRow, me: string): bigint {
  const v = BigInt(r.value ?? '0');
  const incoming = r.to?.toLowerCase() === me;
  const outgoing = r.from?.toLowerCase() === me;
  if (incoming && !outgoing) return v;
  if (outgoing && !incoming) return -v;
  return 0n;
}

/** EVMChainClient.fetchTransactions: drop zero-value rows (and dust incoming native ones), merge rows of one tx by net flow */
export function processScanRows(rows: ScanRow[], address: string, tokenRows: boolean): ScanRow[] {
  const me = address.toLowerCase();
  let res = rows.filter((r) => r.value !== '0');
  if (!tokenRows) {
    res = res.filter((r) => {
      try {
        const incoming = r.to?.toLowerCase() === me && r.from?.toLowerCase() !== me;
        return !(incoming && BigInt(r.value ?? '0') < SPAM_THRESHOLD_WEI);
      } catch {
        return true;
      }
    });
  }
  const merged = new Map<string, ScanRow>();
  for (const r of res) {
    const key = `${r.hash}_${r.contractAddress ?? ''}`;
    const ex = merged.get(key);
    if (!ex) {
      merged.set(key, { ...r });
      continue;
    }
    try {
      const total = netFlow(ex, me) + netFlow(r, me);
      ex.value = (total < 0n ? -total : total).toString();
      if (total < 0n) ex.from = me;
      else {
        ex.to = me;
        ex.from = '';
      }
    } catch { /* keep the first row */ }
  }
  return [...merged.values()];
}

export function analyzeInput(input?: string): string | undefined {
  if (!input || input === '0x') return '';
  return input.length >= 10 ? METHOD_SIGNATURES[input.slice(0, 10)] : undefined;
}

interface EvmCache {
  v: 1;
  balances: Record<string, Balance>;
  txs: TransactionInfo[];
  height: number;
}

export class EvmWallet extends WalletBase implements TokenWallet {
  readonly chain: EvmChain;
  readonly currency: Currency;
  readonly ctx: EngineContext;
  readonly tokenList = signal<WalletToken[]>([]);
  readonly tokenStandard: string;
  address = '';
  #priv!: Uint8Array;
  #rpcUrl = '';
  #txs = new Map<string, TransactionInfo>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #syncing = false;
  #fees = new Map<string, { at: number; native: bigint; erc20: bigint }>();

  constructor(info: WalletInfo, secrets: WalletSecrets) {
    super(info, secrets);
    this.chain = chainOf(info.type);
    this.currency = currency(this.chain.currency);
    this.ctx = engineContext(info);
    this.tokenStandard = info.type === 'bsc' ? 'BEP-20' : 'ERC-20';
  }

  get chainId(): number {
    return this.chain.chainId;
  }
  get rpcUrl(): string {
    return this.#rpcUrl;
  }
  get hasTokens(): boolean {
    return true;
  }
  get tokens(): WalletToken[] {
    return this.tokenList.value;
  }

  async init(): Promise<void> {
    this.#priv = await evmPrivateKey(this.secrets);
    this.address = addressFromPrivateKey(this.#priv);
    this.receiveAddress.value = this.address;
    this.addresses.value = [{ address: this.address, label: '', index: 0 }];
    await this.#initTokens();
    const c = await this.ctx.cacheGet<EvmCache>('evm');
    if (c) {
      this.balances.value = c.balances ?? {};
      for (const tx of c.txs ?? []) this.#txs.set(tx.id, tx);
      this.height.value = c.height ?? 0;
      this.#publishTxs();
    }
  }

  /** addInitialTokens: Cake's defaults are (re)added keeping the user's enabled flag; stored custom tokens get the spam check */
  async #initTokens(): Promise<void> {
    const saved = (await this.ctx.cacheGet<WalletToken[]>('evm:tokens')) ?? [];
    const byAddr = new Map(saved.map((x) => [x.address.toLowerCase(), x]));
    const defaults = EVM_DEFAULT_TOKENS[this.type] ?? [];
    const list: WalletToken[] = [];
    for (const d of defaults) {
      const a = d.address.toLowerCase();
      const ex = byAddr.get(a);
      list.push({ address: a, name: d.name, symbol: d.symbol, decimals: d.decimals, enabled: ex?.enabled ?? d.enabled, icon: tokenIcon(d.symbol, d.icon), groups: d.groups });
      byAddr.delete(a);
    }
    for (const x of byAddr.values()) list.push({ ...x, address: x.address.toLowerCase(), isPotentialScam: x.isPotentialScam || this.isSuspiciousToken(x) });
    this.tokenList.value = list;
    await this.ctx.cachePut('evm:tokens', list);
  }

  // ------------------------------------------------------------- rpc --

  #rpc<T = any>(method: string, params: unknown[] = [], purpose?: string): Promise<T> {
    return jsonRpc<T>(this.#rpcUrl, method, params, { scope: this.ctx.scope, timeoutMs: 45_000, retries: 2, purpose: purpose ?? method });
  }

  /** several calls in one HTTP request; one by one if the node refuses batches */
  async #batch(calls: { method: string; params: unknown[] }[], purpose: string): Promise<(any | RpcError)[]> {
    const out: (any | RpcError)[] = [];
    for (let i = 0; i < calls.length; i += 20) {
      const chunk = calls.slice(i, i + 20);
      try {
        out.push(...(await jsonRpcBatch(this.#rpcUrl, chunk, { scope: this.ctx.scope, timeoutMs: 45_000, retries: 2, purpose })));
      } catch {
        out.push(...(await Promise.all(chunk.map((c) => this.#rpc(c.method, c.params, purpose).catch((e) => (e instanceof RpcError ? e : new RpcError((e as Error).message, -1)))))));
      }
    }
    return out;
  }

  // --------------------------------------------------------- network --

  async connect(): Promise<void> {
    this.#rpcUrl = this.ctx.node().url.replace(/\/+$/, '');
    this.syncStatus.value = { kind: 'connecting' };
    this.height.value = Number(fromQuantity(await this.#rpc<string>('eth_blockNumber', [], 'height')));
    this.syncStatus.value = { kind: 'connected' };
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
      await Promise.all([this.#updateTransactions().catch(() => {}), first ? this.#feeEstimates('medium').catch(() => {}) : Promise.resolve()]);
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
    const calls = [
      { method: 'eth_getBalance', params: [this.address, 'latest'] },
      { method: 'eth_blockNumber', params: [] },
      ...enabled.map((x) => ({ method: 'eth_call', params: [{ to: x.address, data: hex(erc20BalanceOf(this.address)) }, 'latest'] })),
    ];
    const res = await this.#batch(calls, 'balances');
    if (res[0] instanceof RpcError) throw res[0];
    const prev = this.balances.value;
    const next: Record<string, Balance> = {};
    const nat = fromQuantity(res[0]);
    next[this.currency.key] = { available: nat, full: nat };
    if (!(res[1] instanceof RpcError)) this.height.value = Number(fromQuantity(res[1]));
    enabled.forEach((x, i) => {
      const r = res[i + 2];
      if (r instanceof RpcError || typeof r !== 'string') {
        if (prev[x.address]) next[x.address] = prev[x.address];
        return;
      }
      const v = decodeUint(r);
      next[x.address] = { available: v, full: v };
    });
    this.balances.value = next;
  }

  // ---------------------------------------------------------- history --

  /** where history comes from: Etherscan V2 with the user's key, else the chain's Blockscout (keyless), else none */
  #scanApi(): { base: string; params: Record<string, string> } | null {
    const s = this.ctx.settings() as any;
    if (s[this.chain.scanSetting] === false) return null;
    const key = (s.apiKeys?.etherscan ?? '').trim();
    if (key) return { base: 'https://api.etherscan.io/v2/api', params: { chainid: String(this.chain.chainId), apikey: key } };
    if (this.chain.blockscout) return { base: this.chain.blockscout, params: {} };
    return null;
  }

  async #scan(action: string, extra: Record<string, string> = {}): Promise<ScanRow[]> {
    const api = this.#scanApi();
    if (!api) return [];
    const url = `${api.base}${qs({ ...api.params, module: 'account', action, address: this.address.toLowerCase(), ...extra })}`;
    // Cloudflare in front of some explorers turns away some Tor exits: try other circuits
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await getJson<{ status?: string; message?: string; result?: unknown }>(url, { scope: this.ctx.scope, timeoutMs: 60_000, retries: 1, purpose: `history ${action}` });
        return Array.isArray(r?.result) ? (r.result as ScanRow[]) : [];
      } catch (e) {
        if ((e as any)?.status !== 403 || attempt >= 2) throw e;
        router().rotateIsolation(url, this.ctx.scope);
      }
    }
  }

  async #updateTransactions(): Promise<void> {
    if (this.#scanApi()) {
      const me = this.address.toLowerCase();
      const enabled = new Set(this.tokens.filter((x) => x.enabled).map((x) => x.address));
      const [external, tokenTx, internal] = await Promise.all([this.#scan('txlist'), this.#scan('tokentx').catch(() => []), this.#scan('txlistinternal').catch(() => [])]);
      const rows: (ScanRow & { sig?: string })[] = [];
      for (const r of processScanRows(external, me, false)) {
        const sig = analyzeInput(r.input);
        if (sig !== 'depositWithExpiry' && sig !== 'transfer') rows.push({ ...r, sig });
      }
      rows.push(...processScanRows(tokenTx.filter((r) => enabled.has((r.contractAddress ?? '').toLowerCase())), me, true));
      rows.push(...internal);
      const result = new Map<string, TransactionInfo>();
      for (const r of rows) {
        if (r.isError === '1') continue;
        const info = this.#infoFromRow(r, me);
        const ex = result.get(info.id);
        const saved = this.#txs.get(info.id);
        if (saved && !saved.isPending && saved.direction === 'incoming' && info.direction === 'outgoing') {
          result.set(info.id, saved);
          continue;
        }
        if (!ex) result.set(info.id, info);
        else if (info.direction === 'incoming' && ex.direction === 'outgoing') result.set(info.id, info);
        else if (info.direction === 'outgoing' && ex.direction === 'outgoing' && info.extra?.contract && !ex.extra?.contract) result.set(info.id, info);
        else if (ex.isPending) result.set(info.id, info);
      }
      for (const [id, info] of result) this.#txs.set(id, info);
    }
    await this.#checkPending();
    this.#publishTxs();
  }

  #infoFromRow(r: ScanRow & { sig?: string }, me: string): TransactionInfo {
    const contract = (r.contractAddress ?? '').toLowerCase();
    const token = r.tokenSymbol !== undefined ? this.tokens.find((x) => x.address === contract) : undefined;
    const isToken = r.tokenSymbol !== undefined && !!contract;
    let fee = 0n;
    try {
      fee = BigInt(r.gasUsed || '0') * BigInt(r.gasPrice || '0');
    } catch { /* missing */ }
    return {
      id: r.hash,
      currency: isToken ? contract : this.currency.key,
      direction: r.from?.toLowerCase() === me ? 'outgoing' : 'incoming',
      amount: BigInt(r.value || '0'),
      fee,
      date: Number(r.timeStamp) * 1000,
      height: r.blockNumber ? Number(r.blockNumber) : undefined,
      confirmations: Number(r.confirmations ?? 0),
      isPending: false,
      from: r.from || undefined,
      to: r.to || undefined,
      tokenSymbol: isToken ? r.tokenSymbol || token?.symbol : undefined,
      tokenDecimals: isToken ? Number(r.tokenDecimal ?? token?.decimals ?? 18) : undefined,
      evmSignatureName: r.sig || undefined,
      extra: isToken ? { contract, ...(token?.icon && !token.isPotentialScam ? { icon: token.icon } : {}) } : undefined,
    };
  }

  /** transactions sent from here: the node's receipt confirms (or drops) them */
  async #checkPending(): Promise<void> {
    const pending = [...this.#txs.values()].filter((x) => x.isPending);
    if (!pending.length) return;
    const res = await this.#batch(pending.map((x) => ({ method: 'eth_getTransactionReceipt', params: [x.id] })), 'receipt');
    pending.forEach((x, i) => {
      const r = res[i];
      if (!r || r instanceof RpcError) {
        if (Date.now() - x.date > 3 * 86_400_000) this.#txs.delete(x.id);
        return;
      }
      if (r.status === '0x0') {
        this.#txs.delete(x.id);
        return;
      }
      const block = Number(fromQuantity(r.blockNumber));
      const gasUsed = fromQuantity(r.gasUsed);
      const price = fromQuantity(r.effectiveGasPrice);
      this.#txs.set(x.id, { ...x, isPending: false, height: block, confirmations: Math.max(1, this.height.value - block + 1), fee: gasUsed && price ? gasUsed * price : x.fee });
    });
  }

  #publishTxs(): void {
    const enabled = new Set(this.tokens.filter((x) => x.enabled).map((x) => x.address));
    this.transactions.value = [...this.#txs.values()]
      .filter((x) => x.currency === this.currency.key || enabled.has(x.currency))
      .sort((a, b) => (a.isPending === b.isPending ? b.date - a.date : a.isPending ? -1 : 1));
  }

  // ------------------------------------------------------------- fees --

  priorities(): TransactionPriorityOption[] {
    if (!this.chain.hasPriorityFee) return [];
    return (['fast', 'medium', 'slow'] as const).map((id) => ({ id, label: t(`transaction_priority_${id}`) }));
  }

  defaultPriority(): string {
    return 'medium';
  }

  #prio(p?: string): EvmPriority {
    return p === 'slow' || p === 'fast' ? p : 'medium';
  }

  /** _getNativeTxFee / _getErc20TxFee: gas of a self-transfer (or a USDC transfer to self) × (base fee or gas price + priority fee) */
  async #feeEstimates(priority: EvmPriority): Promise<{ native: bigint; erc20: bigint }> {
    const c = this.#fees.get(priority);
    if (c && Date.now() - c.at < 20_000) return c;
    const res = await this.#batch(
      [
        { method: 'eth_gasPrice', params: [] },
        { method: 'eth_getBlockByNumber', params: ['latest', false] },
        { method: 'eth_estimateGas', params: [{ from: this.address, to: this.address, value: '0x0' }] },
        { method: 'eth_estimateGas', params: [{ from: this.address, to: this.chain.usdc, data: hex(erc20Transfer(this.address, 0n)) }] },
      ],
      'fee estimate',
    );
    const gasPrice = res[0] instanceof RpcError ? 0n : fromQuantity(res[0]);
    const baseFee = res[1] instanceof RpcError || !res[1]?.baseFeePerGas ? null : fromQuantity(res[1].baseFeePerGas);
    const prio = this.chain.hasPriorityFee ? this.chain.priorityFee(priority) : 0n;
    const perGas = (baseFee ?? gasPrice) + prio;
    const gas = (r: unknown) => (r instanceof RpcError || typeof r !== 'string' ? 0n : fromQuantity(r));
    const out = { at: Date.now(), native: gas(res[2]) * perGas, erc20: gas(res[3]) * perGas };
    this.#fees.set(priority, out);
    return out;
  }

  async estimateFee(priority: string, _amount?: bigint, asset?: string): Promise<bigint> {
    const f = await this.#feeEstimates(this.#prio(priority));
    return asset && asset !== this.currency.key ? f.erc20 : f.native;
  }

  /** calculateActualEstimatedFeeForCreateTransaction */
  async #gasParams(priority: EvmPriority, call: { to: string; value: bigint; data?: Uint8Array }): Promise<{ gas: bigint; maxFeePerGas: bigint }> {
    const res = await this.#batch(
      [
        { method: 'eth_gasPrice', params: [] },
        { method: 'eth_getBlockByNumber', params: ['latest', false] },
        { method: 'eth_estimateGas', params: [{ from: this.address, to: call.to, value: toQuantity(call.value), ...(call.data?.length ? { data: hex(call.data) } : {}) }] },
      ],
      'gas',
    );
    const gasPrice = res[0] instanceof RpcError ? 0n : fromQuantity(res[0]);
    if (gasPrice <= 0n) throw new Error('Failed to retrieve gas price from node');
    const baseFee = res[1] instanceof RpcError || !res[1]?.baseFeePerGas ? null : fromQuantity(res[1].baseFeePerGas);
    const prio = this.chain.hasPriorityFee ? this.chain.priorityFee(priority) : 0n;
    const maxFeePerGas = bufferedMaxFeePerGas(baseFee, gasPrice, prio, this.chain.hasPriorityFee);
    if (res[2] instanceof RpcError) throw new Error(`Failed to calculate transaction fees: ${res[2].message}`);
    return { gas: fromQuantity(res[2]), maxFeePerGas };
  }

  // ---------------------------------------------------------- sending --

  validateAddress(address: string): boolean {
    return isValidEvmAddress(address);
  }

  async createTransaction(c: TransactionCredentials): Promise<PendingTransaction> {
    if (c.outputs.length !== 1) throw new Error('Wrong balance. Not enough funds on your balance.');
    const out = c.outputs[0];
    const assetKey = out.asset ?? this.currency.key;
    const token = assetKey === this.currency.key ? undefined : this.tokens.find((x) => x.address === assetKey.toLowerCase());
    if (assetKey !== this.currency.key && (!token || !token.enabled)) throw new Error(`Currency ${token?.symbol ?? assetKey} is not accessible in the wallet, try to enable it first.`);
    const title = token ? token.symbol.toUpperCase() : this.currency.title;
    const to = (out.extractedAddress || out.address).trim();
    if (!isValidEvmAddress(to)) throw new Error(t('error_text_address'));
    const bal = this.balances.value;
    const nativeAvail = bal[this.currency.key]?.available ?? 0n;
    const avail = token ? bal[token.address]?.available ?? 0n : nativeAvail;
    let amount = out.sendAll ? (token ? avail : 0n) : out.amount;
    const priority = this.#prio(c.priority);
    const memo = !token && out.memo ? memoData(out.memo) : undefined;
    const g = token ? await this.#gasParams(priority, { to: token.address, value: 0n, data: erc20Transfer(to, amount) }) : await this.#gasParams(priority, { to, value: amount });
    let fee = g.gas * g.maxFeePerGas;
    if (out.sendAll && !token) {
      if (this.chain.chainId === 8453) {
        const pct = (fee * 110n) / 100n;
        const min = fee + 10_000n;
        fee = pct > min ? pct : min;
      }
      amount = nativeAvail - fee;
    }
    const feeError = `Transaction failed due to insufficient ${this.currency.title} balance to cover the fees.`;
    if (fee > nativeAvail) throw new Error(feeError);
    if (avail < amount || amount <= 0n) throw new Error(`Wrong balance. Not enough ${title} on your balance.`);
    if (!token && amount + fee > nativeAvail) throw new Error(feeError);
    const nonce = fromQuantity(await this.#rpc<string>('eth_getTransactionCount', [this.address, 'pending'], 'nonce'));
    const { raw, hash } = signTransaction(
      {
        chainId: this.chain.chainId,
        nonce,
        to: token ? token.address : to,
        value: token ? 0n : amount,
        data: token ? erc20Transfer(to, amount) : memo ?? new Uint8Array(0),
        gasLimit: g.gas,
        ...(this.chain.eip1559 ? { maxFeePerGas: g.maxFeePerGas, maxPriorityFeePerGas: TIP[priority] * GWEI } : { gasPrice: g.maxFeePerGas }),
      },
      this.#priv,
    );
    return {
      id: hash,
      amount,
      fee,
      hex: hex(raw),
      amountFormatted: formatFixed(amount, token ? token.decimals : 18),
      feeFormatted: formatFixed(fee, 18, { fractionDigits: 10 }),
      commit: async () => {
        await this.#broadcast(hex(raw));
        this.#txs.set(hash, {
          id: hash,
          currency: token ? token.address : this.currency.key,
          direction: 'outgoing',
          amount,
          fee,
          date: Date.now(),
          confirmations: 0,
          isPending: true,
          from: this.address,
          to,
          tokenSymbol: token?.symbol,
          tokenDecimals: token?.decimals,
          extra: token ? { contract: token.address, ...(token.icon && !token.isPotentialScam ? { icon: token.icon } : {}) } : undefined,
        });
        this.#publishTxs();
        await this.save();
        setTimeout(() => void this.#sync(false), 4_000);
      },
    };
  }

  /** eth_sendRawTransaction, first through Blink (MEV protection) on Ethereum/Base when its key is set */
  /** eth_call: a contract's view, the raw result */
  async callContract(to: string, data: Uint8Array): Promise<string> {
    return this.#rpc<string>('eth_call', [{ from: this.address, to, data: hex(data) }, 'latest'], 'contract call');
  }

  /**
   * A call into a contract (an approval, a deposit…): the gas estimated by the node, the fee checked against the coin
   * balance, signed. `amount` is only what the confirmation shows (in `amountDecimals`).
   */
  async createContractCall(to: string, data: Uint8Array, opts: { priority?: string; amount?: bigint; amountDecimals?: number } = {}): Promise<PendingTransaction> {
    const priority = this.#prio(opts.priority ?? this.defaultPriority());
    const g = await this.#gasParams(priority, { to, value: 0n, data });
    const fee = g.gas * g.maxFeePerGas;
    const nativeAvail = this.balances.value[this.currency.key]?.available ?? 0n;
    if (fee > nativeAvail) throw new Error(`Transaction failed due to insufficient ${this.currency.title} balance to cover the fees.`);
    const nonce = fromQuantity(await this.#rpc<string>('eth_getTransactionCount', [this.address, 'pending'], 'nonce'));
    const { raw, hash } = signTransaction(
      {
        chainId: this.chain.chainId,
        nonce,
        to,
        value: 0n,
        data,
        gasLimit: g.gas,
        ...(this.chain.eip1559 ? { maxFeePerGas: g.maxFeePerGas, maxPriorityFeePerGas: TIP[priority] * GWEI } : { gasPrice: g.maxFeePerGas }),
      },
      this.#priv,
    );
    const amount = opts.amount ?? 0n;
    return {
      id: hash,
      amount,
      fee,
      hex: hex(raw),
      amountFormatted: formatFixed(amount, opts.amountDecimals ?? 18),
      feeFormatted: formatFixed(fee, 18, { fractionDigits: 10 }),
      commit: async () => {
        await this.#broadcast(hex(raw));
        this.#txs.set(hash, { id: hash, currency: this.currency.key, direction: 'outgoing', amount: 0n, fee, date: Date.now(), confirmations: 0, isPending: true, from: this.address, to });
        this.#publishTxs();
        await this.save();
        setTimeout(() => void this.#sync(false), 4_000);
      },
    };
  }

  async #broadcast(raw: string): Promise<void> {
    const s = this.ctx.settings() as any;
    const blink = (s.apiKeys?.blink ?? '').trim();
    if (blink && s.useBlinkProtection && (this.chain.chainId === 1 || this.chain.chainId === 8453)) {
      try {
        await jsonRpc(`https://eth.blinklabs.xyz/v1/${encodeURIComponent(blink)}`, 'eth_sendRawTransaction', [raw], { scope: this.ctx.scope, timeoutMs: 45_000, retries: 0, purpose: 'broadcast (Blink)' });
        return;
      } catch { /* fall back to the node */ }
    }
    await this.#rpc('eth_sendRawTransaction', [raw], 'broadcast');
  }

  // ----------------------------------------------------------- tokens --

  assetList(): TokenAsset[] {
    const b = this.balances.value;
    const native: TokenAsset = { key: this.currency.key, name: this.currency.fullName ?? this.currency.title, symbol: this.currency.title, decimals: 18, balance: b[this.currency.key]?.available ?? 0n, api: `crypto.${this.currency.title}`, icon: this.currency.iconPath ?? undefined, isNative: true };
    return [
      native,
      ...this.tokens
        .filter((x) => x.enabled)
        .map((x) => ({ key: x.address, name: x.name, symbol: x.symbol, decimals: x.decimals, balance: b[x.address]?.available ?? 0n, api: `evm.${x.address}`, icon: x.isPotentialScam ? undefined : x.icon, address: x.address, isNative: false, isPotentialScam: x.isPotentialScam, groups: x.groups })),
    ];
  }

  isDefaultToken(address: string): boolean {
    return (EVM_DEFAULT_TOKENS[this.type] ?? []).some((d) => d.address.toLowerCase() === address.trim().toLowerCase());
  }

  validateTokenAddress(address: string): boolean {
    return isValidEvmAddress(address);
  }

  isSuspiciousToken(x: { name: string; symbol: string; address: string }): boolean {
    const defaults = EVM_DEFAULT_TOKENS[this.type] ?? [];
    return isTokenPropertiesSuspicious(x, { nativeSymbol: this.currency.title, whitelist: new Set(defaults.map((d) => d.address.toLowerCase())), defaultSymbols: new Set(defaults.map((d) => d.symbol.toUpperCase())) });
  }

  /** on-chain name/symbol/decimals (getErcTokenInfoFromNode) */
  async tokenInfo(address: string): Promise<{ name: string; symbol: string; decimals: number } | null> {
    const to = address.trim();
    if (!isValidEvmAddress(to)) return null;
    const res = await this.#batch([SELECTOR.name, SELECTOR.symbol, SELECTOR.decimals].map((sel) => ({ method: 'eth_call', params: [{ to, data: hex(encodeCall(sel)) }, 'latest'] })), 'token info');
    if (res.some((r) => r instanceof RpcError || typeof r !== 'string' || r === '0x')) return null;
    return { name: decodeString(res[0]), symbol: decodeString(res[1]), decimals: Number(decodeUint(res[2])) };
  }

  /** "potential scam" contract check: unverified source on the chain's explorer (Etherscan with a key, else Blockscout); unknown counts as risky */
  async checkContractRisk(address: string): Promise<boolean> {
    const s = this.ctx.settings() as any;
    const key = (s.apiKeys?.etherscan ?? '').trim();
    const base = key ? 'https://api.etherscan.io/v2/api' : this.chain.blockscout;
    if (!base) return true;
    try {
      const r = await getJson<any>(`${base}${qs({ ...(key ? { chainid: this.chain.chainId, apikey: key } : {}), module: 'contract', action: 'getsourcecode', address: address.trim() })}`, { scope: this.ctx.scope, timeoutMs: 45_000, retries: 1, purpose: 'token contract check' });
      if (String(r?.status) === '0') return true;
      const row = Array.isArray(r?.result) ? r.result[0] : null;
      return !row || row.ABI === 'Contract source code not verified' || !row.SourceCode;
    } catch {
      return true;
    }
  }

  async addToken(tok: WalletToken): Promise<void> {
    const a = tok.address.trim().toLowerCase();
    this.tokenList.value = [...this.tokens.filter((x) => x.address !== a), { ...tok, address: a }];
    await this.ctx.cachePut('evm:tokens', this.tokens);
    void this.#sync(false);
  }

  async deleteToken(address: string): Promise<void> {
    const a = address.toLowerCase();
    this.tokenList.value = this.tokens.filter((x) => x.address !== a);
    this.#dropToken(a);
    await this.ctx.cachePut('evm:tokens', this.tokens);
    await this.save();
  }

  async setTokenEnabled(address: string, enabled: boolean): Promise<void> {
    const a = address.toLowerCase();
    this.tokenList.value = this.tokens.map((x) => (x.address === a ? { ...x, enabled } : x));
    if (!enabled) this.#dropToken(a);
    await this.ctx.cachePut('evm:tokens', this.tokens);
    await this.save();
    if (enabled) void this.#sync(false);
  }

  /** a disabled/deleted token leaves the balances and its transactions leave the history */
  #dropToken(a: string): void {
    const { [a]: _gone, ...rest } = this.balances.value;
    this.balances.value = rest;
    for (const [id, tx] of this.#txs) if (tx.currency === a) this.#txs.delete(id);
    this.#publishTxs();
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
    return `${this.chain.explorer}/tx/${txid}`;
  }

  async save(): Promise<void> {
    const c: EvmCache = { v: 1, balances: this.balances.value, txs: [...this.#txs.values()], height: this.height.value };
    await this.ctx.cachePut('evm', c);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    await this.save().catch(() => {});
    this.#priv?.fill(0);
  }
}
