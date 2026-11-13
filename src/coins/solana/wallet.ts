// Solana wallet engine (cw_solana/lib/solana_wallet.dart + solana_client.dart):
// key at m/44'/501'/0'/0', SOL and SPL (Token and Token-2022) balances,
// Cake's rent checks and recipient token-account creation, v0 SOL transfers
// and legacy SPL transfers, history from the wallet's and its token accounts'
// signatures (with Cake's native / SPL / swap parsing), base58 message signing.

import { signal } from '@preact/signals';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { base58, base64 } from '@scure/base';
import { WalletBase, type Balance, type PendingTransaction, type TransactionCredentials, type TransactionInfo, type TransactionPriorityOption, type WalletInfo, type WalletKeysRow, type WalletSecrets } from '../../core/wallet.ts';
import { currency, type Currency } from '../types.ts';
import { formatFixed } from '../../core/amount.ts';
import { engineContext, type EngineContext } from '../../core/engine.ts';
import { getJson, jsonRpc, jsonRpcBatch, router, RpcError } from '../../net/http.ts';
import { bip39Seed } from '../seeds/bip39.ts';
import { slip10Ed25519 } from '../seeds/slip10.ts';
import { t } from '../../core/i18n.ts';
import { SPL_DEFAULT_TOKENS } from '../tokens.gen.ts';
import { isTokenPropertiesSuspicious, tokenIcon, type TokenAsset, type TokenWallet, type WalletToken } from '../tokens.ts';
import { ATA_PROGRAM, COMPUTE_BUDGET_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_ACCOUNT_SIZE, TOKEN_PROGRAM, WSOL_MINT, associatedTokenAddress, compileMessage, createAtaIdempotent, decodeAddress, isOnCurve, isValidSolAddress, metadataAddress, parseMetadataAccount, publicKeyOf, signMessage, signText, systemTransfer, transferChecked, verifyText } from './sol.ts';

export const SOL_PATH = "m/44'/501'/0'/0'";
const POLL_MS = 30_000;
/**
 * getTransaction calls run one at a time on this many Tor circuits. Public
 * RPC nodes limit each IP (a Tor exit is shared with many users), and some
 * refuse batched getTransaction calls; one call per circuit, with a new
 * circuit after an HTTP 429, sustains ~2-3 transactions/s.
 */
const LANES = 6;
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
/** SolanaWalletClient.minValidAmount (0.00000003 SOL) */
const MIN_LAMPORTS = 30n;
const SOLANA_FOREIGN_NATIVES = new Set(['BTC', 'ETH', 'BNB', 'AVAX', 'MATIC', 'POL', 'ICP', 'TRX', 'ATOM', 'DOT', 'ADA', 'XRP', 'XLM', 'XMR', 'ALGO', 'NEAR', 'TON', 'HBAR', 'APT', 'SUI', 'KAS']);

export async function solanaSeed(s: WalletSecrets): Promise<Uint8Array> {
  if (s.privateKey) return hexToBytes(s.privateKey);
  if (!s.mnemonic) throw new Error('No key for this wallet');
  return slip10Ed25519(await bip39Seed(s.mnemonic, s.passphrase ?? ''), SOL_PATH).key;
}

/** getPrivateKey(privateKey:): a base58 64-byte keypair (seed || public key), else a 32-byte hex seed */
export function parseSolanaPrivateKey(raw: string): Uint8Array {
  const v = raw.trim();
  try {
    const b = base58.decode(v);
    if (b.length === 64 && bytesToHex(ed25519.getPublicKey(b.subarray(0, 32))) === bytesToHex(b.subarray(32))) return b.slice(0, 32);
  } catch { /* not base58 */ }
  const h = v.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error('Invalid private key');
  return hexToBytes(h);
}

// --------------------------------------------------------------- parsing --

export interface RpcTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null };
}

export interface RpcTx {
  blockTime: number | null;
  meta: { fee: number; preBalances: number[]; postBalances: number[]; preTokenBalances?: RpcTokenBalance[] | null; postTokenBalances?: RpcTokenBalance[] | null; loadedAddresses?: { writable: string[]; readonly: string[] } | null } | null;
  transaction: { signatures: string[]; message: { accountKeys: string[]; instructions: { programIdIndex: number; accounts: number[]; data?: string }[] } } | null;
}

export interface SolRow {
  id: string;
  outgoing: boolean;
  from: string;
  to: string;
  amount: bigint;
  /** SPL mint (absent for SOL) */
  mint?: string;
  decimals: number;
  fee: bigint;
  blockTime: number;
}

type Meta = NonNullable<RpcTx['meta']>;
const raw = (b: RpcTokenBalance) => BigInt(b.uiTokenAmount?.amount || '0');

function isSwapTx(meta: Meta, keys: string[], wallet: string): boolean {
  const fee = BigInt(meta.fee ?? 0);
  let sentSol = false;
  let recvSol = false;
  const n = Math.min(keys.length, meta.preBalances.length, meta.postBalances.length);
  for (let i = 0; i < n; i++) {
    if (keys[i] !== wallet) continue;
    const c = BigInt(meta.postBalances[i]) - BigInt(meta.preBalances[i]);
    if (c > 0n) recvSol = true;
    else if (c < 0n && -c - fee > 0n) sentSol = true;
    break;
  }
  let sentTok = false;
  let recvTok = false;
  const pre = meta.preTokenBalances;
  const post = meta.postTokenBalances;
  if (pre && post) {
    for (const p of pre) {
      if (p.owner !== wallet) continue;
      const preAmt = p.uiTokenAmount.uiAmount ?? 0;
      let postAmt = preAmt;
      for (const q of post) {
        if (q.owner === wallet && q.mint === p.mint) {
          postAmt = q.uiTokenAmount.uiAmount ?? 0;
          break;
        }
      }
      if (postAmt - preAmt < 0) sentTok = true;
      else if (postAmt - preAmt > 0) recvTok = true;
    }
    for (const q of post) {
      if (q.owner !== wallet || (q.uiTokenAmount.uiAmount ?? 0) <= 0) continue;
      if (!pre.some((p) => p.owner === wallet && p.mint === q.mint)) recvTok = true;
    }
  }
  return (sentSol || sentTok) && (recvSol || recvTok);
}

