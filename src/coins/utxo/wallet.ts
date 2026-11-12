// Electrum-family wallet engine (Bitcoin, Litecoin, Bitcoin Cash, Dogecoin),
// a port of cw_bitcoin's ElectrumWallet onto HTTP indexers over Tor:
// Cake's address chains/gap limits, history, UTXOs, coin selection
// (random-priority draw + changeless branch-and-bound), dust handling,
// shuffled inputs/outputs, RBF, anti-fee-sniping locktime, bump fee.

import { signal } from '@preact/signals';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { base64 } from '@scure/base';
import { WalletBase, type Balance, type PendingTransaction, type TransactionCredentials, type TransactionInfo, type TransactionPriorityOption, type WalletAddressEntry, type WalletInfo, type WalletKeysRow, type WalletSecrets } from '../../core/wallet.ts';
import { currency, type Currency } from '../types.ts';
import { formatFixed } from '../../core/amount.ts';
import { engineContext, type EngineContext } from '../../core/engine.ts';
import { makeIndexer, type ChainTx, type Indexer } from './indexer.ts';
import { KeyTree, addressTypesFor, LEGACY_CHAIN_TYPES, chainKey, type ChainId, type DerivationType } from './hd.ts';
import { NETWORKS, isValidAddress, type AddressType, type UtxoCoin, type UtxoNetwork } from './networks.ts';
import { buildTransaction, estimateVsize, genericTxSize, inputVbytes, outputTypeOf, type SpendInput, type SpendOutput } from './txbuilder.ts';
import { getJson } from '../../net/http.ts';
import { bip39Seed } from '../seeds/bip39.ts';
import { electrumMnemonicToSeed } from '../seeds/electrum.ts';
import { t } from '../../core/i18n.ts';

export const DEFAULT_RECEIVE = 22;
export const DEFAULT_CHANGE = 17;
export const GAP = 20;

export interface AddrRecord {
  address: string;
  index: number;
  account: number;
  type: AddressType;
  change: boolean;
  legacy: boolean;
  used: boolean;
  txCount: number;
  balance: string;
  label: string;
  hidden: boolean;
}

export interface UtxoRecord {
  txid: string;
  vout: number;
  value: bigint;
  height: number;
  address: string;
}

interface UtxoState {
  v: 1;
  addresses: AddrRecord[];
  txs: Record<string, ChainTx>;
  frozen: string[];
  notes: Record<string, string>;
  addressPageType: AddressType;
  lockedReceive: Partial<Record<AddressType, string>>;
  previousReceive?: string;
  changeCursor: number;
  tip: number;
  scanned: boolean;
  accountLabels: Record<number, string>;
}

const COIN_OF: Record<string, UtxoCoin> = { bitcoin: 'btc', litecoin: 'ltc', bitcoinCash: 'bch', dogecoin: 'doge' };

