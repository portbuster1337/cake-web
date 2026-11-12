// Monero wallet engine (cw_monero): Monero's wallet2 compiled to WebAssembly
// (monero-ts) in a worker whose every request goes through the Tor router.
// Accounts, subaddresses (auto-generated), multi-destination sends, Cake's
// fee priorities, coin control, tx keys, rescan, keys page, message signing.

import { signal } from '@preact/signals';
import { WalletBase, type PendingTransaction, type TransactionCredentials, type TransactionInfo, type TransactionPriorityOption, type WalletAddressEntry, type WalletInfo, type WalletKeysRow, type WalletSecrets } from '../../core/wallet.ts';
import { currency, type Currency } from '../types.ts';
import { formatFixed } from '../../core/amount.ts';
import { engineContext, type EngineContext } from '../../core/engine.ts';
import { router, postJson } from '../../net/http.ts';
import { WalletWorker } from './engine.ts';
import { MoneroApi, type XmrTx } from './api.ts';
import { t } from '../../core/i18n.ts';

/** MoneroTransactionPriority raw values -> wallet2 fee priority (Cake keeps raw == wallet2 priority) */
export const XMR_PRIORITIES: { id: string; label: string; raw: number; estimate: bigint }[] = [
  { id: 'slow', label: 'Slow', raw: 1, estimate: 24_590_000n },
  { id: 'automatic', label: 'Automatic', raw: 0, estimate: 123_050_000n },
  { id: 'medium', label: 'Medium', raw: 2, estimate: 245_029_999n },
  { id: 'fast', label: 'Fast', raw: 3, estimate: 614_530_000n },
  { id: 'fastest', label: 'Fastest', raw: 4, estimate: 26_021_600_000n },
];

const SAVE_EVERY_MS = 5 * 60_000;
const POLL_MS = 20_000;

export interface MoneroEngineData {
  keys: Uint8Array;
  cache: Uint8Array;
  password: string;
}

export class MoneroWallet extends WalletBase {
  readonly currency: Currency = currency('xmr');
  readonly ctx: EngineContext;
  worker!: WalletWorker;
  api!: MoneroApi;
  readonly subaddressLists = signal<Record<number, WalletAddressEntry[]>>({});
  readonly unspents = signal<{ txid: string; vout: number; value: bigint; height: number; address: string; frozen: boolean; note: string; confirmations: number; keyImage: string }[]>([]);
  #closed = false;
  #syncing = false;
  #timer: ReturnType<typeof setInterval> | undefined;
  #lastSave = 0;
  #daemonUrl = '';
  #chainHeight = 0;

  constructor(info: WalletInfo, secrets: WalletSecrets) {
    super(info, secrets);
    this.ctx = engineContext(info);
  }

  get hasRescan(): boolean {
    return true;
  }
  get hasCoinControl(): boolean {
    return true;
  }
  get hasAccountsSupport(): boolean {
    return true;
  }
  get hasMultipleOutputs(): boolean {
    return true;
  }
  get hasAddressList(): boolean {
    return true;
  }
  get rotatesAddresses(): boolean {
    return this.ctx.settings().autoGenerateSubaddressStatus !== 'disabled';
  }

  async init(api?: MoneroApi, worker?: WalletWorker): Promise<void> {
    if (api && worker) {
      this.api = api;
      this.worker = worker;
    } else {
      const d = this.secrets.engineData as unknown as MoneroEngineData;
      this.worker = new WalletWorker(router(), './monero.worker.host.js');
      this.api = await MoneroApi.open(this.worker, d.password, d.keys, d.cache);
    }
    this.currentAccount.value = Number((this.info as any).moneroAccount ?? 0);
    await this.refreshViews();
  }

  // ----------------------------------------------------------- network --

