// Thin client for a monero-ts wallet living in the wallet worker
// (monero-ts worker message protocol: [objectId, fnName, callbackId, ...args]).

import type { WalletWorker } from './engine.ts';

export interface XmrTx {
  hash: string;
  isOutgoing: boolean;
  amount: bigint;
  fee: bigint;
  height?: number;
  timestamp?: number;
  confirmations: number;
  isConfirmed: boolean;
  isFailed: boolean;
  isLocked: boolean;
  accountIndex: number;
  subaddressIndices: number[];
  destinations: { address: string; amount: bigint }[];
  paymentId?: string;
  unlockTime?: number;
}

function parseTxs(blocksOrTxs: any): XmrTx[] {
  const out: XmrTx[] = [];
  const push = (tx: any, height?: number, timestamp?: number) => {
    const ins = tx.incomingTransfers ?? [];
    const outT = tx.outgoingTransfer;
    if (outT) {
      out.push({
        hash: tx.hash,
        isOutgoing: true,
        amount: BigInt(outT.amount ?? 0),
        fee: BigInt(tx.fee ?? 0),
        height,
        timestamp,
        confirmations: tx.numConfirmations ?? 0,
        isConfirmed: !!tx.isConfirmed,
        isFailed: !!tx.isFailed,
        isLocked: !!tx.isLocked,
        accountIndex: outT.accountIndex ?? 0,
        subaddressIndices: outT.subaddressIndices ?? [],
        destinations: (outT.destinations ?? []).map((d: any) => ({ address: d.address, amount: BigInt(d.amount ?? 0) })),
        paymentId: tx.paymentId && !/^0+$/.test(tx.paymentId) ? tx.paymentId : undefined,
        unlockTime: tx.unlockTime ? Number(tx.unlockTime) : undefined,
      });
    }
    // incoming transfers grouped per account (a tx can pay several accounts)
    const byAccount = new Map<number, { amount: bigint; subs: number[] }>();
    for (const t of ins) {
      const a = t.accountIndex ?? 0;
      const e = byAccount.get(a) ?? { amount: 0n, subs: [] };
      e.amount += BigInt(t.amount ?? 0);
      e.subs.push(t.subaddressIndex ?? 0);
      byAccount.set(a, e);
    }
    for (const [account, e] of byAccount) {
      out.push({
        hash: tx.hash,
        isOutgoing: false,
        amount: e.amount,
        fee: 0n,
        height,
        timestamp,
        confirmations: tx.numConfirmations ?? 0,
        isConfirmed: !!tx.isConfirmed,
        isFailed: !!tx.isFailed,
        isLocked: !!tx.isLocked,
        accountIndex: account,
        subaddressIndices: e.subs,
        destinations: [],
        paymentId: tx.paymentId && !/^0+$/.test(tx.paymentId) ? tx.paymentId : undefined,
      });
    }
  };
  const blocks = blocksOrTxs?.blocks ?? blocksOrTxs ?? [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    for (const tx of block.txs ?? []) push(tx, block.height, block.timestamp);
  }
  return out;
}

export class MoneroApi {
  readonly worker: WalletWorker;
  readonly id: string;
  closed = false;
  #listener: string | null = null;
  #unsubs: (() => void)[] = [];

  constructor(worker: WalletWorker, id: string) {
    this.worker = worker;
    this.id = id;
  }

  static async create(worker: WalletWorker, config: Record<string, unknown>): Promise<MoneroApi> {
    const id = crypto.randomUUID();
    await worker.invoke(id, 'createWalletFull', [{ path: '', networkType: 0, proxyToWorker: false, ...config }]);
    return new MoneroApi(worker, id);
  }

  static async open(worker: WalletWorker, password: string, keys: Uint8Array, cache: Uint8Array): Promise<MoneroApi> {
    const id = crypto.randomUUID();
    await worker.invoke(id, 'openWalletData', ['', password, 0, keys, cache, undefined, false]);
    return new MoneroApi(worker, id);
  }