function parseSwap(meta: Meta, keys: string[], ixs: { accounts: number[] }[], wallet: string, sig: string, blockTime: number): SolRow[] {
  const fee = BigInt(meta.fee ?? 0);
  const pre = meta.preBalances;
  const post = meta.postBalances;
  const preT = meta.preTokenBalances;
  const postT = meta.postTokenBalances;
  const feeAdj = keys[0] === wallet ? fee : 0n;
  let decreased: string | undefined;
  let increased: string | undefined;
  if (preT && postT) {
    for (const p of preT) {
      if (p.owner !== wallet) continue;
      const preAmt = p.uiTokenAmount.uiAmount ?? 0;
      let postAmt = preAmt;
      for (const q of postT) {
        if (q.owner === wallet && q.mint === p.mint) {
          postAmt = q.uiTokenAmount.uiAmount ?? 0;
          break;
        }
      }
      const d = postAmt - preAmt;
      if (d < 0 && decreased === undefined) decreased = p.mint;
      else if (d > 0 && increased === undefined) increased = p.mint;
    }
  }
  const splToSpl = !!decreased && !!increased && decreased !== increased;
  const first = ixs[0]?.accounts?.[0];
  const firstKey = first !== undefined && first < keys.length ? keys[first] : undefined;
  type Side = { amount: bigint; mint?: string; decimals: number; from: string; to: string };
  let out: Side | undefined;
  const n = Math.min(keys.length, pre.length);
  if (!splToSpl && pre.length && post.length) {
    for (let i = 0; i < n && i < post.length; i++) {
      if (keys[i] !== wallet) continue;
      const change = BigInt(pre[i]) - BigInt(post[i]) - feeAdj;
      if (change > 0n) {
        out = { amount: change, decimals: 9, from: wallet, to: firstKey ?? wallet };
        break;
      }
    }
  }
  if (!out && preT && postT) {
    outer: for (const p of preT) {
      if (p.owner !== wallet || (splToSpl && p.mint !== decreased)) continue;
      for (const q of postT) {
        if (q.owner === wallet && q.mint === p.mint) {
          const diff = raw(p) - raw(q);
          if (diff > 0n) {
            out = { amount: diff, mint: p.mint, decimals: p.uiTokenAmount.decimals, from: wallet, to: firstKey ?? wallet };
            break outer;
          }
        }
      }
    }
  }
  let inc: Side | undefined;
  if (pre.length && post.length) {
    for (let i = 0; i < n && i < post.length; i++) {
      if (keys[i] !== wallet) continue;
      const change = BigInt(post[i]) - BigInt(pre[i]) + feeAdj;
      if (change > 0n) {
        inc = { amount: change, decimals: 9, from: firstKey ?? wallet, to: wallet };
        break;
      }
    }
  }
  if (!inc && preT && postT) {
    const mints = new Set<string>();
    for (const b of [...preT, ...postT]) if (b.mint !== WSOL_MINT) mints.add(b.mint);
    for (const mint of mints) {
      try {
        const atas = [associatedTokenAddress(wallet, mint, TOKEN_PROGRAM), associatedTokenAddress(wallet, mint, TOKEN_2022_PROGRAM)];
        const idx = keys.findIndex((k) => atas.includes(k));
        if (idx < 0) continue;
        let preRaw = 0n;
        let postRaw = 0n;
        let dec: number | undefined;
        for (const p of preT) if (p.accountIndex === idx && p.mint === mint) { preRaw = raw(p); dec = p.uiTokenAmount.decimals; break; }
        for (const q of postT) if (q.accountIndex === idx && q.mint === mint) { postRaw = raw(q); dec = q.uiTokenAmount.decimals; break; }
        if (postRaw - preRaw > 0n && dec !== undefined) {
          inc = { amount: postRaw - preRaw, mint, decimals: dec, from: firstKey ?? wallet, to: wallet };
          break;
        }
      } catch { /* bad mint */ }
    }
  }
  const rows: SolRow[] = [];
  if (out) rows.push({ id: `${sig}_outgoing`, outgoing: true, ...out, fee, blockTime });
  if (inc) rows.push({ id: `${sig}_incoming`, outgoing: false, ...inc, fee: 0n, blockTime });
  return rows;
}