  async connect(): Promise<void> {
    const node = this.ctx.node();
    this.#daemonUrl = node.url.replace(/\/+$/, '');
    this.syncStatus.value = { kind: 'connecting' };
    await this.api.setDaemon(this.#daemonUrl, { username: node.login, password: node.password, trusted: !!node.trusted });
    this.#chainHeight = await this.#daemonHeight();
    const freshSeed = this.info.seedType === 'polyseed' || this.info.seedType === 'legacy';
    if (!this.info.isRecovery && freshSeed && (await this.api.getHeight()) <= 1) {
      // First scan of a wallet created here from a brand-new random seed: nothing
      // can have paid it before it existed, so start near its creation block
      // instead of Cake's date-based height (days earlier: thousands of blocks,
      // many minutes over Tor). The margin grows with the time since creation
      // (block times vary). The stored restore height (keys page, QR export)
      // stays Cake's. (BIP39 wallet-group children keep Cake's height: their
      // seed may be older than the wallet.)
      const blocksSince = Math.max(0, Math.ceil((Date.now() - this.info.date) / 120_000));
      const target = Math.min(this.#chainHeight - 10, Math.max(this.info.restoreHeight, this.#chainHeight - blocksSince - 60 - Math.ceil(blocksSince * 0.05)));
      if (target > (await this.api.getRestoreHeight())) await this.api.setRestoreHeight(target);
    }
    this.syncStatus.value = { kind: 'connected' };
    await this.api.listen({
      onProgress: (height, start, end, percent) => {
        const left = Math.max(0, end - height);
        this.height.value = height;
        if (left > 0) this.syncStatus.value = { kind: 'syncing', blocksLeft: left, progress: percent, startedAt: Date.now() };
      },
      onBalances: () => void this.refreshViews().catch(() => {}),
    });
  }

  async #daemonHeight(): Promise<number> {
    const node = this.ctx.node();
    const r = await postJson<any>(`${this.#daemonUrl}/json_rpc`, { jsonrpc: '2.0', id: '0', method: 'get_block_count' }, { scope: this.ctx.scope, username: node.login, password: node.password, timeoutMs: 60_000, purpose: 'height' });
    return Number(r?.result?.count ?? 0);
  }

  async startSync(): Promise<void> {
    if (this.#closed) return;
    void this.#sync();
    clearInterval(this.#timer);
    this.#timer = setInterval(() => void this.#poll(), POLL_MS);
  }

  async #poll(): Promise<void> {
    if (this.#syncing || this.#closed) return;
    try {
      const h = await this.#daemonHeight();
      if (h > this.#chainHeight || h > (await this.api.getHeight())) {
        this.#chainHeight = h;
        await this.#sync();
      }
    } catch { /* next poll */ }
  }

  async #sync(): Promise<void> {
    if (this.#syncing || this.#closed) return;
    this.#syncing = true;
    try {
      const h = await this.api.getHeight();
      if (h < this.#chainHeight - 1) this.syncStatus.value = { kind: 'syncing', blocksLeft: this.#chainHeight - h, progress: 0, startedAt: Date.now() };
      else this.syncStatus.value = { kind: 'synchronizing' };
      // save a long first scan every few minutes so closing the tab loses little work
      const checkpoint = setInterval(() => {
        if (Date.now() - this.#lastSave > SAVE_EVERY_MS) void this.api.stopSync().catch(() => {});
      }, 30_000);
      let received = false;
      try {
        for (let i = 0; i < 1000; i++) {
          const r = await this.api.sync();
          received ||= r.receivedMoney;
          const height = await this.api.getHeight();
          this.height.value = height;
          if (height >= this.#chainHeight - 1 || this.#closed) break;
          await this.save();
          await this.refreshViews();
        }
      } finally {
        clearInterval(checkpoint);
      }
      if (this.#closed) return;
      await this.#autoGenerate();
      await this.refreshViews();
      if (received || Date.now() - this.#lastSave > SAVE_EVERY_MS) await this.save();
      this.syncStatus.value = { kind: 'synced' };
    } catch (e) {
      if (!this.#closed) this.syncStatus.value = { kind: 'failed', error: (e as Error).message };
    } finally {
      this.#syncing = false;
    }
  }

  /** monero_subaddress_list.dart: if the newest subaddress was used, add one labelled with the account label */
  async #autoGenerate(): Promise<void> {
    if (!this.rotatesAddresses) return;
    const acc = this.currentAccount.value;
    for (let guard = 0; guard < 5; guard++) {
      const subs = await this.api.subaddresses(acc);
      const newest = subs[subs.length - 1];
      if (!newest || !newest.used) break;
      const label = subs[0]?.label || this.accounts.value.find((a) => a.index === acc)?.label || '';
      await this.api.createSubaddress(acc, label);
    }
  }

  async refreshViews(): Promise<void> {
    const acc = this.currentAccount.value;
    const [accounts, subs, bal] = await Promise.all([this.api.accounts(), this.api.subaddresses(acc), this.api.balance(acc)]);
    const labels = await Promise.all(accounts.map((a) => this.api.subaddresses(a.index).then((s) => s[0]?.label ?? '').catch(() => '')));
    this.accounts.value = accounts.map((a, i) => ({ index: a.index, label: labels[i] || (a.index === 0 ? t('primary_account') === 'primary_account' ? 'Primary account' : t('primary_account') : `Account #${a.index}`), balance: a.balance, address: a.address }));
    this.balances.value = { xmr: { available: bal.unlocked, full: bal.balance, pending: bal.balance - bal.unlocked } };
    const txs = await this.api.txs().catch(() => [] as XmrTx[]);
    const counts = new Map<number, number>();
    for (const tx of txs) if (tx.accountIndex === acc) for (const s of tx.subaddressIndices) counts.set(s, (counts.get(s) ?? 0) + 1);
    const entries: WalletAddressEntry[] = subs.map((s) => ({ address: s.address, label: s.label, index: s.index, account: acc, isUsed: s.used, balance: s.balance, txCount: counts.get(s.index) ?? 0 }));
    // Cake order: index 0 first, then newest first
    const ordered = entries.length > 2 ? [entries[0], ...entries.slice(1).reverse()] : entries;
    this.addresses.value = ordered;
    if (!this.receiveAddress.value || !entries.some((e) => e.address === this.receiveAddress.value)) {
      const auto = this.rotatesAddresses;
      const latest = [...entries].reverse().find((e) => !e.isUsed && !e.label) ?? entries[entries.length - 1];
      this.receiveAddress.value = auto ? latest?.address ?? entries[0]?.address ?? '' : entries[0]?.address ?? '';
    }
    const tip = this.#chainHeight || (await this.api.getHeight().catch(() => 0));
    this.transactions.value = txs
      .filter((tx) => tx.accountIndex === acc)
      .map((tx): TransactionInfo => ({
        id: tx.hash,
        currency: 'xmr',
        direction: tx.isOutgoing ? 'outgoing' : 'incoming',
        amount: tx.amount,
        fee: tx.isOutgoing ? tx.fee : undefined,
        date: tx.timestamp ? tx.timestamp * 1000 : Date.now(),
        height: tx.height,
        confirmations: tx.height ? Math.max(0, tip - tx.height) : 0,
        isPending: !tx.isConfirmed || (tx.height ? tip - tx.height < 10 : true),
        isFailed: tx.isFailed,
        accountIndex: tx.accountIndex,
        addressIndices: tx.subaddressIndices,
        outputAddresses: tx.destinations.map((d) => d.address),
        to: tx.isOutgoing ? tx.destinations[0]?.address : entries.find((e) => tx.subaddressIndices.includes(e.index))?.address,
        paymentId: tx.paymentId,
      }))
      .sort((a, b) => (a.isPending === b.isPending ? b.date - a.date : a.isPending ? -1 : 1));
    this.#refreshUnspents().catch(() => {});
  }

  async #refreshUnspents(): Promise<void> {
    const outs = await this.api.outputs(this.currentAccount.value);
    const subs = this.addresses.value;
    const notes = ((this.info as any).utxoNotes ?? {}) as Record<string, string>;
    this.unspents.value = outs.map((o, i) => ({ txid: o.txHash, vout: i, value: o.amount, height: 0, address: subs.find((s) => s.index === o.subaddressIndex)?.address ?? '', frozen: o.isFrozen, note: notes[o.keyImage] ?? '', confirmations: o.isLocked ? 0 : 10, keyImage: o.keyImage }));
  }

  async setFrozen(op: string, frozen: boolean): Promise<void> {
    const u = this.unspents.value.find((x) => `${x.txid}:${x.vout}` === op);
    if (!u?.keyImage) return;
    if (frozen) await this.api.freezeOutput(u.keyImage);
    else await this.api.thawOutput(u.keyImage);
    await this.#refreshUnspents();
    await this.save();
  }

  async setUtxoNote(op: string, note: string): Promise<void> {
    const u = this.unspents.value.find((x) => `${x.txid}:${x.vout}` === op);
    if (!u?.keyImage) return;
    (this.info as any).utxoNotes = { ...((this.info as any).utxoNotes ?? {}), [u.keyImage]: note };
    await this.ctx.saveInfo(this.info);
    await this.#refreshUnspents();
  }

  // --------------------------------------------------------- accounts --

  async setAccount(index: number): Promise<void> {
    this.currentAccount.value = index;
    (this.info as any).moneroAccount = index;
    this.receiveAddress.value = '';
    await this.ctx.saveInfo(this.info);
    await this.refreshViews();
  }

  async addAccount(label: string): Promise<void> {
    await this.api.createAccount(label);
    await this.refreshViews();
    await this.save();
  }

  async renameAccount(index: number, label: string): Promise<void> {
    await this.api.setSubaddressLabel(index, 0, label);
    await this.refreshViews();
    await this.save();
  }

  async newAddress(label = ''): Promise<WalletAddressEntry | null> {
    const acc = this.currentAccount.value;
    const s = await this.api.createSubaddress(acc, label);
    await this.refreshViews();
    this.receiveAddress.value = s.address;
    await this.save();
    return { address: s.address, label, index: s.index, account: acc };
  }

  async setAddressLabel(address: string, label: string): Promise<void> {
    const e = this.addresses.value.find((a) => a.address === address);
    if (!e) return;
    await this.api.setSubaddressLabel(this.currentAccount.value, e.index, label);
    await this.refreshViews();
    await this.save();
  }

  selectReceiveAddress(address: string): void {
    this.receiveAddress.value = address;
  }

  // ------------------------------------------------------------- fees --

  priorities(): TransactionPriorityOption[] {
    return XMR_PRIORITIES.map((p) => ({ id: p.id, label: p.label }));
  }

  defaultPriority(): string {
    return 'automatic';
  }

  async estimateFee(priority: string): Promise<bigint> {
    return XMR_PRIORITIES.find((p) => p.id === priority)?.estimate ?? XMR_PRIORITIES[1].estimate;
  }

  validateAddress(address: string): boolean {
    return /^[48][0-9a-zA-Z]{94}$|^[0-9a-zA-Z]{106}$/.test(address.trim());
  }

  async createTransaction(c: TransactionCredentials): Promise<PendingTransaction> {
    const prio = XMR_PRIORITIES.find((p) => p.id === (c.priority ?? 'automatic'))?.raw ?? 0;
    const acc = this.currentAccount.value;
    const outs = c.outputs.map((o) => ({ address: (o.extractedAddress || o.address).trim(), amount: o.amount }));
    for (const o of outs) await this.worker.invoke(undefined, 'moneroUtilsValidateAddress', [o.address, 0]).catch(() => {
      throw new Error(`${t('error_text_address')} ${o.address}`);
    });
    let txs: { hash: string; fee: bigint; amount: bigint; metadata: string; key?: string }[];
    if (c.outputs.length === 1 && c.outputs[0].sendAll) txs = await this.api.sweep({ accountIndex: acc, address: outs[0].address, priority: prio });
    else txs = await this.api.createTxs({ accountIndex: acc, destinations: outs.map((o) => ({ address: o.address, amount: o.amount.toString() })), priority: prio });
    if (!txs.length) throw new Error('No transaction created');
    const amount = txs.reduce((s, x) => s + x.amount, 0n);
    const fee = txs.reduce((s, x) => s + x.fee, 0n);
    return {
      id: txs[0].hash,
      amount,
      fee,
      count: txs.length,
      amountFormatted: formatFixed(amount, 12),
      feeFormatted: formatFixed(fee, 12),
      commit: async () => {
        await this.api.relay(txs.map((x) => x.metadata));
        await this.refreshViews();
        await this.save();
      },
    };
  }

  // ----------------------------------------------------------- others --

  async rescan(height?: number): Promise<void> {
    if (height !== undefined) await this.api.setRestoreHeight(height);
    this.info.restoreHeight = height ?? this.info.restoreHeight;
    await this.ctx.saveInfo(this.info);
    await this.api.rescan();
    await this.refreshViews();
    await this.save();
  }

  async signMessage(message: string, address?: string): Promise<string> {
    const e = this.addresses.value.find((a) => a.address === address) ?? this.addresses.value[0];
    return this.api.signMessage(message, this.currentAccount.value, e?.index ?? 0);
  }

  async verifyMessage(message: string, signature: string, address?: string): Promise<boolean> {
    return this.api.verifyMessage(message, address ?? this.receiveAddress.value, signature);
  }

  async keys(): Promise<WalletKeysRow[]> {
    const [addr, spub, spriv, vpub, vpriv] = await Promise.all([this.api.getPrimaryAddress(), this.api.getPublicSpendKey(), this.api.getPrivateSpendKey(), this.api.getPublicViewKey(), this.api.getPrivateViewKey()]);
    const rows: WalletKeysRow[] = [{ label: t('primary_address'), value: addr }, { label: t('spend_key_public'), value: spub }];
    if (spriv && !/^0+$/.test(spriv)) rows.push({ label: t('spend_key_private'), value: spriv });
    rows.push({ label: t('view_key_public'), value: vpub }, { label: t('view_key_private'), value: vpriv });
    return rows;
  }

  async txKey(hash: string): Promise<string | undefined> {
    return this.api.getTxKey(hash).catch(() => undefined);
  }

  /** the 25-word legacy seed (Legacy tab for polyseed/BIP39 wallets) */
  async legacySeed(): Promise<string> {
    return this.api.getSeed();
  }

  explorerUrl(txid: string): string {
    return `https://monero.com/tx/${txid}`;
  }

  async save(): Promise<void> {
    if (!this.api || this.api.closed) return;
    const { keys, cache } = await this.api.getData();
    const d = this.secrets.engineData as unknown as MoneroEngineData;
    this.secrets.engineData = { ...d, keys, cache } as any;
    await this.ctx.saveSecrets(this.secrets);
    this.#lastSave = Date.now();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    clearInterval(this.#timer);
    try {
      await this.api.stopSync().catch(() => {});
      await this.save().catch(() => {});
    } finally {
      this.#closed = true;
      await this.api.close().catch(() => {});
      this.worker.terminate();
    }
  }
}