  call<T = any>(fn: string, args: unknown[] = []): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Wallet is closed'));
    return this.worker.invoke<T>(this.id, fn, args);
  }

  getSeed = () => this.call<string>('getSeed');
  getHeight = () => this.call<number>('getHeight');
  getRestoreHeight = () => this.call<number>('getRestoreHeight');
  setRestoreHeight = (h: number) => this.call('setRestoreHeight', [Math.max(0, Math.floor(h))]);
  getPrimaryAddress = () => this.call<string>('getAddress', [0, 0]);
  getAddress = (a: number, s: number) => this.call<string>('getAddress', [a, s]);
  getPrivateViewKey = () => this.call<string>('getPrivateViewKey');
  getPrivateSpendKey = () => this.call<string>('getPrivateSpendKey');
  getPublicViewKey = () => this.call<string>('getPublicViewKey');
  getPublicSpendKey = () => this.call<string>('getPublicSpendKey');

  async setDaemon(url: string | null, opts: { username?: string; password?: string; trusted?: boolean } = {}): Promise<void> {
    const conn = url ? { uri: url, username: opts.username, password: opts.password, rejectUnauthorized: true, proxyToWorker: false } : undefined;
    await this.call('setDaemonConnection', [conn, !!opts.trusted]);
  }

  async listen(h: { onProgress?: (height: number, start: number, end: number, percent: number) => void; onBalances?: () => void; onNewBlock?: (h: number) => void }): Promise<void> {
    if (this.#listener) return;
    const lid = crypto.randomUUID();
    this.#listener = lid;
    this.#unsubs.push(
      this.worker.on(this.id, `onSyncProgress_${lid}`, (height, start, end, percent) => h.onProgress?.(height, start, end, percent)),
      this.worker.on(this.id, `onBalancesChanged_${lid}`, () => h.onBalances?.()),
      this.worker.on(this.id, `onNewBlock_${lid}`, (x) => h.onNewBlock?.(x)),
      this.worker.on(this.id, `onOutputReceived_${lid}`, () => {}),
      this.worker.on(this.id, `onOutputSpent_${lid}`, () => {}),
    );
    await this.call('addListener', [lid]);
  }

  async sync(): Promise<{ blocksFetched: number; receivedMoney: boolean }> {
    const r = await this.call<any>('sync', [undefined, false]);
    return { blocksFetched: r?.numBlocksFetched ?? 0, receivedMoney: !!r?.receivedMoney };
  }

  stopSync = () => this.call('stopSyncing');

  async balance(account?: number): Promise<{ balance: bigint; unlocked: bigint }> {
    const [b, u] = await Promise.all([this.call<string>('getBalance', account === undefined ? [] : [account]), this.call<string>('getUnlockedBalance', account === undefined ? [] : [account])]);
    return { balance: BigInt(b), unlocked: BigInt(u) };
  }

  async accounts(): Promise<{ index: number; label: string; balance: bigint; unlocked: bigint; address: string }[]> {
    const list = await this.call<any[]>('getAccounts', [true]);
    return list.map((a) => ({ index: a.index, label: a.tag ?? '', balance: BigInt(a.balance ?? 0), unlocked: BigInt(a.unlockedBalance ?? 0), address: a.primaryAddress, subaddresses: a.subaddresses }));
  }

  async createAccount(label = ''): Promise<{ index: number; address: string }> {
    const a = await this.call<any>('createAccount', [label]);
    return { index: a.index, address: a.primaryAddress };
  }

  async subaddresses(account: number): Promise<{ index: number; address: string; label: string; used: boolean; balance: bigint; numTxs: number }[]> {
    const list = await this.call<any[]>('getSubaddresses', [account]);
    return list.map((s) => ({ index: s.index, address: s.address, label: s.label ?? '', used: !!s.isUsed, balance: BigInt(s.balance ?? 0), numTxs: Number(s.numUnspentOutputs ?? 0) }));
  }

  async createSubaddress(account: number, label = ''): Promise<{ index: number; address: string }> {
    const s = await this.call<any>('createSubaddress', [account, label]);
    return { index: s.index, address: s.address };
  }

  setSubaddressLabel = (account: number, index: number, label: string) => this.call('setSubaddressLabel', [account, index, label]);

  async txs(): Promise<XmrTx[]> {
    const confirmed = parseTxs(await this.call('getTxs', [{ txs: [{ isConfirmed: true }] }]));
    let pool: XmrTx[] = [];
    try {
      const blocks = await this.call<any[]>('getTransfers', [{ txs: [{ isConfirmed: false }] }]);
      pool = parseTxs({ blocks });
    } catch { /* offline */ }
    return [...confirmed, ...pool];
  }

  async outputs(account: number): Promise<{ keyImage: string; amount: bigint; txHash: string; subaddressIndex: number; isFrozen: boolean; isSpent: boolean; isLocked: boolean }[]> {
    const blocks = await this.call<any[]>('getOutputs', [{ accountIndex: account, isSpent: false, txQuery: { isConfirmed: true } }]);
    const out: any[] = [];
    for (const b of blocks ?? []) for (const tx of b.txs ?? []) for (const o of tx.outputs ?? []) out.push({ keyImage: o.keyImage?.hex ?? '', amount: BigInt(o.amount ?? 0), txHash: tx.hash, subaddressIndex: o.subaddressIndex ?? 0, isFrozen: !!o.isFrozen, isSpent: !!o.isSpent, isLocked: !!tx.isLocked });
    return out;
  }

  freezeOutput = (keyImage: string) => this.call('freezeOutput', [keyImage]);
  thawOutput = (keyImage: string) => this.call('thawOutput', [keyImage]);

  /** Build and sign without relaying; returns tx sets. */
  async createTxs(cfg: { accountIndex: number; destinations: { address: string; amount: string }[]; priority: number; subaddressIndices?: number[]; keyImages?: string[] }): Promise<{ hash: string; fee: bigint; amount: bigint; metadata: string; key?: string }[]> {
    const set = await this.call<any>('createTxs', [{ accountIndex: cfg.accountIndex, destinations: cfg.destinations, relay: false, priority: cfg.priority, subaddressIndices: cfg.subaddressIndices }]);
    return (set?.txs ?? []).map((t: any) => ({ hash: t.hash, fee: BigInt(t.fee ?? 0), amount: BigInt(t.outgoingTransfer?.amount ?? t.outgoingAmount ?? 0), metadata: t.metadata, key: t.key }));
  }

  async sweep(cfg: { accountIndex: number; address: string; priority: number; subaddressIndices?: number[] }): Promise<{ hash: string; fee: bigint; amount: bigint; metadata: string; key?: string }[]> {
    const sets = await this.call<any[]>('sweepUnlocked', [{ accountIndex: cfg.accountIndex, address: cfg.address, relay: false, priority: cfg.priority, subaddressIndices: cfg.subaddressIndices }]);
    return (sets ?? []).flatMap((s: any) => (s.txs ?? []).map((t: any) => ({ hash: t.hash, fee: BigInt(t.fee ?? 0), amount: BigInt(t.outgoingTransfer?.amount ?? t.outgoingAmount ?? 0), metadata: t.metadata, key: t.key })));
  }

  relay = (metadata: string[]) => this.call<string[]>('relayTxs', [metadata]);
  getTxKey = (hash: string) => this.call<string>('getTxKey', [hash]);
  rescan = () => this.call('rescanBlockchain');
  signMessage = (msg: string, account: number, sub: number) => this.call<string>('signMessage', [msg, 0, account, sub]);
  async verifyMessage(msg: string, address: string, signature: string): Promise<boolean> {
    const r = await this.call<any>('verifyMessage', [msg, address, signature]);
    return !!r?.isGood;
  }

  async getData(): Promise<{ keys: Uint8Array; cache: Uint8Array }> {
    const [keys, cache] = await this.call<Uint8Array[]>('getData');
    return { keys: new Uint8Array(keys), cache: new Uint8Array(cache) };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    for (const u of this.#unsubs) u();
    await this.worker.invoke(this.id, 'close', [false]).catch(() => {});
    this.closed = true;
  }
}

export function validateMoneroAddress(worker: WalletWorker, address: string): Promise<void> {
  return worker.invoke(undefined, 'moneroUtilsValidateAddress', [address.trim(), 0]);
}
