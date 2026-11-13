// Nano wallet engine (cw_nano/lib/nano_wallet.dart + nano_client.dart): the
// account at index 0 of a standard (Blake2b) or BIP39/HD (SLIP-10) seed;
// balance and receivable from the node, receivable blocks received
// automatically, sends as a chain of state blocks, representative changes,
// history from account_history. Blocks are hashed and signed here, and their
// proof of work is computed on this device (Web Workers) unless the user picked
// a work server: Cake's default work server needs an API key, the others are
// not reachable over Tor.
//
// Unlike Cake, the frontier block is checked (hash and signature) before every
// send and representative change as well, not only before receiving: the new
// block's balance is taken from it, so a node can't make a send move more than
// asked, or turn a representative change into a burn.

import { signal } from '@preact/signals';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { WalletBase, type Balance, type PendingTransaction, type TransactionCredentials, type TransactionInfo, type TransactionPriorityOption, type WalletInfo, type WalletKeysRow, type WalletSecrets } from '../../core/wallet.ts';
import { currency, type Currency } from '../types.ts';
import { formatFixed } from '../../core/amount.ts';
import { engineContext, type EngineContext } from '../../core/engine.ts';
import { postJson } from '../../net/http.ts';
import { NanoRpc } from './rpc.ts';
import { t } from '../../core/i18n.ts';
import { addressToPublicKey, DEFAULT_REPRESENTATIVE, isValidNanoAddress, nanoKeys, publicKeyToAddress, RECEIVE_THRESHOLD, SEND_THRESHOLD, signHash, signMessage, stateHash, verifyHash, verifyMessage, workDifficulty, ZERO_HASH, ZERO_LINK_ACCOUNT, type NanoDerivation, type StateBlock } from './nano.ts';
import { computeWork } from './pow.ts';

/** NanoWalletBase.POLL_INTERVAL_SECONDS */
const POLL_MS = 10_000;
/** NanoClient.N2_REPS_ENDPOINT: representatives and their scores */
const REPS_ENDPOINT = 'https://rpc.nano.to';
/** auto-receive waits this long for a built send to be committed (its blocks extend the current frontier) */
const SEND_HOLD_MS = 3 * 60_000;
const NANO = 'nano';
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export interface N2Node {
  account: string;
  alias?: string;
  /** voting weight, as rpc.nano.to reports it */
  weight: number;
  uptime?: string;
  score?: number;
}

interface AccountInfo {
  frontier: string;
  balance: string;
  representative: string;
  confirmationHeight: number;
}

interface NanoCache {
  v: 1;
  balances: Record<string, Balance>;
  txs: TransactionInfo[];
  rep?: string;
  repScore?: number;
}