export function outpoint(u: { txid: string; vout: number }): string {
  return `${u.txid}:${u.vout}`;
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

export class UtxoWallet extends WalletBase {
  readonly coin: UtxoCoin;
  readonly net: UtxoNetwork;
  readonly currency: Currency;
  readonly ctx: EngineContext;
  tree!: KeyTree;
  state!: UtxoState;
  indexer!: Indexer;
  feeRates: number[] = [];
  readonly unspents = signal<(UtxoRecord & { frozen: boolean; note: string; confirmations: number })[]>([]);
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #syncing = false;
  #lastFull = 0;
  #feeAt = 0;

  constructor(info: WalletInfo, secrets: WalletSecrets) {
    super(info, secrets);
    this.coin = COIN_OF[info.type];
    this.net = NETWORKS[this.coin];
    this.currency = currency({ btc: 'btc', ltc: 'ltc', bch: 'bch', doge: 'doge' }[this.coin]);
    this.ctx = engineContext(info);
  }

  get hasCoinControl(): boolean {
    return true;
  }
  get hasMultipleOutputs(): boolean {
    return true;
  }
  get hasRescan(): boolean {
    return false;
  }
  get derivationType(): DerivationType {
    return (this.info.derivationInfo?.derivationType as DerivationType) ?? 'bip39';
  }

  async init(): Promise<void> {
    const s = this.secrets;
    let seed: Uint8Array | undefined;
    if (s.mnemonic) seed = this.derivationType === 'electrum' ? await electrumMnemonicToSeed(s.mnemonic, s.passphrase ?? '') : await bip39Seed(s.mnemonic, s.passphrase ?? '');
    this.tree = new KeyTree({ coin: this.coin, seed, xpub: s.engineData?.xpub as string | undefined, derivationType: this.derivationType, derivationPath: this.info.derivationInfo?.derivationPath });
    const saved = await this.ctx.cacheGet<UtxoState>('utxo');
    this.state = saved ?? {
      v: 1,
      addresses: [],
      txs: {},
      frozen: [],
      notes: {},
      addressPageType: this.coin === 'bch' || this.coin === 'doge' ? 'p2pkh' : 'p2wpkh',
      lockedReceive: {},
      changeCursor: 0,
      tip: 0,
      scanned: !this.info.isRecovery,
      accountLabels: {},
    };
    this.#ensureInitialAddresses();
    this.#publish();
  }

  // ------------------------------------------------------------ chains --

  chains(): ChainId[] {
    const out: ChainId[] = [];
    const accounts = [0, ...Object.keys(this.state?.accountLabels ?? {}).map(Number).filter((a) => a > 0)];
    for (const account of accounts) {
      for (const type of addressTypesFor(this.coin, account, !!this.info.hardwareWalletType)) {
        for (const change of [false, true]) out.push({ type, account, change, legacy: false });
        // BIP39 BTC wallets also keep the saved-path chains for P2PKH/P2TR/P2SH (legacy derivation)
        if (this.coin === 'btc' && account === 0 && this.tree.standardChains && LEGACY_CHAIN_TYPES.includes(type)) {
          for (const change of [false, true]) out.push({ type, account, change, legacy: true });
        }
      }
    }
    return out;
  }

  #records(c: ChainId): AddrRecord[] {
    return this.state.addresses.filter((a) => a.type === c.type && a.account === c.account && a.change === c.change && a.legacy === c.legacy).sort((a, b) => a.index - b.index);
  }

  #addAddresses(c: ChainId, from: number, count: number): AddrRecord[] {
    const have = new Set(this.#records(c).map((r) => r.index));
    const added: AddrRecord[] = [];
    for (let i = from; i < from + count; i++) {
      if (have.has(i)) continue;
      const r: AddrRecord = { address: this.tree.address(c, i), index: i, account: c.account, type: c.type, change: c.change, legacy: c.legacy, used: false, txCount: 0, balance: '0', label: '', hidden: c.legacy };
      this.state.addresses.push(r);
      added.push(r);
    }
    return added;
  }

  #ensureInitialAddresses() {
    for (const c of this.chains()) {
      const n = this.#records(c).length;
      const want = c.change ? DEFAULT_CHANGE : DEFAULT_RECEIVE;
      if (n < want) this.#addAddresses(c, n, want - n);
    }
  }

  #mine(): Map<string, AddrRecord> {
    return new Map(this.state.addresses.map((a) => [a.address, a]));
  }

  // ------------------------------------------------------------- network --

  async connect(): Promise<void> {
    const node = this.ctx.node();
    this.indexer = makeIndexer({ kind: node.kind as any, url: node.url, chain: node.chain, scope: this.ctx.scope });
    this.syncStatus.value = { kind: 'connecting' };
    const tip = await this.indexer.tip();
    this.state.tip = tip.height;
    this.height.value = tip.height;
    this.syncStatus.value = { kind: 'connected' };
  }

  async startSync(): Promise<void> {
    if (this.#closed) return;
    await this.sync(true);
    clearInterval(this.#timer);
    this.#timer = setInterval(() => void this.sync(false), 30_000);
  }

  async sync(full: boolean): Promise<void> {
    if (this.#syncing || this.#closed) return;
    this.#syncing = true;
    try {
      if (full || !this.state.scanned) this.syncStatus.value = { kind: 'synchronizing' };
      const tip = await this.indexer.tip();
      const tipChanged = tip.height !== this.state.tip;
      this.state.tip = tip.height;
      this.height.value = tip.height;
      if (!this.state.scanned) {
        await this.#discover();
        this.state.scanned = true;
        this.#lastFull = Date.now();
      } else if (full || tipChanged || Date.now() - this.#lastFull > 5 * 60_000) {
        await this.#refresh(true);
        this.#lastFull = Date.now();
      } else {
        await this.#refresh(false);
      }
      await this.updateFeeRates().catch(() => {});
      this.#publish();
      await this.save();
      this.syncStatus.value = { kind: 'synced' };
    } catch (e) {
      this.syncStatus.value = { kind: 'failed', error: (e as Error).message };
    } finally {
      this.#syncing = false;
    }
  }

  /** Gap-limit discovery over every chain (first sync of a restored wallet). */
  async #discover(): Promise<void> {
    for (const c of this.chains()) {
      let start = 0;
      for (let guard = 0; guard < 100; guard++) {
        const recs = this.#records(c).filter((r) => r.index >= start);
        if (!recs.length) break;
        const sums = await pool(recs, 6, (r) => this.indexer.address(r.address).catch(() => null));
        recs.forEach((r, i) => {
          const s = sums[i];
          if (s && s.txCount > 0) {
            r.used = true;
            r.txCount = s.txCount;
          }
        });
        const all = this.#records(c);
        const highestUsed = Math.max(-1, ...all.filter((r) => r.used).map((r) => r.index));
        const gap = c.change ? DEFAULT_CHANGE : DEFAULT_RECEIVE;
        if (highestUsed >= all.length - gap) {
          start = all.length;
          this.#addAddresses(c, all.length, GAP);
        } else break;
      }
    }
    await this.#fetchHistories(this.state.addresses.filter((a) => a.used));
  }

  /** Refresh used addresses + the ones a payment may arrive at. */
  async #refresh(all: boolean): Promise<void> {
    const watch = new Set<string>();
    for (const a of this.state.addresses) if (a.used && (all || this.#hasPending(a.address))) watch.add(a.address);
    // current receive addresses (per type) and the next unused ones
    for (const c of this.chains()) {
      if (c.legacy) continue;
      const unused = this.#records(c).filter((r) => !r.used).slice(0, c.change ? 2 : 3);
      for (const r of unused) watch.add(r.address);
    }
    const recv = this.receiveAddress.value;
    if (recv) watch.add(recv);
    const list = this.state.addresses.filter((a) => watch.has(a.address));
    const sums = await pool(list, 6, (r) => this.indexer.address(r.address).catch(() => null));
    const changed: AddrRecord[] = [];
    list.forEach((r, i) => {
      const s = sums[i];
      if (!s) return;
      if (s.txCount !== r.txCount || s.unconfirmed !== 0n || this.#hasPending(r.address)) changed.push(r);
      if (s.txCount > 0) r.used = true;
      r.txCount = s.txCount;
    });
    if (changed.length) await this.#fetchHistories(changed);
    // keep the gap after newly used addresses
    for (const c of this.chains()) {
      const recs = this.#records(c);
      const highestUsed = Math.max(-1, ...recs.filter((r) => r.used).map((r) => r.index));
      const gap = c.change ? DEFAULT_CHANGE : DEFAULT_RECEIVE;
      if (highestUsed >= recs.length - gap) this.#addAddresses(c, recs.length, GAP);
    }
  }

  #hasPending(address: string): boolean {
    return Object.values(this.state.txs).some((t) => t.height === 0 && (t.outputs.some((o) => o.address === address) || t.inputs.some((i) => i.address === address)));
  }

  async #fetchHistories(recs: AddrRecord[]): Promise<void> {
    const results = await pool(recs, 4, (r) => this.indexer.addressTxs(r.address).catch(() => null));
    let failed = 0;
    for (const txs of results) {
      if (!txs) {
        failed++;
        continue;
      }
      for (const tx of txs) {
        const prev = this.state.txs[tx.txid];
        // keep known fee/vsize when the indexer omits it
        this.state.txs[tx.txid] = { ...prev, ...tx, fee: tx.fee ?? prev?.fee, vsize: tx.vsize ?? prev?.vsize };
      }
    }
    if (failed && failed === results.length) throw new Error(t('sync_offline'));
    // inputs without prevout data (Blockchair, some Blockbooks): resolve from our own txs
    for (const tx of Object.values(this.state.txs)) {
      for (const i of tx.inputs) {
        if (i.address === undefined || i.value === undefined) {
          const p = this.state.txs[i.txid]?.outputs[i.vout];
          if (p) {
            i.address = p.address;
            i.value = p.value;
          }
        }
      }
    }
    // drop txs that left the mempool (replaced / dropped) — ones no longer returned for any of their addresses
    const seen = new Set(results.flatMap((r) => (r ?? []).map((x) => x.txid)));
    for (const [id, tx] of Object.entries(this.state.txs)) {
      if (tx.height === 0 && !seen.has(id)) {
        const touches = recs.some((r) => tx.outputs.some((o) => o.address === r.address) || tx.inputs.some((i) => i.address === r.address));
        if (touches) delete this.state.txs[id];
      }
    }
  }

  async updateFeeRates(force = false): Promise<void> {
    if (!force && Date.now() - this.#feeAt < 60_000 && this.feeRates.length) return;
    if (this.coin === 'ltc') this.feeRates = [1, 2, 3];
    else if (this.coin === 'bch') this.feeRates = [1, 5, 10];
    else if (this.coin === 'btc' && this.ctx.settings().useMempoolFeeAPI) {
      try {
        const node = this.ctx.node();
        const base = node.url.includes('cakememcninjdqbaub3tp2iswuigxqtdoevnpgzkolmy4gvhrrsub3yd') || node.url.includes('mempool.cakewallet.com') ? node.url.replace(/\/api$/, '') : 'http://cakememcninjdqbaub3tp2iswuigxqtdoevnpgzkolmy4gvhrrsub3yd.onion';
        const r = await getJson<any>(`${base}/api/v1/fees/recommended`, { scope: this.ctx.scope, timeoutMs: 30_000, purpose: 'fee rates' });
        const slow = Math.trunc(r.economyFee ?? 0);
        let medium = Math.trunc(r.hourFee ?? 0);
        let fast = Math.trunc(r.fastestFee ?? 0);
        if (slow === medium) medium++;
        while (fast <= medium) fast++;
        this.feeRates = [slow, medium, fast];
        this.#feeAt = Date.now();
        return;
      } catch { /* fall back to the indexer's estimates */ }
    }
    if (this.coin === 'btc' || this.coin === 'doge') {
      const f = await this.indexer.fees();
      const pick = (target: number) => {
        const keys = Object.keys(f).map(Number).sort((a, b) => a - b);
        const k = keys.find((x) => x >= target) ?? keys[keys.length - 1];
        return Math.min(2000, Math.max(0, Math.round(f[k] ?? 0)));
      };
      const rates = [pick(10), pick(5), pick(1)];
      if (rates.every((x) => x > 0)) this.feeRates = rates;
      else if (this.coin === 'doge') this.feeRates = [1000, 1000, 2000];
    }
    this.#feeAt = Date.now();
  }

  // ----------------------------------------------------------- derived --

  computeUtxos(): UtxoRecord[] {
    const mine = this.#mine();
    const spent = new Set<string>();
    for (const tx of Object.values(this.state.txs)) for (const i of tx.inputs) spent.add(outpoint(i));
    const out: UtxoRecord[] = [];
    for (const tx of Object.values(this.state.txs)) {
      tx.outputs.forEach((o) => {
        if (o.address && mine.has(o.address) && !spent.has(outpoint({ txid: tx.txid, vout: o.n }))) out.push({ txid: tx.txid, vout: o.n, value: o.value, height: tx.height, address: o.address });
      });
    }
    return out;
  }

  #toInfo(tx: ChainTx, mine: Map<string, AddrRecord>): TransactionInfo {
    const inMine = tx.inputs.reduce((s, i) => s + (i.address && mine.has(i.address) ? i.value ?? 0n : 0n), 0n);
    const outMine = tx.outputs.reduce((s, o) => s + (o.address && mine.has(o.address) ? o.value : 0n), 0n);
    const outTotal = tx.outputs.reduce((s, o) => s + o.value, 0n);
    const inTotal = tx.inputs.reduce((s, i) => s + (i.value ?? 0n), 0n);
    const fee = tx.fee ?? (inTotal > outTotal ? inTotal - outTotal : undefined);
    const outgoing = inMine > 0n;
    let amount = outgoing ? inMine - outMine - (fee ?? 0n) : outMine;
    if (amount < 0n) amount = 0n;
    const confirmations = tx.height > 0 ? Math.max(0, this.state.tip - tx.height + 1) : 0;
    return {
      id: tx.txid,
      currency: this.currency.key,
      direction: outgoing ? 'outgoing' : 'incoming',
      amount,
      fee: outgoing ? fee : undefined,
      date: tx.time * 1000,
      height: tx.height || undefined,
      confirmations,
      isPending: tx.height === 0,
      isReplaceable: outgoing && tx.height === 0 && tx.inputs.some((i) => (i.sequence ?? 0xffffffff) < 0xfffffffe),
      inputAddresses: tx.inputs.map((i) => i.address).filter((x): x is string => !!x),
      outputAddresses: tx.outputs.map((o) => o.address).filter((x): x is string => !!x),
      to: outgoing ? tx.outputs.find((o) => o.address && !mine.has(o.address))?.address : tx.outputs.find((o) => o.address && mine.has(o.address))?.address,
      isSelfTransfer: outgoing && amount === 0n,
      extra: tx.vsize && fee !== undefined ? { feeRate: `${(Number(fee) / tx.vsize).toFixed(1)} sat/vB` } : undefined,
    };
  }

  #publish() {
    const mine = this.#mine();
    const utxos = this.computeUtxos();
    const frozen = new Set(this.state.frozen);
    let confirmed = 0n;
    let unconfirmed = 0n;
    let frz = 0n;
    for (const u of utxos) {
      if (frozen.has(outpoint(u))) frz += u.value;
      else if (u.height > 0) confirmed += u.value;
      else unconfirmed += u.value;
    }
    const bal: Balance = { available: confirmed + unconfirmed, full: confirmed + unconfirmed + frz, pending: unconfirmed, frozen: frz };
    this.balances.value = { [this.currency.key]: bal };
    // per-address balances
    const byAddr = new Map<string, bigint>();
    for (const u of utxos) byAddr.set(u.address, (byAddr.get(u.address) ?? 0n) + u.value);
    for (const a of this.state.addresses) a.balance = (byAddr.get(a.address) ?? 0n).toString();
    this.unspents.value = utxos.map((u) => ({ ...u, frozen: frozen.has(outpoint(u)), note: this.state.notes[outpoint(u)] ?? '', confirmations: u.height > 0 ? this.state.tip - u.height + 1 : 0 }));
    this.transactions.value = Object.values(this.state.txs).map((tx) => this.#toInfo(tx, mine)).sort((a, b) => (a.isPending === b.isPending ? b.date - a.date : a.isPending ? -1 : 1));
    this.addresses.value = this.state.addresses.map((a) => ({ address: a.address, label: a.label, index: a.index, account: a.account, type: a.type, isUsed: a.used, isChange: a.change, isHidden: a.hidden, balance: BigInt(a.balance), txCount: a.txCount }));
    this.receiveAddress.value = this.currentReceiveAddress();
  }

  get addressPageType(): AddressType {
    return this.state.addressPageType;
  }

  setAddressPageType(type: AddressType): void {
    this.state.addressPageType = type;
    this.receiveAddress.value = this.currentReceiveAddress();
    void this.save();
  }

  /** ElectrumWalletAddresses.address getter */
  currentReceiveAddress(): string {
    const type = this.state.addressPageType;
    const account = this.currentAccount.value;
    const all = this.state.addresses.filter((a) => a.type === type && a.account === account && !a.change && !a.hidden).sort((a, b) => Number(a.legacy) - Number(b.legacy) || a.index - b.index);
    const auto = this.ctx.settings().autoGenerateSubaddressStatus !== 'disabled';
    if (!auto) {
      const prev = this.state.previousReceive && all.find((a) => a.address === this.state.previousReceive);
      if (prev) return prev.address;
      return all[0]?.address ?? '';
    }
    const locked = this.state.lockedReceive[type];
    if (locked && all.some((a) => a.address === locked)) return locked;
    const prev = this.state.previousReceive && all.find((a) => a.address === this.state.previousReceive && !a.used && !a.legacy);
    if (prev) return prev.address;
    const unused = all.find((a) => !a.used && !a.legacy);
    if (unused) return unused.address;
    const c: ChainId = { type, account, change: false, legacy: false };
    const recs = this.#records(c);
    return this.#addAddresses(c, recs.length, 1)[0]?.address ?? '';
  }

  selectReceiveAddress(address: string): void {
    const r = this.state.addresses.find((a) => a.address === address);
    if (!r) return;
    delete this.state.lockedReceive[r.type];
    this.state.previousReceive = address;
    if (r.used) this.state.lockedReceive[r.type] = address;
    this.receiveAddress.value = address;
    void this.save();
  }

  async newAddress(label = '', type?: string): Promise<WalletAddressEntry | null> {
    const c: ChainId = { type: (type as AddressType) ?? this.state.addressPageType, account: this.currentAccount.value, change: false, legacy: false };
    const recs = this.#records(c);
    const taken = new Set(recs.map((r) => r.index));
    let i = 0;
    while (taken.has(i)) i++;
    const [r] = this.#addAddresses(c, i, 1);
    if (!r) return null;
    r.label = label;
    this.state.previousReceive = r.address;
    this.#publish();
    await this.save();
    return { address: r.address, label, index: r.index, type: r.type };
  }

  async setAddressLabel(address: string, label: string): Promise<void> {
    const r = this.state.addresses.find((a) => a.address === address);
    if (r) r.label = label;
    this.#publish();
    await this.save();
  }

  async setAddressHidden(address: string, hidden: boolean): Promise<void> {
    const r = this.state.addresses.find((a) => a.address === address);
    if (r) r.hidden = hidden;
    this.#publish();
    await this.save();
  }

  // --------------------------------------------------------- coin control --

  async setFrozen(op: string, frozen: boolean): Promise<void> {
    const s = new Set(this.state.frozen);
    if (frozen) s.add(op);
    else s.delete(op);
    this.state.frozen = [...s];
    this.#publish();
    await this.save();
  }

  async setUtxoNote(op: string, note: string): Promise<void> {
    this.state.notes[op] = note;
    this.#publish();
    await this.save();
  }

  // --------------------------------------------------------------- fees --

  priorities(): TransactionPriorityOption[] {
    const r = this.feeRates;
    const unit = { btc: 'sat', ltc: 'Litoshi', bch: 'Satoshi', doge: 'koinu' }[this.coin];
    const opts: TransactionPriorityOption[] = [
      { id: 'slow', label: this.coin === 'btc' ? 'Slow ~24hrs+' : t('slow') === 'slow' ? 'Slow' : t('slow'), rateLabel: r[0] ? `${r[0]} ${unit}/byte` : undefined },
      { id: 'medium', label: t('medium') === 'medium' ? 'Medium' : t('medium'), rateLabel: r[1] ? `${r[1]} ${unit}/byte` : undefined },
      { id: 'fast', label: t('fast') === 'fast' ? 'Fast' : t('fast'), rateLabel: r[2] ? `${r[2]} ${unit}/byte` : undefined },
    ];
    if (this.coin === 'btc') opts.push({ id: 'custom', label: 'Custom', isCustom: true });
    return opts;
  }

  defaultPriority(): string {
    return 'medium';
  }

  feeRateFor(priority: string, custom?: number): number {
    if (priority === 'custom') return Math.max(1, Math.round(custom ?? 1));
    const i = { slow: 0, medium: 1, fast: 2 }[priority] ?? 1;
    return this.feeRates[i] ?? (this.coin === 'doge' ? 1000 : 1);
  }

  /** max of the custom fee slider: round(fast * 10) */
  maxCustomFeeRate(): number {
    return Math.max(1, Math.round((this.feeRates[2] ?? 10) * 10));
  }

  #txSize(inputs: number, outputs: number): number {
    if (this.coin === 'doge') return 180 * inputs + 34 * outputs + 10;
    return genericTxSize(inputs, outputs);
  }

  /** calculateEstimatedFee(priority, amount): rate × size with as many inputs as needed */
  async estimateFee(priority: string, amount?: bigint, _asset?: string, customRate?: number): Promise<bigint> {
    await this.updateFeeRates().catch(() => {});
    const rate = this.feeRateFor(priority, customRate);
    const coins = this.#spendable().sort((a, b) => (a.value > b.value ? -1 : 1));
    let inputs = 0;
    if (amount !== undefined && amount > 0n) {
      let total = 0n;
      for (const c of coins) {
        inputs++;
        total += c.value;
        if (total >= amount) break;
      }
    } else inputs = coins.length;
    return BigInt(rate * this.#txSize(Math.max(1, inputs), amount === undefined ? 1 : 2));
  }

  // -------------------------------------------------------------- send --

  #spendable(selected?: string[]): (UtxoRecord & { rec: AddrRecord })[] {
    const mine = this.#mine();
    const frozen = new Set(this.state.frozen);
    const sel = selected?.length ? new Set(selected) : null;
    return this.computeUtxos()
      .filter((u) => !frozen.has(outpoint(u)) && (!sel || sel.has(outpoint(u))))
      .map((u) => ({ ...u, rec: mine.get(u.address)! }))
      .filter((u) => u.rec && u.rec.account === this.currentAccount.value || this.coin !== 'btc');
  }

  #dust(): bigint {
    return this.coin === 'doge' ? 100_000_000n : 546n;
  }

  #fee(rate: number, inputs: { type: AddressType }[], outputs: string[]): bigint {
    return BigInt(Math.ceil(rate * estimateVsize(this.net, inputs.map((i) => i.type), outputs)));
  }

  #changeAddress(): AddrRecord {
    const type: AddressType = this.coin === 'bch' || this.coin === 'doge' ? 'p2pkh' : 'p2wpkh';
    const c: ChainId = { type, account: this.coin === 'btc' ? this.currentAccount.value : 0, change: true, legacy: false };
    let unused = this.#records(c).filter((r) => !r.used);
    if (!unused.length) {
      const recs = this.#records(c);
      this.#addAddresses(c, recs.length, GAP);
      unused = this.#records(c).filter((r) => !r.used);
    }
    if (this.state.changeCursor >= unused.length) this.state.changeCursor = 0;
    const r = unused[this.state.changeCursor];
    this.state.changeCursor++;
    return r;
  }

  validateAddress(address: string): boolean {
    return isValidAddress(this.net, address);
  }

  /** ElectrumWallet.createTransaction (+ estimateSendAllTx / estimateTxForAmount / _createUTXOS) */
  async createTransaction(c: TransactionCredentials): Promise<PendingTransaction> {
    if (this.isWatchOnly) throw new Error('This is a watch-only wallet');
    await this.updateFeeRates().catch(() => {});
    const outputs = c.outputs;
    const multi = outputs.length > 1;
    const sendAll = !multi && outputs[0].sendAll;
    if (multi && outputs.some((o) => o.sendAll)) throw new Error(t('wrong_balance_exception') === 'wrong_balance_exception' ? 'Wrong balance' : t('wrong_balance_exception'));
    const rate = c.feeRate ?? this.feeRateFor(c.priority ?? 'medium');
    if (rate <= 0) throw new Error('Fee rate unavailable, try again');
    const dests = outputs.map((o) => ({ address: (o.extractedAddress || o.address).trim(), value: o.amount }));
    for (const d of dests) if (!this.validateAddress(d.address)) throw new Error(`${t('error_text_address')} ${d.address}`);
    if (!sendAll) for (const d of dests) if (d.value <= this.#dust()) throw new Error(t('error_dust') === 'error_dust' ? 'The amount is too small (dust)' : t('error_dust'));
    const coins = this.#spendable(c.selectedUtxos);
    if (!coins.length) throw new Error(t('no_inputs') === 'no_inputs' ? 'No spendable coins' : t('no_inputs'));
    // single random draw order (stable for this build)
    const prio = new Map(coins.map((u) => [outpoint(u), crypto.getRandomValues(new Uint32Array(1))[0]]));
    coins.sort((a, b) => prio.get(outpoint(a))! - prio.get(outpoint(b))! || outpoint(a).localeCompare(outpoint(b)));

    let inputs: typeof coins;
    let finalOutputs: SpendOutput[];
    let fee: bigint;
    if (sendAll) {
      inputs = coins;
      const total = inputs.reduce((s, u) => s + u.value, 0n);
      fee = this.#fee(rate, inputs.map((u) => ({ type: u.rec.type })), [dests[0].address]);
      const amount = total - fee;
      if (amount <= 0n) throw new Error(t('insufficient_funds') === 'insufficient_funds' ? 'Insufficient funds' : t('insufficient_funds'));
      if (amount <= this.#dust()) throw new Error('The amount is too small (dust)');
      finalOutputs = [{ address: dests[0].address, value: amount }];
    } else {
      const target = dests.reduce((s, d) => s + d.value, 0n);
      const totalAvail = coins.reduce((s, u) => s + u.value, 0n);
      // a single output above the max spendable is a send-all in disguise
      if (!multi) {
        const feeAll = this.#fee(rate, coins.map((u) => ({ type: u.rec.type })), [dests[0].address]);
        const maxSpendable = totalAvail - feeAll;
        if (target > maxSpendable) throw new Error(t('insufficient_funds') === 'insufficient_funds' ? 'Insufficient funds' : t('insufficient_funds'));
        if (target === maxSpendable) return this.createTransaction({ ...c, outputs: [{ ...outputs[0], sendAll: true }] });
      }
      // branch and bound for a changeless input set
      const outVb = dests.reduce((s, d) => s + (outputTypeOf(this.net, d.address) === 'p2pkh' ? 34 : outputTypeOf(this.net, d.address) === 'p2tr' || outputTypeOf(this.net, d.address) === 'p2wsh' ? 43 : outputTypeOf(this.net, d.address) === 'p2sh' ? 32 : 31), 0);
      const bnb = changeless(coins.map((u) => ({ value: u.value, cost: BigInt(inputVbytes(u.rec.type) * rate) })), target + BigInt((10 + outVb) * rate), this.#dust());
      let count = bnb ? bnb.length : 0;
      if (bnb) {
        const chosen = new Set(bnb);
        const ordered = [...bnb.map((i) => coins[i]), ...coins.filter((_, i) => !chosen.has(i))];
        coins.splice(0, coins.length, ...ordered);
      }
      for (;;) {
        // accumulate until the amount is reached (or `count` inputs)
        inputs = [];
        let sum = 0n;
        for (const u of coins) {
          inputs.push(u);
          sum += u.value;
          if (count ? inputs.length >= count : sum >= target) break;
        }
        const left = sum - target;
        const allUsed = inputs.length === coins.length;
        if (left <= 0n) {
          if (!allUsed) {
            count = inputs.length + 1;
            continue;
          }
          throw new Error(t('insufficient_funds') === 'insufficient_funds' ? 'Insufficient funds' : t('insufficient_funds'));
        }
        const change = this.#changeAddress();
        const feeWithChange = this.#fee(rate, inputs.map((u) => ({ type: u.rec.type })), [...dests.map((d) => d.address), change.address]);
        const changeValue = left - feeWithChange;
        if (changeValue <= this.#dust()) {
          // change would be dust: drop it, the remainder goes to the fee
          const feeNoChange = this.#fee(rate, inputs.map((u) => ({ type: u.rec.type })), dests.map((d) => d.address));
          if (left - feeNoChange >= 0n) {
            fee = left;
            finalOutputs = dests.map((d) => ({ ...d }));
            break;
          }
          if (!allUsed) {
            count = inputs.length + 1;
            continue;
          }
          throw new Error(t('insufficient_funds') === 'insufficient_funds' ? 'Insufficient funds' : t('insufficient_funds'));
        }
        fee = feeWithChange;
        finalOutputs = [...dests.map((d) => ({ ...d })), { address: change.address, value: changeValue, isChange: true }];
        break;
      }
    }
    const spendsUnconfirmed = inputs.some((u) => u.height === 0);
    const synced = this.syncStatus.value.kind === 'synced';
    const locktime = this.coin === 'btc' && synced && this.state.tip > 0 ? this.state.tip : 0;
    const spendInputs: SpendInput[] = await Promise.all(
      inputs.map(async (u) => {
        const c: ChainId = { type: u.rec.type, account: u.rec.account, change: u.rec.change, legacy: u.rec.legacy };
        const si: SpendInput = { txid: u.txid, vout: u.vout, value: u.value, address: u.address, type: u.rec.type, pubkey: this.tree.pubkey(c, u.rec.index), privkey: this.tree.privkey(c, u.rec.index), confirmations: u.height > 0 ? this.state.tip - u.height + 1 : 0 };
        if (u.rec.type === 'p2pkh' && this.coin === 'btc') si.prevTxHex = await this.indexer.txHex(u.txid).catch(() => undefined);
        return si;
      }),
    );
    const built = buildTransaction(this.net, spendInputs, finalOutputs!, { rbf: this.coin === 'btc' && !spendsUnconfirmed, locktime });
    const sentAmount = finalOutputs!.filter((o) => !o.isChange).reduce((s, o) => s + o.value, 0n);
    return this.#pending(built.hex, built.txid, sentAmount, built.fee, built.inputs, built.outputs, rate);
  }

  #pending(hex: string, txid: string, amount: bigint, fee: bigint, inputs: SpendInput[], outputs: SpendOutput[], rate: number): PendingTransaction {
    const d = this.net.decimals;
    return {
      id: txid,
      hex,
      amount,
      fee,
      amountFormatted: formatFixed(amount, d),
      feeFormatted: formatFixed(fee, d),
      extra: { feeRate: `${rate} sat/vB` },
      commit: async () => {
        const id = await this.indexer.broadcast(hex);
        if (id && id.length === 64 && id !== txid) console.warn('broadcast returned a different txid', id, txid);
        // record it right away (Electrum's addOne), so balance and history update immediately
        this.state.txs[txid] = {
          txid,
          height: 0,
          time: Math.floor(Date.now() / 1000),
          fee,
          inputs: inputs.map((i) => ({ txid: i.txid, vout: i.vout, address: i.address, value: i.value, sequence: this.coin === 'btc' ? 0xfffffffd : 0xffffffff })),
          outputs: outputs.map((o, n) => ({ n, address: o.address, value: o.value })),
        };
        for (const o of outputs) {
          const r = this.state.addresses.find((a) => a.address === o.address);
          if (r) r.used = true;
        }
        this.#publish();
        await this.save();
        setTimeout(() => void this.sync(false), 4000);
      },
    };
  }

  // ------------------------------------------------------- replace by fee --

  /** canReplaceByFee: our unconfirmed tx signalling RBF */
  canReplaceByFee(txid: string): boolean {
    const tx = this.state.txs[txid];
    if (!tx || tx.height !== 0) return false;
    const mine = this.#mine();
    return tx.inputs.every((i) => i.address && mine.has(i.address)) && tx.inputs.some((i) => (i.sequence ?? 0xffffffff) < 0xfffffffe);
  }

  /** replaceByFee(hash, newFee): same inputs, change output reduced (or a new input added) */
  async replaceByFee(txid: string, newFeeRate: number): Promise<PendingTransaction> {
    const tx = this.state.txs[txid];
    if (!tx) throw new Error('Transaction not found');
    const mine = this.#mine();
    const ins = tx.inputs.map((i) => ({ ...i, rec: mine.get(i.address!)! }));
    const changeIdx = tx.outputs.findIndex((o) => o.address && mine.get(o.address)?.change);
    const outs: SpendOutput[] = tx.outputs.map((o) => ({ address: o.address!, value: o.value, isChange: !!(o.address && mine.get(o.address)?.change) }));
    const size = estimateVsize(this.net, ins.map((i) => i.rec.type), outs.map((o) => o.address));
    const newFee = BigInt(Math.ceil(newFeeRate * size));
    const oldFee = tx.fee ?? 0n;
    if (newFee <= oldFee) throw new Error(t('new_fee_too_low') === 'new_fee_too_low' ? 'The new fee must be higher than the current fee' : t('new_fee_too_low'));
    const extra = newFee - oldFee;
    if (changeIdx < 0 || outs[changeIdx].value - extra <= this.#dust()) throw new Error(t('rbf_insufficient_change') === 'rbf_insufficient_change' ? 'The change output is too small to pay the higher fee' : t('rbf_insufficient_change'));
    outs[changeIdx] = { ...outs[changeIdx], value: outs[changeIdx].value - extra };
    const spendInputs: SpendInput[] = ins.map((i) => {
      const c: ChainId = { type: i.rec.type, account: i.rec.account, change: i.rec.change, legacy: i.rec.legacy };
      return { txid: i.txid, vout: i.vout, value: i.value!, address: i.address!, type: i.rec.type, pubkey: this.tree.pubkey(c, i.rec.index), privkey: this.tree.privkey(c, i.rec.index), confirmations: 0 };
    });
    const built = buildTransaction(this.net, spendInputs, outs, { rbf: true, locktime: tx.locktime ?? 0, keepOrder: true });
    const p = this.#pending(built.hex, built.txid, outs.filter((o) => !o.isChange).reduce((s, o) => s + o.value, 0n), built.fee, built.inputs, built.outputs, newFeeRate);
    const commit = p.commit;
    p.commit = async () => {
      await commit();
      delete this.state.txs[txid];
      this.#publish();
      await this.save();
    };
    return p;
  }

  // ----------------------------------------------------------- messages --

  /** BIP137-style message signature (Bitcoin Signed Message), base64 */
  async signMessage(message: string, address?: string): Promise<string> {
    const rec = this.state.addresses.find((a) => a.address === (address || this.receiveAddress.value)) ?? this.state.addresses[0];
    const c: ChainId = { type: rec.type, account: rec.account, change: rec.change, legacy: rec.legacy };
    const priv = this.tree.privkey(c, rec.index);
    const sig = secp256k1.sign(magicHash(message, this.coin), priv, { prehash: false, format: 'recovered' });
    // recovered format: [recovery, r(32), s(32)]
    const recId = sig[0];
    const header = 27 + recId + 4 + (rec.type === 'p2sh' ? 8 : rec.type === 'p2wpkh' ? 12 : 0);
    return base64.encode(Uint8Array.from([header, ...sig.slice(1)]));
  }

  async verifyMessage(message: string, signature: string, address?: string): Promise<boolean> {
    try {
      const raw = base64.decode(signature.trim());
      if (raw.length !== 65) return false;
      const header = raw[0];
      const recId = (header - 27) & 3;
      const sig = Uint8Array.from([recId, ...raw.slice(1)]);
      const pub = secp256k1.recoverPublicKey(sig, magicHash(message, this.coin), { prehash: false });
      const target = address ?? this.receiveAddress.value;
      const { pubkeyToAddress } = await import('./networks.ts');
      return (['p2wpkh', 'p2pkh', 'p2sh', 'p2tr'] as AddressType[]).some((t) => {
        try {
          return pubkeyToAddress(this.net, pub, t) === target;
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- misc --

  async keys(): Promise<WalletKeysRow[]> {
    const k = this.tree.keysInfo();
    const rows: WalletKeysRow[] = [];
    if (k.fingerprint) rows.push({ label: 'Master fingerprint', value: k.fingerprint });
    if (k.wif) rows.push({ label: 'WIF', value: k.wif });
    if (k.privateKey) rows.push({ label: t('private_key'), value: k.privateKey });
    rows.push({ label: t('public_key') === 'public_key' ? 'Public key' : t('public_key'), value: k.publicKey });
    rows.push({ label: 'xPub', value: k.xpub });
    return rows;
  }

  explorerUrl(txid: string): string {
    switch (this.coin) {
      case 'btc':
        return `https://mempool.cakewallet.com/tx/${txid}`;
      case 'ltc':
        return `https://blockchair.com/litecoin/transaction/${txid}`;
      case 'bch':
        return `https://blockchair.com/bitcoin-cash/transaction/${txid}`;
      case 'doge':
        return `https://blockchair.com/dogecoin/transaction/${txid}`;
    }
  }

  async save(): Promise<void> {
    if (this.state) await this.ctx.cachePut('utxo', this.state);
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    await this.save().catch(() => {});
  }
}

/** Bitcoin Signed Message hash (Litecoin/Dogecoin/BCH use their own prefix). */
export function magicHash(message: string, coin: UtxoCoin): Uint8Array {
  const prefix = { btc: 'Bitcoin Signed Message:\n', ltc: 'Litecoin Signed Message:\n', bch: 'Bitcoin Signed Message:\n', doge: 'Dogecoin Signed Message:\n' }[coin];
  const enc = new TextEncoder();
  const p = enc.encode(prefix);
  const m = enc.encode(message);
  const varint = (n: number) => (n < 0xfd ? [n] : [0xfd, n & 0xff, n >> 8]);
  return sha256(sha256(Uint8Array.from([...varint(p.length), ...p, ...varint(m.length), ...m])));
}

/** coin_selection.dart changelessMatch: branch-and-bound over effective values */
export function changeless(coins: { value: bigint; cost: bigint }[], target: bigint, window: bigint, maxTries = 100_000): number[] | null {
  const keep: number[] = [];
  const eff: bigint[] = [];
  coins.forEach((c, i) => {
    const e = c.value - c.cost;
    if (e > 0n) {
      keep.push(i);
      eff.push(e);
    }
  });
  const order = eff.map((_, i) => i).sort((a, b) => (eff[b] > eff[a] ? 1 : eff[b] < eff[a] ? -1 : 0));
  const sorted = order.map((i) => eff[i]);
  const suffix: bigint[] = new Array(sorted.length + 1).fill(0n);
  for (let i = sorted.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + sorted[i];
  const upper = target + window;
  let best: number[] | null = null;
  const picked: number[] = [];
  let tries = 0;
  const dfs = (i: number, sum: bigint) => {
    if (best || tries++ >= maxTries) return;
    if (sum > upper) return;
    if (sum >= target) {
      best = [...picked];
      return;
    }
    if (i >= sorted.length || sum + suffix[i] < target) return;
    picked.push(order[i]);
    dfs(i + 1, sum + sorted[i]);
    picked.pop();
    dfs(i + 1, sum);
  };
  dfs(0, 0n);
  return best ? (best as number[]).map((i) => keep[i]) : null;
}

export { chainKey };