function parseNative(meta: Meta, keys: string[], wallet: string, sig: string, blockTime: number): SolRow | null {
  const fee = BigInt(meta.fee ?? 0);
  const n = Math.min(keys.length, meta.preBalances.length, meta.postBalances.length);
  const wi = keys.slice(0, n).indexOf(wallet);
  if (wi < 0) return null;
  const change = BigInt(meta.preBalances[wi]) - BigInt(meta.postBalances[wi]);
  const net = keys[0] === wallet ? change - fee : change;
  const outgoing = net > 0n;
  const amount = net < 0n ? -net : net;
  if (amount < MIN_LAMPORTS) return null;
  let receiver: string | undefined;
  let best = 0n;
  for (let i = 0; i < n; i++) {
    if (i === wi) continue;
    const c = BigInt(meta.postBalances[i]) - BigInt(meta.preBalances[i]);
    if (outgoing && c > best) {
      best = c;
      receiver = keys[i];
    } else if (!outgoing && c < 0n && -c > best) {
      best = -c;
      receiver = keys[i];
    }
  }
  if (!receiver) return null;
  return { id: sig, outgoing, from: outgoing ? wallet : receiver, to: outgoing ? receiver : wallet, amount, decimals: 9, fee, blockTime };
}

function parseSpl(meta: Meta, keys: string[], accounts: number[], wallet: string, sig: string, blockTime: number): SolRow | null {
  const pre = meta.preTokenBalances ?? [];
  const post = meta.postTokenBalances ?? [];
  const checked = accounts.length >= 4;
  const src = accounts[0];
  const dst = checked ? accounts[2] : accounts[1];
  let mint = checked ? keys[accounts[1]] : undefined;
  let preRaw = 0n;
  let postRaw = 0n;
  let decimals: number | undefined;
  for (const b of pre) {
    if ((b.accountIndex === src || b.accountIndex === dst) && b.owner === wallet) {
      if (mint && b.mint !== mint) continue;
      mint ??= b.mint;
      decimals = b.uiTokenAmount.decimals;
      preRaw = raw(b);
      break;
    }
  }
  for (const b of post) {
    if ((b.accountIndex === src || b.accountIndex === dst) && b.owner === wallet) {
      if (mint && b.mint !== mint) continue;
      mint ??= b.mint;
      decimals = b.uiTokenAmount.decimals;
      postRaw = raw(b);
      break;
    }
  }
  const diff = preRaw - postRaw;
  if (diff === 0n || decimals === undefined) return null;
  let sender: string | undefined;
  let receiver: string | undefined;
  for (const b of [...pre, ...post]) {
    if (mint && b.mint !== mint) continue;
    if (b.accountIndex === src) sender ??= b.owner;
    if (b.accountIndex === dst) receiver ??= b.owner;
    if (sender && receiver) break;
  }
  const fee = BigInt(meta.fee ?? 0);
  return { id: sig, outgoing: diff > 0n, from: sender ?? keys[src], to: receiver ?? keys[dst], amount: diff < 0n ? -diff : diff, mint, decimals, fee, blockTime };
}

/** SolanaWalletClient.parseTransaction */
export function parseSolanaTransaction(tx: RpcTx | null, wallet: string): SolRow[] | null {
  const meta = tx?.meta;
  const message = tx?.transaction?.message;
  if (!tx || !meta || !message) return null;
  try {
    const keys = [...message.accountKeys, ...(meta.loadedAddresses?.writable ?? []), ...(meta.loadedAddresses?.readonly ?? [])];
    const sig = tx.transaction!.signatures?.[0] ?? '';
    const blockTime = tx.blockTime ?? 0;
    const ixs = message.instructions ?? [];
    if (isSwapTx(meta, keys, wallet)) {
      const swap = parseSwap(meta, keys, ixs, wallet, sig, blockTime);
      if (swap.length) return swap;
    }
    for (const ix of ixs) {
      const pid = keys[ix.programIdIndex];
      if (pid === SYSTEM_PROGRAM || pid === COMPUTE_BUDGET_PROGRAM) {
        if (ix.accounts.length < 2) continue;
        const r = parseNative(meta, keys, wallet, sig, blockTime);
        if (r) return [r];
      } else if (pid === TOKEN_PROGRAM || pid === TOKEN_2022_PROGRAM) {
        if (ix.accounts.length < 2) continue;
        const r = parseSpl(meta, keys, ix.accounts, wallet, sig, blockTime);
        if (r) return [r];
      } else if (pid === ATA_PROGRAM) {
        if (ixs.length === 1) return null;
        if (!ixs.some((o) => keys[o.programIdIndex] === TOKEN_PROGRAM || keys[o.programIdIndex] === TOKEN_2022_PROGRAM)) return null;
      }
    }
  } catch { /* malformed */ }
  return null;
}

// ---------------------------------------------------------------- engine --

interface SolCache {
  v: 1;
  balances: Record<string, Balance>;
  txs: TransactionInfo[];
  /** newest synced signature per history source (solana_last_synced_signature_<wallet>_<source>) */
  sigs: Record<string, string>;
  /** symbols of mints seen in history that are not in the token list */
  mints: Record<string, { symbol: string; name: string }>;
  /** signatures already fetched (so a partly failed sync only retries the rest) */
  done?: string[];
}

interface TokenAccount {
  pubkey: string;
  program: string;
  amount: bigint;
}