/** getRawAsUsableString: at most 6 decimals, truncated */
export function nanoUsable(raw: bigint | string): string {
  return formatFixed(BigInt(raw || '0'), 30, { fractionDigits: 6 });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export class NanoWallet extends WalletBase {
  readonly currency: Currency = currency(NANO);
  readonly ctx: EngineContext;
  readonly derivation: NanoDerivation;
  /** the account's representative (NanoWallet.representative) */
  readonly representativeAddress = signal('');
  repScore = 100;
  address = '';
  hexSeed = '';
  #priv = '';
  #rpcUrl = '';
  #txs = new Map<string, TransactionInfo>();
  /** sends from here that the node has not listed yet */
  #local = new Set<string>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #ticking = false;
  #receiving = false;
  #historyBusy = false;
  #holdUntil = 0;
  #work = new Map<string, Promise<string>>();
  #abort = new AbortController();
  #rpc: NanoRpc;

  constructor(info: WalletInfo, secrets: WalletSecrets) {
    super(info, secrets);
    this.ctx = engineContext(info);
    this.#rpc = new NanoRpc(this.ctx.scope, (url) => this.#headers(url));
    // NanoWallet.init: an unknown derivation type is the standard one
    this.derivation = info.derivationInfo?.derivationType === 'bip39' ? 'bip39' : 'nano';
  }

  get hasFees(): boolean {
    return false;
  }
  get hasMultipleOutputs(): boolean {
    return true;
  }
  /** NanoWallet.isRepOk */
  get isRepOk(): boolean {
    return this.repScore >= 90;
  }

  async init(): Promise<void> {
    const m = this.secrets.mnemonic?.trim();
    // a hex seed may be stored as the "mnemonic" (no spaces), like Cake does
    const k = await nanoKeys(m && m.includes(' ') ? { mnemonic: m } : { hexSeed: this.secrets.hexSeed ?? m }, this.derivation, 0);
    this.hexSeed = k.hexSeed;
    this.#priv = k.privateKey;
    this.address = k.address;
    this.receiveAddress.value = this.address;
    this.addresses.value = [{ address: this.address, label: '', index: 0 }];
    const c = await this.ctx.cacheGet<NanoCache>(NANO);
    if (c) {
      this.balances.value = c.balances ?? {};
      for (const tx of c.txs ?? []) this.#txs.set(tx.id, tx);
      this.representativeAddress.value = c.rep ?? '';
      this.repScore = c.repScore ?? 100;
      this.#publishTxs();
    }
  }

  // ------------------------------------------------------------- rpc --

  /** NanoClient.getHeaders: Cake's app header, and the user's key for rpc.nano.to / NOWNodes */
  #headers(url: string): Record<string, string> {
    const h: Record<string, string> = { 'nano-app': 'cake-wallet' };
    const keys = ((this.ctx.settings() as any).apiKeys ?? {}) as Record<string, string>;
    const host = hostOf(url);
    if (host === 'rpc.nano.to' && keys.nanoto?.trim()) h.key = keys.nanoto.trim();
    if (host === 'nano.nownodes.io' && keys.nownodes?.trim()) h['api-key'] = keys.nownodes.trim();
    return h;
  }

  #call<T = any>(body: Record<string, unknown>, purpose: string, url = this.#rpcUrl, timeoutMs = 45_000): Promise<T> {
    return this.#rpc.call<T>(url, body, purpose, timeoutMs);
  }

  /** account_info; null for an account that has no block yet */
  async #accountInfo(): Promise<AccountInfo | null> {
    const r = await this.#call<any>({ action: 'account_info', representative: 'true', account: this.address }, 'account info');
    if (typeof r?.frontier !== 'string') {
      if (r?.error && !/not found/i.test(String(r.error))) throw new Error(String(r.error));
      return null;
    }
    return { frontier: r.frontier, balance: String(r.balance ?? '0'), representative: String(r.representative ?? ''), confirmationHeight: Number(r.confirmation_height ?? 0) };
  }

  /** the frontier block, checked to be ours: its hash and our signature */
  async #verifiedFrontier(frontier: string): Promise<{ balance: bigint; representative: string }> {
    const r = await this.#call<any>({ action: 'block_info', json_block: 'true', hash: frontier }, 'frontier block');
    const c = r?.contents;
    if (!c || c.type !== 'state') throw new Error('error while getting frontier block info');
    const hash = stateHash({ account: c.account, previous: c.previous, representative: c.representative, balance: c.balance, link: c.link });
    if (hash !== frontier.toUpperCase() || !verifyHash(hash, c.signature, this.address)) throw new Error('Frontier block signature is invalid! Potentially malicious block detected!');
    return { balance: BigInt(c.balance), representative: String(c.representative) };
  }

  #signed(p: { previous: string; representative: string; balance: bigint; link: string; linkAsAccount: string }): StateBlock {
    const b: StateBlock = { type: 'state', account: this.address, previous: p.previous, representative: p.representative, balance: p.balance.toString(), link: p.link };
    b.link_as_account = p.linkAsAccount;
    b.signature = signHash(stateHash(b), this.#priv);
    return b;
  }

  /** process; "Old block" means it is already in the ledger (a retry of a request that went through) */
  async #process(block: StateBlock, subtype: 'send' | 'receive' | 'change'): Promise<string> {
    const r = await this.#call<any>({ action: 'process', json_block: 'true', subtype, block }, `process ${subtype}`, this.#rpcUrl, 90_000);
    if (r?.error) {
      if (/^old block/i.test(String(r.error))) return stateHash(block);
      throw new Error(`Received error ${r.error}`);
    }
    return String(r?.hash ?? '');
  }

  // ------------------------------------------------------- proof of work --

  /** work for a root, shared by every caller; a send-strength work also serves a receive */
  #workFor(root: string, threshold: bigint): Promise<string> {
    const r = root.toUpperCase();
    const key = `${r}:${threshold.toString(16)}`;
    const strong = this.#work.get(`${r}:${SEND_THRESHOLD.toString(16)}`);
    let p = this.#work.get(key) ?? (threshold <= SEND_THRESHOLD ? strong : undefined);
    if (!p) {
      p = this.#generateWork(r, threshold);
      this.#work.set(key, p);
      p.catch(() => this.#work.delete(key));
      while (this.#work.size > 8) this.#work.delete(this.#work.keys().next().value!);
    }
    return p;
  }

  /** NanoClient.requestWork: the work server the user picked, else (or when it fails) this device */
  async #generateWork(root: string, threshold: bigint): Promise<string> {
    const node = this.ctx.node(true);
    if (node.url !== 'local') {
      try {
        const url = node.url.replace(/\/+$/, '');
        const r = await postJson<any>(url, { action: 'work_generate', hash: root }, { scope: this.ctx.scope, timeoutMs: 120_000, retries: 1, purpose: 'proof of work', headers: this.#headers(url) });
        if (typeof r?.work === 'string' && /^[0-9a-fA-F]{16}$/.test(r.work) && workDifficulty(root, r.work) >= threshold) return r.work.toLowerCase();
      } catch { /* this device */ }
    }
    return computeWork(root, threshold, this.#abort.signal);
  }

  /** work for any root and threshold (diagnostics) */
  generateWork(rootHex: string, threshold: bigint): Promise<string> {
    return this.#workFor(rootHex, threshold);
  }

  /** the Send page opened: the next send block's work is computed while the form is filled in */
  prepareSend(): void {
    if (this.#closed || (this.balances.value[NANO]?.available ?? 0n) === 0n) return;
    void this.#accountInfo()
      .then((info) => (info ? this.#workFor(info.frontier, SEND_THRESHOLD) : undefined))
      .catch(() => {});
  }

  // ------------------------------------------------------------- network --

  /** NanoWallet.connectToNode: a node error does not stop the connection (the sync timer recovers) */
  async connect(): Promise<void> {
    this.#rpcUrl = this.ctx.node().url.replace(/\/+$/, '');
    this.syncStatus.value = { kind: 'connecting' };
    await this.#updateBalance().catch(() => {});
    this.syncStatus.value = { kind: 'connected' };
  }

  async startSync(): Promise<void> {
    if (this.#closed) return;
    this.syncStatus.value = { kind: 'attempting' };
    clearInterval(this.#timer);
    this.#timer = setInterval(() => void this.#tick(), POLL_MS);
    try {
      await this.#updateBalance().catch(() => {});
      await this.#updateTransactions();
      await this.save();
      this.syncStatus.value = { kind: 'synced' };
    } catch (e) {
      if (!this.#closed) this.syncStatus.value = { kind: 'failed', error: (e as Error).message };
    }
    void this.#updateRep().then(() => this.save()).catch(() => {});
    void this.#receiveAll();
  }

  /** every 10 s: the balance; receive what is receivable; unconfirmed history rows are refreshed */
  async #tick(): Promise<void> {
    if (this.#closed || this.#ticking) return;
    this.#ticking = true;
    try {
      await this.#updateBalance();
      if ((this.balances.value[NANO]?.pending ?? 0n) > 0n) await this.#receiveAll();
      else if (this.syncStatus.value.kind === 'failed' || [...this.#txs.values()].some((x) => x.isPending)) {
        await this.#updateTransactions();
        await this.save();
        if (this.syncStatus.value.kind === 'failed') this.syncStatus.value = { kind: 'synced' };
      }
    } catch { /* next tick */ } finally {
      this.#ticking = false;
    }
  }

  async #updateBalance(): Promise<void> {
    const r = await this.#call<any>({ action: 'account_balance', account: this.address }, 'balance');
    const recv = r?.receivable ?? r?.pending;
    if (r?.error || r?.balance === undefined || recv === undefined) throw new Error(`Error while trying to get balance! ${r?.error ?? ''}`.trim());
    const balance = BigInt(r.balance);
    this.balances.value = { [NANO]: { available: balance, full: balance, pending: BigInt(recv) } };
  }

  async #updateTransactions(): Promise<void> {
    if (this.#historyBusy) return;
    this.#historyBusy = true;
    try {
      const r = await this.#call<any>({ action: 'account_history', account: this.address, count: '100' }, 'history');
      if (r?.error && !/not found/i.test(String(r.error))) throw new Error(String(r.error));
      const list: any[] = Array.isArray(r?.history) ? r.history : [];
      for (const h of list) {
        if (typeof h?.hash !== 'string') continue;
        const isSend = h.type === 'send';
        const confirmed = String(h.confirmed) === 'true';
        const ts = Number(h.local_timestamp);
        this.#txs.set(h.hash, {
          id: h.hash,
          currency: NANO,
          direction: isSend ? 'outgoing' : 'incoming',
          amount: BigInt(h.amount ?? '0'),
          date: Number.isFinite(ts) ? ts * 1000 : Date.now(),
          height: Number(h.height) || undefined,
          confirmations: confirmed ? 1 : 0,
          isPending: !confirmed,
          to: isSend ? h.account : this.address,
          from: isSend ? this.address : h.account,
        });
        this.#local.delete(h.hash);
      }
      for (const id of this.#local) {
        const tx = this.#txs.get(id);
        if (!tx || Date.now() - tx.date > 10 * 60_000) {
          this.#txs.delete(id);
          this.#local.delete(id);
        }
      }
      this.#publishTxs();
    } finally {
      this.#historyBusy = false;
    }
  }

  #publishTxs(): void {
    this.transactions.value = [...this.#txs.values()].sort((a, b) => (a.isPending === b.isPending ? b.date - a.date : a.isPending ? -1 : 1));
  }

  // ------------------------------------------------------------- receive --

  /** NanoClient.confirmAllReceivable: one receive (or open) block per receivable block, 2 s apart */
  async #receiveAll(): Promise<number> {
    if (this.#receiving || this.#closed || Date.now() < this.#holdUntil) return 0;
    this.#receiving = true;
    let n = 0;
    try {
      const r = await this.#call<any>({ action: 'receivable', account: this.address, count: '-1', source: true }, 'receivable');
      const blocks: Record<string, any> = {};
      if (Array.isArray(r?.blocks)) {
        for (const b of r.blocks) if (b?.hash) blocks[b.hash] = b;
      } else if (r?.blocks && typeof r.blocks === 'object') Object.assign(blocks, r.blocks);
      for (const [hash, b] of Object.entries(blocks)) {
        if (this.#closed || Date.now() < this.#holdUntil) break;
        await this.#receiveBlock(hash, String(typeof b === 'object' ? b?.amount : b));
        n++;
        await sleep(2000);
      }
    } catch { /* next time */ } finally {
      this.#receiving = false;
    }
    if (n > 0 && !this.#closed) {
      await sleep(3000);
      await this.#updateBalance().catch(() => {});
      await this.#updateTransactions().catch(() => {});
      await this.save();
    }
    return n;
  }

  /** NanoClient.receiveBlock */
  async #receiveBlock(blockHash: string, amountRaw: string): Promise<void> {
    const amount = BigInt(/^\d+$/.test(amountRaw) ? amountRaw : '0');
    if (amount <= 0n) throw new Error('amountRaw must be greater than zero');
    const info = await this.#accountInfo();
    let previous = ZERO_HASH;
    let representative = this.#defaultRep();
    let balance = 0n;
    if (info) {
      balance = (await this.#verifiedFrontier(info.frontier)).balance;
      previous = info.frontier;
      representative = info.representative;
    }
    const block = this.#signed({ previous, representative, balance: balance + amount, link: blockHash.toUpperCase(), linkAsAccount: publicKeyToAddress(hexToBytes(blockHash)) });
    // an open block's work is on the account's public key
    block.work = await this.#workFor(info ? previous : bytesToHex(addressToPublicKey(this.address)), RECEIVE_THRESHOLD);
    await this.#process(block, 'receive');
  }

  // ---------------------------------------------------------------- send --

  priorities(): TransactionPriorityOption[] {
    return [];
  }

  defaultPriority(): string {
    return 'medium';
  }

  /** calculateEstimatedFee: always 0 */
  async estimateFee(): Promise<bigint> {
    return 0n;
  }

  validateAddress(address: string): boolean {
    return isValidNanoAddress(address);
  }

  /** NanoWallet.createTransaction: one send block per output, each extending the previous one */
  async createTransaction(c: TransactionCredentials): Promise<PendingTransaction> {
    while (this.#receiving) await sleep(200);
    this.#holdUntil = Date.now() + SEND_HOLD_MS;
    try {
      await this.#updateBalance().catch(() => {});
      const info = await this.#accountInfo();
      if (!info) throw new Error("error while getting account info! (we probably don't have an open account yet)");
      const frontier = await this.#verifiedFrontier(info.frontier);
      const base = frontier.balance;
      const tooMuch = () => new Error('Trying to send more than entire balance!');
      const blocks: { block: StateBlock; hash: string; to: string; amount: bigint }[] = [];
      let previous = info.frontier;
      let running = base;
      let total = 0n;
      for (const out of c.outputs) {
        const to = (out.extractedAddress || out.address).trim();
        if (!isValidNanoAddress(to)) throw new Error(t('error_text_address'));
        const amt = out.sendAll ? base : out.amount;
        if (amt > base || amt > running) throw tooMuch();
        running -= amt;
        const block = this.#signed({ previous, representative: frontier.representative, balance: running, link: bytesToHex(addressToPublicKey(to)).toUpperCase(), linkAsAccount: to });
        block.work = await this.#workFor(previous, SEND_THRESHOLD);
        const hash = stateHash(block);
        blocks.push({ block, hash, to, amount: amt });
        previous = hash;
        total += amt;
      }
      if (total > base || running < 0n) throw tooMuch();
      const last = blocks[blocks.length - 1]?.hash ?? '';
      return {
        id: last,
        amount: total,
        fee: 0n,
        amountFormatted: formatFixed(total, 30),
        feeFormatted: '0',
        commit: async () => {
          try {
            for (const b of blocks) {
              await this.#process(b.block, 'send');
              this.#local.add(b.hash);
              this.#txs.set(b.hash, { id: b.hash, currency: NANO, direction: 'outgoing', amount: b.amount, date: Date.now(), confirmations: 0, isPending: true, from: this.address, to: b.to });
              this.#publishTxs();
            }
          } finally {
            this.#holdUntil = 0;
          }
          await this.save();
          // SendViewModel: the history and balance are updated 4 s after a send
          setTimeout(() => {
            void Promise.all([this.#updateTransactions(), this.#updateBalance()])
              .then(() => this.save())
              .catch(() => {});
          }, 4_000);
        },
      };
    } catch (e) {
      this.#holdUntil = 0;
      throw e;
    }
  }

  // ------------------------------------------------------- representative --

  #defaultRep(): string {
    const s = String((this.ctx.settings() as any).defaultNanoRep ?? '').trim();
    return s && isValidNanoAddress(s) ? s : DEFAULT_REPRESENTATIVE;
  }

  /** NanoWallet._updateRep */
  async #updateRep(): Promise<void> {
    let info: AccountInfo | null = null;
    try {
      info = await this.#accountInfo();
    } catch { /* below */ }
    if (!info) {
      this.representativeAddress.value = this.#defaultRep();
      return;
    }
    this.representativeAddress.value = info.representative;
    this.repScore = await this.#repScore(info.representative);
  }

  /** the representative again (the Change Representative page, when it is not known yet) */
  async refreshRep(): Promise<void> {
    await this.#updateRep();
    await this.save();
  }

  /** NanoClient.getRepScore: rep_info score, 100 when unknown */
  async #repScore(rep: string): Promise<number> {
    try {
      const r = await this.#call<any>({ action: 'rep_info', account: rep }, 'representative info', REPS_ENDPOINT);
      return typeof r?.score === 'number' ? r.score : 100;
    } catch {
      return 100;
    }
  }

  /** NanoClient.getN2Reps */
  async getN2Reps(): Promise<N2Node[]> {
    try {
      const r = await this.#call<any>({ action: 'reps' }, 'representatives', REPS_ENDPOINT);
      if (!Array.isArray(r)) return [];
      return r
        .filter((x) => typeof x?.rep_address === 'string')
        .map((x) => ({ account: x.rep_address, alias: typeof x.alias === 'string' ? x.alias : undefined, weight: Number(x.weight) || 0, uptime: typeof x.uptime === 'string' ? x.uptime : undefined, score: typeof x.score === 'number' ? x.score : undefined }));
    } catch {
      return [];
    }
  }

  /** NanoWallet.changeRep / NanoClient.changeRep: a change block on the frontier */
  async changeRep(rep: string): Promise<void> {
    try {
      if (!isValidNanoAddress(rep)) throw new Error(t('error_text_address'));
      while (this.#receiving) await sleep(200);
      this.#holdUntil = Date.now() + SEND_HOLD_MS;
      const info = await this.#accountInfo();
      if (!info) throw new Error("error while getting account info, you can't change the rep of an unopened account");
      const frontier = await this.#verifiedFrontier(info.frontier);
      const block = this.#signed({ previous: info.frontier, representative: rep, balance: frontier.balance, link: ZERO_HASH, linkAsAccount: ZERO_LINK_ACCOUNT });
      block.work = await this.#workFor(info.frontier, SEND_THRESHOLD);
      const hash = await this.#process(block, 'change');
      if (hash) {
        this.representativeAddress.value = rep;
        this.repScore = await this.#repScore(rep);
        await this.save();
      }
    } catch (e) {
      throw new Error(`Failed to change representative address ${(e as Error).message}`);
    } finally {
      this.#holdUntil = 0;
    }
  }

  // -------------------------------------------------------------- others --

  async rescan(): Promise<void> {
    await Promise.all([this.#updateTransactions().catch(() => {}), this.#updateBalance().catch(() => {})]);
  }

  async signMessage(message: string): Promise<string> {
    return signMessage(message, this.#priv);
  }

  async verifyMessage(message: string, signature: string, address?: string): Promise<boolean> {
    if (!address) return false;
    return verifyMessage(message, signature, address.trim());
  }

  /** wallet_keys_view_model.dart: the hex seed and the private key */
  async keys(): Promise<WalletKeysRow[]> {
    return [
      { label: t('seed_hex_form'), value: this.hexSeed },
      { label: t('private_key'), value: this.#priv },
    ];
  }

  explorerUrl(txid: string): string {
    return `https://nanexplorer.com/nano/block/${txid}`;
  }

  async save(): Promise<void> {
    const c: NanoCache = { v: 1, balances: this.balances.value, txs: [...this.#txs.values()], rep: this.representativeAddress.value, repScore: this.repScore };
    await this.ctx.cachePut(NANO, c);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    this.#abort.abort();
    await this.save().catch(() => {});
    this.#priv = '';
  }
}