export class SolanaWallet extends WalletBase implements TokenWallet {
  readonly currency: Currency = currency('sol');
  readonly ctx: EngineContext;
  readonly tokenList = signal<WalletToken[]>([]);
  readonly tokenStandard = 'SPL';
  address = '';
  #seed!: Uint8Array;
  #rpcUrl = '';
  #txs = new Map<string, TransactionInfo>();
  #sigs: Record<string, string> = {};
  #mints: Record<string, { symbol: string; name: string }> = {};
  #done = new Set<string>();
  #accounts = new Map<string, TokenAccount[]>();
  #fee: { at: number; value: bigint } | null = null;
  #rent: bigint | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  #closed = false;
  #syncing = false;
  #history: Promise<void> | null = null;

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
    this.#seed = await solanaSeed(this.secrets);
    this.address = publicKeyOf(this.#seed);
    this.receiveAddress.value = this.address;
    this.addresses.value = [{ address: this.address, label: '', index: 0 }];
    const saved = (await this.ctx.cacheGet<WalletToken[]>('sol:tokens')) ?? [];
    const byMint = new Map(saved.map((x) => [x.address, x]));
    const list: WalletToken[] = [];
    for (const d of SPL_DEFAULT_TOKENS) {
      const ex = byMint.get(d.address);
      list.push({ address: d.address, name: d.name, symbol: d.symbol, decimals: d.decimals, enabled: ex?.enabled ?? d.enabled, icon: tokenIcon(d.symbol, d.icon), groups: d.groups, mint: d.mint });
      byMint.delete(d.address);
    }
    for (const x of byMint.values()) list.push({ ...x, isPotentialScam: x.isPotentialScam || this.isSuspiciousToken(x) });
    this.tokenList.value = list;
    await this.ctx.cachePut('sol:tokens', list);
    const c = await this.ctx.cacheGet<SolCache>('sol');
    if (c) {
      this.balances.value = c.balances ?? {};
      for (const tx of c.txs ?? []) this.#txs.set(tx.id, tx);
      this.#sigs = c.sigs ?? {};
      this.#mints = c.mints ?? {};
      this.#done = new Set(c.done ?? []);
      this.#publishTxs();
    }
  }

  // ------------------------------------------------------------- rpc --

  #rpc<T = any>(method: string, params: unknown[] = [], purpose?: string): Promise<T> {
    return jsonRpc<T>(this.#rpcUrl, method, params, { scope: this.ctx.scope, timeoutMs: 45_000, retries: 2, purpose: purpose ?? method });
  }

  async #batch(calls: { method: string; params: unknown[] }[], purpose: string): Promise<(any | RpcError)[]> {
    const out: (any | RpcError)[] = [];
    for (let i = 0; i < calls.length; i += 10) {
      const chunk = calls.slice(i, i + 10);
      try {
        out.push(...(await jsonRpcBatch(this.#rpcUrl, chunk, { scope: this.ctx.scope, timeoutMs: 60_000, retries: 2, purpose })));
      } catch {
        out.push(...(await Promise.all(chunk.map((c) => this.#rpc(c.method, c.params, purpose).catch((e) => (e instanceof RpcError ? e : new RpcError((e as Error).message, -1)))))));
      }
    }
    return out;
  }

  async #accountInfos(addresses: string[]): Promise<({ owner: string; space: number; data: Uint8Array } | null)[]> {
    const res = await this.#batch(addresses.map((a) => ({ method: 'getAccountInfo', params: [a, { encoding: 'base64', commitment: 'confirmed' }] })), 'account info');
    return res.map((r) => {
      if (r instanceof RpcError) throw r;
      const v = r?.value;
      if (!v) return null;
      const data = Array.isArray(v.data) ? base64.decode(v.data[0]) : new Uint8Array(0);
      return { owner: v.owner as string, space: Number(v.space ?? data.length), data };
    });
  }

  async #rentExempt(space: number): Promise<bigint> {
    if (space === TOKEN_ACCOUNT_SIZE && this.#rent !== null) return this.#rent;
    const r = BigInt(await this.#rpc<number>('getMinimumBalanceForRentExemption', [space], 'rent'));
    if (space === TOKEN_ACCOUNT_SIZE) this.#rent = r;
    return r;
  }

  async #blockhash(): Promise<string> {
    const r = await this.#rpc<any>('getLatestBlockhash', [{ commitment: 'confirmed' }], 'blockhash');
    return r.value.blockhash as string;
  }

  async #feeFor(message: Uint8Array): Promise<bigint> {
    try {
      const r = await this.#rpc<any>('getFeeForMessage', [base64.encode(message), { commitment: 'confirmed' }], 'fee');
      return BigInt(r?.value ?? 0);
    } catch {
      return 0n;
    }
  }

  // --------------------------------------------------------- network --

  async connect(): Promise<void> {
    this.#rpcUrl = this.ctx.node().url.replace(/\/+$/, '');
    this.syncStatus.value = { kind: 'connecting' };
    this.height.value = Number(await this.#rpc<number>('getSlot', [], 'height'));
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
      await this.#estimate().catch(() => 0n);
      await this.save();
      if (first || this.syncStatus.value.kind !== 'synced') this.syncStatus.value = { kind: 'synced' };
    } catch (e) {
      if (!this.#closed) this.syncStatus.value = { kind: 'failed', error: (e as Error).message };
    } finally {
      this.#syncing = false;
    }
    // Cake waits for the history before it reports "synced". Over Tor the first history of a busy
    // address takes minutes (one getTransaction per transaction, rate-limited per exit), so it runs
    // on its own and fills the list from the newest transaction down; balances and sending don't wait.
    if (!this.#closed && !this.#history) {
      this.#history = this.#updateHistory()
        .catch(() => {})
        .then(() => this.save())
        .finally(() => (this.#history = null));
    }
  }

  /** SOL + every token account of both token programs in one request; enabled tokens sum all their accounts */
  async #updateBalances(): Promise<void> {
    const opts = { encoding: 'jsonParsed', commitment: 'confirmed' };
    const res = await this.#batch(
      [
        { method: 'getBalance', params: [this.address, { commitment: 'confirmed' }] },
        { method: 'getTokenAccountsByOwner', params: [this.address, { programId: TOKEN_PROGRAM }, opts] },
        { method: 'getTokenAccountsByOwner', params: [this.address, { programId: TOKEN_2022_PROGRAM }, opts] },
        { method: 'getSlot', params: [] },
      ],
      'balances',
    );
    if (res[0] instanceof RpcError) throw res[0];
    const accounts = new Map<string, TokenAccount[]>();
    for (const r of [res[1], res[2]]) {
      if (r instanceof RpcError) continue;
      for (const a of r?.value ?? []) {
        const info = a?.account?.data?.parsed?.info;
        if (!info?.mint) continue;
        const list = accounts.get(info.mint) ?? [];
        list.push({ pubkey: a.pubkey, program: a.account.owner, amount: BigInt(info.tokenAmount?.amount ?? '0') });
        accounts.set(info.mint, list);
      }
    }
    const tokensOk = !(res[1] instanceof RpcError) && !(res[2] instanceof RpcError);
    if (tokensOk) this.#accounts = accounts;
    if (!(res[3] instanceof RpcError)) this.height.value = Number(res[3]);
    const prev = this.balances.value;
    const sol = BigInt(res[0]?.value ?? 0);
    const next: Record<string, Balance> = { sol: { available: sol, full: sol } };
    for (const x of this.tokens.filter((tk) => tk.enabled)) {
      if (!tokensOk) {
        if (prev[x.address]) next[x.address] = prev[x.address];
        continue;
      }
      const v = (accounts.get(x.address) ?? []).reduce((s, a) => s + a.amount, 0n);
      next[x.address] = { available: v, full: v };
    }
    this.balances.value = next;
  }

  // ---------------------------------------------------------- history --

  /** _getAllSignaturesSinceLastFetch: the newest 1000, or every one since the last synced signature */
  async #signatures(address: string, until?: string): Promise<{ sig: string; failed: boolean }[]> {
    const out: { sig: string; failed: boolean }[] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.#rpc<{ signature: string; err: unknown }[]>('getSignaturesForAddress', [address, { limit: 1000, ...(until ? { until } : {}), ...(before ? { before } : {}) }], 'history');
      if (!page?.length) break;
      out.push(...page.map((p) => ({ sig: p.signature, failed: p.err !== null && p.err !== undefined })));
      if (page.length < 1000 || !until) break;
      const last = page[page.length - 1].signature;
      if (last === before) break;
      before = last;
    }
    return out;
  }

  async #updateHistory(): Promise<void> {
    const sources: { key: string; address: string }[] = [{ key: 'native', address: this.address }];
    for (const x of this.tokens.filter((tk) => tk.enabled)) {
      const accs = this.#accounts.get(x.address) ?? [];
      const ata = accs.find((a) => a.pubkey === associatedTokenAddress(this.address, x.address, a.program === TOKEN_2022_PROGRAM ? TOKEN_2022_PROGRAM : TOKEN_PROGRAM)) ?? accs[0];
      if (ata) sources.push({ key: x.address, address: ata.pubkey });
    }
    const hasHistory = [...this.#txs.values()].some((x) => !x.isPending);
    const seen = new Set<string>();
    for (const s of sources) {
      if (this.#closed) return;
      const sigs = await this.#signatures(s.address, hasHistory ? this.#sigs[s.key] : undefined);
      if (!sigs.length) continue;
      // a failed transaction only moved its fee, which Cake's parser never turns into a row: not fetched
      const todo = sigs.filter((x) => !x.failed && !seen.has(x.sig) && !this.#done.has(x.sig)).map((x) => x.sig);
      todo.forEach((x) => seen.add(x));
      // the newest signature is the source's cursor only once every one of its transactions was read
      if (await this.#fetchTransactions(todo)) this.#sigs[s.key] = sigs[0].sig;
    }
    await this.#resolveMints();
    this.#publishTxs();
  }

  /** reads the transactions on LANES circuits, publishing as they come; false if any could not be read */
  async #fetchTransactions(sigs: string[]): Promise<boolean> {
    let ok = true;
    let next = 0;
    let unpublished = 0;
    const lane = async (i: number) => {
      const scope = `${this.ctx.scope}#sol${i}`;
      while (next < sigs.length && !this.#closed) {
        const sig = sigs[next++];
        const tx = await this.#getTransaction(sig, scope);
        if (tx === undefined) {
          ok = false;
          continue;
        }
        this.#done.add(sig);
        for (const row of parseSolanaTransaction(tx, this.address) ?? []) this.#addRow(row);
        if (++unpublished >= 5) {
          unpublished = 0;
          this.#publishTxs();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LANES, sigs.length) }, (_, i) => lane(i)));
    this.#publishTxs();
    return ok && !this.#closed;
  }

  /** one getTransaction; after an HTTP 429 (the node limits each exit IP) a new circuit and a growing pause */
  async #getTransaction(sig: string, scope: string): Promise<RpcTx | null | undefined> {
    for (let attempt = 0; attempt < 6 && !this.#closed; attempt++) {
      try {
        return await jsonRpc<RpcTx | null>(this.#rpcUrl, 'getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 0 }], { scope, timeoutMs: 45_000, retries: 0, purpose: 'transaction' });
      } catch (e) {
        const limited = (e as { status?: number })?.status === 429 || (e instanceof RpcError && e.code === 429);
        router().rotateIsolation(this.#rpcUrl, scope);
        await sleep(limited ? Math.min(8_000, 1_000 * 2 ** attempt) : 500);
      }
    }
    return undefined;
  }

  #addRow(r: SolRow): void {
    const tok = r.mint ? this.tokens.find((x) => x.address === r.mint) : undefined;
    const sym = r.mint ? (tok?.symbol ?? this.#mints[r.mint]?.symbol ?? 'TOKEN') : undefined;
    const pendingId = r.id.replace(/_(incoming|outgoing)$/, '');
    if (pendingId !== r.id) this.#txs.delete(pendingId);
    this.#txs.set(r.id, {
      id: r.id,
      currency: r.mint ?? 'sol',
      direction: r.outgoing ? 'outgoing' : 'incoming',
      amount: r.amount,
      fee: r.fee,
      date: r.blockTime * 1000,
      confirmations: 1,
      isPending: false,
      from: r.from,
      to: r.to,
      tokenSymbol: sym,
      tokenDecimals: r.mint ? r.decimals : undefined,
      extra: r.mint ? { contract: r.mint, ...(tok?.icon && !tok.isPotentialScam ? { icon: tok.icon } : {}) } : undefined,
    });
  }

  /** names of mints that appeared in history but are not in the token list (Metaplex metadata, at most 20 per sync) */
  async #resolveMints(): Promise<void> {
    const known = new Set(this.tokens.map((x) => x.address));
    const unknown = [...new Set([...this.#txs.values()].map((x) => x.extra?.contract).filter((m): m is string => !!m && !known.has(m) && !this.#mints[m]))].slice(0, 20);
    if (!unknown.length) return;
    try {
      const infos = await this.#accountInfos(unknown.map((m) => metadataAddress(m)));
      unknown.forEach((m, i) => {
        const md = infos[i] ? parseMetadataAccount(infos[i]!.data) : null;
        this.#mints[m] = { symbol: md?.symbol.replace(/^\$/, '') || 'TOKEN', name: md?.name || '' };
      });
      for (const [id, tx] of this.#txs) {
        const m = tx.extra?.contract;
        if (m && this.#mints[m] && tx.tokenSymbol === 'TOKEN') this.#txs.set(id, { ...tx, tokenSymbol: this.#mints[m].symbol });
      }
    } catch { /* next sync */ }
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

  /** getEstimatedFee: the fee of a 1 SOL transfer to itself */
  async #estimate(): Promise<bigint> {
    if (this.#fee && Date.now() - this.#fee.at < 120_000) return this.#fee.value;
    const msg = compileMessage([systemTransfer(this.address, this.address, 1_000_000_000n)], this.address, await this.#blockhash());
    const value = await this.#feeFor(msg.bytes);
    this.#fee = { at: Date.now(), value };
    return value;
  }

  async estimateFee(): Promise<bigint> {
    return this.#fee?.value ?? (await this.#estimate().catch(() => 0n));
  }

  // ---------------------------------------------------------- sending --

  validateAddress(address: string): boolean {
    return isValidSolAddress(address);
  }

  async createTransaction(c: TransactionCredentials): Promise<PendingTransaction> {
    const assetKey = c.outputs[0]?.asset ?? 'sol';
    const token = assetKey === 'sol' ? undefined : this.tokens.find((x) => x.address === assetKey);
    if (assetKey !== 'sol' && (!token || !token.enabled)) throw new Error(`Currency ${assetKey} is not accessible in the wallet, try to enable it first.`);
    const title = token ? token.symbol.toUpperCase() : 'SOL';
    if (c.outputs.length !== 1) throw new Error(`Error creating ${title} transaction.`);
    await this.#updateBalances();
    const out = c.outputs[0];
    const to = (out.extractedAddress || out.address).trim();
    if (!isValidSolAddress(to)) throw new Error(t('error_text_address'));
    const solBal = this.balances.value.sol?.available ?? 0n;
    const avail = token ? this.balances.value[token.address]?.available ?? 0n : solBal;
    const amount = out.sendAll ? avail : out.amount;
    if (avail < amount) throw new Error(`Wrong balance. Not enough ${title} on your balance.`);
    return token ? this.#splTransfer(token, to, amount, solBal) : this.#solTransfer(to, amount, solBal, out.sendAll);
  }

  async #solTransfer(to: string, amount: bigint, solBal: bigint, sendAll: boolean): Promise<PendingTransaction> {
    const bh = await this.#blockhash();
    const fee = await this.#feeFor(compileMessage([systemTransfer(this.address, to, amount)], this.address, bh).bytes);
    let lamports = amount;
    if (sendAll) {
      lamports = amount - fee;
      if (lamports <= 0n) throw new Error('Wrong balance. Not enough SOL on your balance.');
    } else if (!(solBal - (amount + fee) > (await this.#rentExempt(TOKEN_ACCOUNT_SIZE)))) {
      throw new Error(t('solana_sign_native_transaction_rent_exception'));
    }
    const msg = compileMessage([systemTransfer(this.address, to, lamports)], this.address, bh, 0);
    return this.#pending(msg.bytes, lamports, fee, to);
  }

  async #splTransfer(token: WalletToken, to: string, amount: bigint, solBal: bigint): Promise<PendingTransaction> {
    const mint = token.address;
    const offCurve = !isOnCurve(decodeAddress(to));
    const cand = (owner: string) => [associatedTokenAddress(owner, mint, TOKEN_PROGRAM), associatedTokenAddress(owner, mint, TOKEN_2022_PROGRAM)];
    const [senderStd, sender22] = cand(this.address);
    const [rcptStd, rcpt22] = cand(to);
    const [mintInfo, sStd, s22, dest, rStd, r22] = await this.#accountInfos([mint, senderStd, sender22, to, rcptStd, rcpt22]);
    const unrecognized = () => new Error(t('solana_unrecognized_token_program_exception'));
    let program = TOKEN_PROGRAM;
    if (mintInfo) {
      if (mintInfo.owner === TOKEN_2022_PROGRAM) program = TOKEN_2022_PROGRAM;
      else if (mintInfo.owner !== TOKEN_PROGRAM) throw unrecognized();
    }
    // the sender's associated token account: for the mint's program, else the standard one
    let senderProgram = program;
    let senderAta: string | null = program === TOKEN_2022_PROGRAM ? sender22 : senderStd;
    let senderInfo = program === TOKEN_2022_PROGRAM ? s22 : sStd;
    if (senderInfo && senderInfo.owner !== program) throw unrecognized();
    if (!senderInfo) senderAta = null;
    if (!senderAta && program !== TOKEN_PROGRAM && sStd) {
      if (sStd.owner !== TOKEN_PROGRAM) throw unrecognized();
      senderAta = senderStd;
      senderInfo = sStd;
      senderProgram = TOKEN_PROGRAM;
    }
    if (!senderAta || !senderInfo) throw new Error(t('solana_no_associated_token_account_exception'));
    const ataError = (m: string) => new Error(`${t('solana_create_associated_token_account_exception')} ${t('added_message_for_ata_error')}${m ? `\n${m}` : ''}`);
    if (offCurve && dest && (dest.owner === TOKEN_PROGRAM || dest.owner === TOKEN_2022_PROGRAM)) throw ataError(`Recipient ${to} is a token account, not a wallet address`);
    const rcptAta = senderProgram === TOKEN_2022_PROGRAM ? rcpt22 : rcptStd;
    const rcptInfo = senderProgram === TOKEN_2022_PROGRAM ? r22 : rStd;
    if (rcptInfo && rcptInfo.owner !== senderProgram) throw ataError(`Recipient token account is owned by ${rcptInfo.owner}`);
    const create = !rcptInfo;
    const ixs = [
      ...(create ? [createAtaIdempotent({ payer: this.address, ata: rcptAta, owner: to, mint, tokenProgram: senderProgram })] : []),
      transferChecked({ tokenProgram: senderProgram, source: senderAta, mint, destination: rcptAta, owner: this.address, amount, decimals: token.decimals }),
    ];
    const bh = await this.#blockhash();
    const msg = compileMessage(ixs, this.address, bh);
    const fee = await this.#feeFor(msg.bytes);
    const creation = create ? await this.#rentExempt(senderInfo.space) : 0n;
    if (!(solBal - (creation + fee) > (await this.#rentExempt(TOKEN_ACCOUNT_SIZE)))) throw new Error(t('solana_sign_spl_token_transaction_rent_exception'));
    const p = await this.#pending(msg.bytes, amount, fee, to, token);
    if (create) p.notice = t('recipient_account_creation_fee', { amount: `${formatFixed(creation, 9)} SOL` });
    return p;
  }

  async #pending(message: Uint8Array, amount: bigint, fee: bigint, to: string, token?: WalletToken): Promise<PendingTransaction> {
    const { tx, signature } = signMessage(message, this.#seed);
    return {
      id: signature,
      amount,
      fee,
      hex: bytesToHex(tx),
      amountFormatted: formatFixed(amount, token ? token.decimals : 9),
      feeFormatted: formatFixed(fee, 9),
      commit: async () => {
        await this.#rpc('sendTransaction', [base64.encode(tx), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' }], 'broadcast');
        this.#txs.set(signature, { id: signature, currency: token ? token.address : 'sol', direction: 'outgoing', amount, fee, date: Date.now(), confirmations: 0, isPending: true, from: this.address, to, tokenSymbol: token?.symbol, tokenDecimals: token?.decimals, extra: token ? { contract: token.address, ...(token.icon ? { icon: token.icon } : {}) } : undefined });
        this.#publishTxs();
        await this.save();
        void this.#pollForTransaction(signature);
      },
    };
  }

  /** pollForTransaction: up to 5 tries, 1..5 s apart, then a full history update */
  async #pollForTransaction(sig: string): Promise<void> {
    for (let i = 1; i <= 5 && !this.#closed; i++) {
      await new Promise((ok) => setTimeout(ok, i * 1000));
      try {
        const r = await this.#rpc<RpcTx | null>('getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }], 'transaction');
        const rows = r ? parseSolanaTransaction(r, this.address) : null;
        if (rows?.length) {
          this.#txs.delete(sig);
          rows.forEach((row) => this.#addRow(row));
          this.#publishTxs();
          await this.#updateBalances();
          await this.save();
          return;
        }
      } catch { /* retry */ }
    }
    void this.#sync(false);
  }

  // ----------------------------------------------------------- tokens --

  assetList(): TokenAsset[] {
    const b = this.balances.value;
    return [
      { key: 'sol', name: 'Solana', symbol: 'SOL', decimals: 9, balance: b.sol?.available ?? 0n, api: 'crypto.SOL', icon: this.currency.iconPath ?? undefined, isNative: true },
      ...this.tokens.filter((x) => x.enabled).map((x) => ({ key: x.address, name: x.name, symbol: x.symbol, decimals: x.decimals, balance: b[x.address]?.available ?? 0n, api: `sol.${x.address}`, icon: x.isPotentialScam ? undefined : x.icon, address: x.address, isNative: false, isPotentialScam: x.isPotentialScam, groups: x.groups })),
    ];
  }

  isDefaultToken(address: string): boolean {
    return SPL_DEFAULT_TOKENS.some((d) => d.address === address.trim());
  }

  validateTokenAddress(address: string): boolean {
    return isValidSolAddress(address);
  }

  isSuspiciousToken(x: { name: string; symbol: string; address: string }): boolean {
    return isTokenPropertiesSuspicious(x, { nativeSymbol: 'SOL', whitelist: new Set(SPL_DEFAULT_TOKENS.map((d) => d.address.toLowerCase())), defaultSymbols: new Set(SPL_DEFAULT_TOKENS.map((d) => d.symbol.toUpperCase())), foreignNatives: SOLANA_FOREIGN_NATIVES });
  }

  /** fetchSPLTokenInfo: Moralis (with a key), else the Metaplex metadata account; decimals from the mint */
  async tokenInfo(address: string): Promise<{ name: string; symbol: string; decimals: number } | null> {
    const mint = address.trim();
    if (!isValidSolAddress(mint)) return null;
    const key = ((this.ctx.settings() as any).apiKeys?.moralis ?? '').trim();
    const supply = () => this.#rpc<any>('getTokenSupply', [mint], 'token info').then((r) => Number(r?.value?.decimals)).catch(() => NaN);
    if (key) {
      try {
        const m = await getJson<any>(`https://solana-gateway.moralis.io/token/mainnet/${mint}/metadata`, { scope: this.ctx.scope, headers: { Accept: 'application/json', 'X-API-Key': key }, timeoutMs: 45_000, retries: 1, purpose: 'token info' });
        const dec = Number(m?.decimals) > 0 ? Number(m.decimals) : await supply();
        if (Number.isFinite(dec)) return { name: String(m?.name ?? ''), symbol: String(m?.symbol ?? '').replace(/^\$/, '').replace(/\0/g, ''), decimals: dec };
      } catch { /* Metaplex */ }
    }
    try {
      const [info] = await this.#accountInfos([metadataAddress(mint)]);
      const md = info ? parseMetadataAccount(info.data) : null;
      const dec = await supply();
      if (!md || !Number.isFinite(dec)) return null;
      return { name: md.name, symbol: md.symbol.replace(/^\$/, ''), decimals: dec };
    } catch {
      return null;
    }
  }

  /** the "potential scam" contract check is EVM-only */
  async checkContractRisk(): Promise<boolean> {
    return false;
  }

  /** isTokenVerifiedOnJupiter */
  async isVerifiedToken(address: string): Promise<boolean> {
    try {
      const list = await getJson<any[]>(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(address.trim())}`, { scope: this.ctx.scope, timeoutMs: 45_000, retries: 1, purpose: 'token verification' });
      const hit = (list ?? []).find((x) => x?.id === address.trim());
      return !!(hit?.isVerified ?? (Array.isArray(hit?.tags) && hit.tags.includes('verified')));
    } catch {
      return false;
    }
  }

  async addToken(tok: WalletToken): Promise<void> {
    const a = tok.address.trim();
    const t2 = { ...tok, address: a, isPotentialScam: tok.isPotentialScam || this.isSuspiciousToken({ ...tok, address: a }) };
    this.tokenList.value = [...this.tokens.filter((x) => x.address !== a), t2];
    await this.ctx.cachePut('sol:tokens', this.tokens);
    void this.#sync(false);
  }

  async deleteToken(address: string): Promise<void> {
    const tok = this.tokens.find((x) => x.address === address);
    this.tokenList.value = this.tokens.filter((x) => x.address !== address);
    const { [address]: _gone, ...rest } = this.balances.value;
    this.balances.value = rest;
    for (const [id, tx] of this.#txs) if (tok && tx.tokenSymbol === tok.symbol) this.#txs.delete(id);
    delete this.#sigs[address];
    this.#publishTxs();
    await this.ctx.cachePut('sol:tokens', this.tokens);
    await this.save();
  }

  async setTokenEnabled(address: string, enabled: boolean): Promise<void> {
    this.tokenList.value = this.tokens.map((x) => (x.address === address ? { ...x, enabled } : x));
    if (!enabled) {
      const { [address]: _gone, ...rest } = this.balances.value;
      this.balances.value = rest;
    }
    await this.ctx.cachePut('sol:tokens', this.tokens);
    await this.save();
    if (enabled) void this.#sync(false);
  }

  // ----------------------------------------------------------- others --

  async signMessage(message: string): Promise<string> {
    return signText(message, this.#seed);
  }

  async verifyMessage(message: string, signature: string, address?: string): Promise<boolean> {
    if (!address) return false;
    return verifyText(message, signature, address);
  }

  async keys(): Promise<WalletKeysRow[]> {
    return [{ label: t('private_key'), value: bytesToHex(this.#seed) }];
  }

  explorerUrl(txid: string): string {
    return `https://solscan.io/tx/${txid.replace(/_(incoming|outgoing)$/, '')}`;
  }

  async save(): Promise<void> {
    const c: SolCache = { v: 1, balances: this.balances.value, txs: [...this.#txs.values()], sigs: this.#sigs, mints: this.#mints, done: [...this.#done].slice(-5000) };
    await this.ctx.cachePut('sol', c);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#timer);
    await this.save().catch(() => {});
    this.#seed?.fill(0);
  }
}
