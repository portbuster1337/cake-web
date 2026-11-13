// HTTP blockchain indexers for the UTXO coins (BTC, LTC, BCH, DOGE).
//
// Cake Wallet talks to Electrum servers over raw TCP. The in-page Tor client
// (tor-js) carries HTTP(S) only, so the web client uses the HTTP indexers that
// the same servers usually run next to Electrum: Esplora (mempool.space,
// blockstream.info, litecoinspace.org, self-hosted mempool/electrs) and
// Blockbook (Trezor's indexer), plus Blockchair as a fallback. Every request
// goes through the Tor router (src/net/http.ts).

import { getJson, getText, request, text, qs, type HttpOptions } from '../../net/http.ts';

export interface TxIn {
  txid: string;
  vout: number;
  address?: string;
  value?: bigint;
  sequence?: number;
  coinbase?: boolean;
}

export interface TxOut {
  n: number;
  address?: string;
  value: bigint;
  script?: string;
}

export interface ChainTx {
  txid: string;
  /** block height, or 0 while in the mempool */
  height: number;
  /** unix seconds: block time, or first seen */
  time: number;
  fee?: bigint;
  vsize?: number;
  size?: number;
  inputs: TxIn[];
  outputs: TxOut[];
  locktime?: number;
  version?: number;
  hex?: string;
}

export interface Utxo {
  txid: string;
  vout: number;
  value: bigint;
  height: number;
  address: string;
}

export interface AddressSummary {
  address: string;
  txCount: number;
  confirmed: bigint;
  unconfirmed: bigint;
}

/** fee rates in sat/vB (sat/byte for coins without segwit) keyed by target blocks */
export type FeeTable = Record<number, number>;

export interface Indexer {
  readonly kind: 'esplora' | 'blockbook' | 'blockchair' | 'blockcypher' | 'bitcore';
  readonly url: string;
  tip(): Promise<{ height: number; hash?: string }>;
  address(addr: string): Promise<AddressSummary>;
  /** full history of an address (newest first) */
  addressTxs(addr: string): Promise<ChainTx[]>;
  utxos(addr: string): Promise<Utxo[]>;
  tx(txid: string): Promise<ChainTx>;
  txHex(txid: string): Promise<string>;
  broadcast(hex: string): Promise<string>;
  fees(): Promise<FeeTable>;
  blockHash?(height: number): Promise<string>;
}

export interface IndexerConfig {
  kind: Indexer['kind'];
  url: string;
  /** blockchair chain slug, e.g. bitcoin-cash / dogecoin */
  chain?: string;
  scope?: string;
}

const big = (v: unknown): bigint => {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.round(v));
  if (typeof v === 'string' && v) return BigInt(v.includes('.') ? Math.round(Number(v)) : v);
  return 0n;
};

function trim(url: string): string {
  return url.replace(/\/+$/, '');
}

// ------------------------------------------------------------------ Esplora --

export class EsploraIndexer implements Indexer {
  readonly kind = 'esplora' as const;
  readonly url: string;
  readonly opts: HttpOptions;

  constructor(url: string, opts: HttpOptions = {}) {
    this.url = trim(url);
    this.opts = { purpose: 'esplora', ...opts };
  }

  #get<T>(path: string): Promise<T> {
    return getJson<T>(`${this.url}${path}`, this.opts);
  }

  async tip() {
    const [h, hash] = await Promise.all([getText(`${this.url}/blocks/tip/height`, this.opts), getText(`${this.url}/blocks/tip/hash`, this.opts).catch(() => undefined)]);
    return { height: Number(h.trim()), hash: hash?.trim() };
  }

  async blockHash(height: number) {
    return (await getText(`${this.url}/block-height/${height}`, this.opts)).trim();
  }

  async address(addr: string): Promise<AddressSummary> {
    const r = await this.#get<any>(`/address/${addr}`);
    const c = r.chain_stats ?? {};
    const m = r.mempool_stats ?? {};
    return {
      address: addr,
      txCount: (c.tx_count ?? 0) + (m.tx_count ?? 0),
      confirmed: big(c.funded_txo_sum) - big(c.spent_txo_sum),
      unconfirmed: big(m.funded_txo_sum) - big(m.spent_txo_sum),
    };
  }

  static parseTx(t: any): ChainTx {
    return {
      txid: t.txid,
      height: t.status?.confirmed ? t.status.block_height : 0,
      time: t.status?.block_time ?? Math.floor(Date.now() / 1000),
      fee: t.fee !== undefined ? big(t.fee) : undefined,
      vsize: t.weight ? Math.ceil(t.weight / 4) : t.size,
      size: t.size,
      locktime: t.locktime,
      version: t.version,
      inputs: (t.vin ?? []).map((i: any) => ({
        txid: i.txid,
        vout: i.vout,
        address: i.prevout?.scriptpubkey_address,
        value: i.prevout ? big(i.prevout.value) : undefined,
        sequence: i.sequence,
        coinbase: !!i.is_coinbase,
      })),
      outputs: (t.vout ?? []).map((o: any, n: number) => ({ n, address: o.scriptpubkey_address, value: big(o.value), script: o.scriptpubkey })),
    };
  }

  async addressTxs(addr: string): Promise<ChainTx[]> {
    const out: ChainTx[] = [];
    let page = await this.#get<any[]>(`/address/${addr}/txs`);
    out.push(...page.map(EsploraIndexer.parseTx));
    // first page: up to 50 mempool + 25 confirmed; then 25 confirmed per page
    for (let guard = 0; guard < 400; guard++) {
      const confirmed = page.filter((t) => t.status?.confirmed);
      if (confirmed.length < 25) break;
      page = await this.#get<any[]>(`/address/${addr}/txs/chain/${confirmed[confirmed.length - 1].txid}`);
      if (!page.length) break;
      out.push(...page.map(EsploraIndexer.parseTx));
    }
    return out;
  }

  async utxos(addr: string): Promise<Utxo[]> {
    const r = await this.#get<any[]>(`/address/${addr}/utxo`);
    return r.map((u) => ({ txid: u.txid, vout: u.vout, value: big(u.value), height: u.status?.confirmed ? u.status.block_height : 0, address: addr }));
  }

  async tx(txid: string) {
    return EsploraIndexer.parseTx(await this.#get<any>(`/tx/${txid}`));
  }

  async txHex(txid: string) {
    return (await getText(`${this.url}/tx/${txid}/hex`, this.opts)).trim();
  }

  async broadcast(hex: string) {
    const res = await request(`${this.url}/tx`, hex, { ...this.opts, method: 'POST', headers: { 'Content-Type': 'text/plain' }, retries: 0, okStatuses: [400] });
    const body = text(res).trim();
    if (res.status !== 200) throw new Error(body || `broadcast failed (${res.status})`);
    return body;
  }

  async fees(): Promise<FeeTable> {
    const r = await this.#get<Record<string, number>>('/fee-estimates');
    const out: FeeTable = {};
    for (const [k, v] of Object.entries(r)) out[Number(k)] = v;
    return out;
  }
}

// ---------------------------------------------------------------- Blockbook --

export class BlockbookIndexer implements Indexer {
  readonly kind = 'blockbook' as const;
  readonly url: string;
  readonly opts: HttpOptions;

  constructor(url: string, opts: HttpOptions = {}) {
    this.url = trim(url).replace(/\/api(\/v2)?$/, '');
    this.opts = { purpose: 'blockbook', ...opts, headers: { 'User-Agent': 'Mozilla/5.0', ...opts.headers } };
  }

  #get<T>(path: string): Promise<T> {
    return getJson<T>(`${this.url}/api/v2${path}`, this.opts);
  }

  async tip() {
    const r = await this.#get<any>('');
    return { height: Number(r.blockbook?.bestHeight ?? r.backend?.blocks), hash: r.backend?.bestBlockHash };
  }

  async blockHash(height: number) {
    return (await this.#get<any>(`/block-index/${height}`)).blockHash as string;
  }

  async address(addr: string): Promise<AddressSummary> {
    const r = await this.#get<any>(`/address/${addr}${qs({ details: 'basic' })}`);
    return { address: addr, txCount: Number(r.txs ?? 0) + Number(r.unconfirmedTxs ?? 0), confirmed: big(r.balance), unconfirmed: big(r.unconfirmedBalance) };
  }

  static parseTx(t: any): ChainTx {
    return {
      txid: t.txid,
      height: t.blockHeight > 0 ? t.blockHeight : 0,
      time: t.blockTime ?? Math.floor(Date.now() / 1000),
      fee: t.fees !== undefined ? big(t.fees) : undefined,
      vsize: t.vsize ?? t.size,
      size: t.size,
      locktime: t.lockTime,
      version: t.version,
      hex: t.hex,
      inputs: (t.vin ?? []).map((i: any) => ({
        txid: i.txid,
        vout: i.vout ?? 0,
        address: i.isAddress !== false ? i.addresses?.[0] : undefined,
        value: i.value !== undefined ? big(i.value) : undefined,
        sequence: i.sequence,
        coinbase: !!i.coinbase,
      })),
      outputs: (t.vout ?? []).map((o: any) => ({ n: o.n, address: o.isAddress !== false ? o.addresses?.[0] : undefined, value: big(o.value), script: o.hex })),
    };
  }

  async addressTxs(addr: string): Promise<ChainTx[]> {
    const out: ChainTx[] = [];
    for (let page = 1; page < 200; page++) {
      const r = await this.#get<any>(`/address/${addr}${qs({ details: 'txs', page, pageSize: 50 })}`);
      out.push(...(r.transactions ?? []).map(BlockbookIndexer.parseTx));
      if (!r.totalPages || page >= r.totalPages) break;
    }
    return out;
  }

  async utxos(addr: string): Promise<Utxo[]> {
    const r = await this.#get<any[]>(`/utxo/${addr}${qs({ confirmed: false })}`);
    return r.map((u) => ({ txid: u.txid, vout: u.vout, value: big(u.value), height: u.height > 0 ? u.height : 0, address: addr }));
  }

  async tx(txid: string) {
    return BlockbookIndexer.parseTx(await this.#get<any>(`/tx/${txid}`));
  }

  async txHex(txid: string) {
    const t = await this.#get<any>(`/tx/${txid}`);
    if (t.hex) return t.hex as string;
    const s = await this.#get<any>(`/tx-specific/${txid}`);
    return s.hex as string;
  }

  async broadcast(hex: string) {
    const res = await request(`${this.url}/api/v2/sendtx/`, hex, { ...this.opts, method: 'POST', headers: { ...this.opts.headers, 'Content-Type': 'text/plain' }, retries: 0, okStatuses: [400] });
    const j = JSON.parse(text(res));
    if (j.error) throw new Error(typeof j.error === 'string' ? j.error : j.error.message ?? 'broadcast failed');
    return j.result as string;
  }

  async fees(): Promise<FeeTable> {
    const targets = [1, 2, 3, 6, 12, 24, 144];
    const out: FeeTable = {};
    await Promise.all(targets.map(async (b) => {
      try {
        const r = await this.#get<any>(`/estimatefee/${b}`);
        const perKb = Number(r.result);
        // coin units per kB -> sat/vB
        if (perKb > 0) out[b] = (perKb * 1e8) / 1000;
      } catch { /* missing target */ }
    }));
    return out;
  }
}

// ------------------------------------------------------------------ Bitcore --

/**
 * BitPay's Bitcore node API (https://api.bitcore.io/api/<COIN>/mainnet), reachable over Tor. An address is a
 * list of "coins" (outputs paid to it, with the spending transaction); spentHeight -2 = unspent, mintHeight < 0 =
 * in the mempool.
 */
export class BitcoreIndexer implements Indexer {
  readonly kind = 'bitcore' as const;
  readonly url: string;
  readonly opts: HttpOptions;

  constructor(url: string, opts: HttpOptions = {}) {
    this.url = trim(url);
    this.opts = { purpose: 'bitcore', ...opts };
  }

  #get<T>(path: string): Promise<T> {
    return getJson<T>(`${this.url}${path}`, this.opts);
  }

  async tip() {
    const r = await this.#get<any>('/block/tip');
    return { height: Number(r.height), hash: r.hash };
  }

  async #coins(addr: string): Promise<any[]> {
    const r = await this.#get<any[]>(`/address/${addr}/txs${qs({ limit: 1000 })}`);
    return Array.isArray(r) ? r : [];
  }

  async address(addr: string): Promise<AddressSummary> {
    const coins = await this.#coins(addr);
    const txids = new Set<string>();
    let confirmed = 0n;
    let unconfirmed = 0n;
    for (const c of coins) {
      if (c.mintTxid) txids.add(c.mintTxid);
      if (c.spentTxid) txids.add(c.spentTxid);
      const unspent = !c.spentTxid || Number(c.spentHeight) === -2;
      if (!unspent) continue;
      if (Number(c.mintHeight) >= 0) confirmed += big(c.value);
      else unconfirmed += big(c.value);
    }
    return { address: addr, txCount: txids.size, confirmed, unconfirmed };
  }

  #parse(t: any): ChainTx {
    const ins: any[] = t.coins?.inputs ?? [];
    const outs: any[] = t.coins?.outputs ?? [];
    const time = Date.parse(t.blockTimeNormalized ?? t.blockTime ?? '');
    return {
      txid: t.txid,
      height: Number(t.blockHeight) > 0 ? Number(t.blockHeight) : 0,
      time: Number.isFinite(time) ? Math.floor(time / 1000) : Math.floor(Date.now() / 1000),
      fee: t.fee !== undefined ? big(t.fee) : undefined,
      size: t.size,
      vsize: t.size,
      inputs: ins.map((i) => ({ txid: i.mintTxid, vout: Number(i.mintIndex), address: i.address && i.address !== 'false' ? i.address : undefined, value: big(i.value), sequence: i.sequenceNumber })),
      outputs: outs.sort((a, b) => Number(a.mintIndex) - Number(b.mintIndex)).map((o) => ({ n: Number(o.mintIndex), address: o.address && o.address !== 'false' ? o.address : undefined, value: big(o.value), script: o.script })),
    };
  }

  async addressTxs(addr: string): Promise<ChainTx[]> {
    const coins = await this.#coins(addr);
    const txids = [...new Set(coins.flatMap((c) => [c.mintTxid, c.spentTxid]).filter((x): x is string => !!x))];
    const out: ChainTx[] = [];
    for (let i = 0; i < txids.length; i += 4) {
      const got = await Promise.all(txids.slice(i, i + 4).map((id) => this.tx(id).catch(() => null)));
      for (const t of got) if (t) out.push(t);
    }
    return out.sort((a, b) => (a.height === 0 ? -1 : b.height === 0 ? 1 : b.height - a.height));
  }

  async utxos(addr: string): Promise<Utxo[]> {
    const r = await this.#get<any[]>(`/address/${addr}${qs({ unspent: true, limit: 1000 })}`);
    return (Array.isArray(r) ? r : []).map((c) => ({ txid: c.mintTxid, vout: Number(c.mintIndex), value: big(c.value), height: Number(c.mintHeight) > 0 ? Number(c.mintHeight) : 0, address: addr }));
  }

  async tx(txid: string) {
    return this.#parse(await this.#get<any>(`/tx/${txid}/populated`));
  }

  async txHex(_txid: string): Promise<string> {
    throw new Error('Raw transactions are not available from this indexer');
  }

  async broadcast(hex: string) {
    const res = await request(`${this.url}/tx/send`, JSON.stringify({ rawTx: hex }), { ...this.opts, method: 'POST', headers: { 'Content-Type': 'application/json' }, retries: 0, okStatuses: [400, 500] });
    const body = text(res);
    let j: any = null;
    try {
      j = JSON.parse(body);
    } catch { /* plain-text error */ }
    if (!j?.txid) throw new Error(j?.error ?? j?.message ?? (body || 'broadcast failed'));
    return j.txid as string;
  }

  /** estimates in coin/kB, as sat/byte */
  async fees(): Promise<FeeTable> {
    const out: FeeTable = {};
    await Promise.all([1, 3, 6, 144].map(async (target) => {
      try {
        const r = await this.#get<any>(`/fee/${target}`);
        const v = Number(r?.feerate);
        if (v > 0) out[target] = (v * 1e8) / 1000;
      } catch { /* skip */ }
    }));
    return out;
  }
}

// --------------------------------------------------------------- Blockchair --

export class BlockchairIndexer implements Indexer {
  readonly kind = 'blockchair' as const;
  readonly url: string;
  readonly chain: string;
  readonly opts: HttpOptions;

  constructor(url: string, chain: string, opts: HttpOptions = {}) {
    this.url = trim(url);
    this.chain = chain;
    this.opts = { purpose: 'blockchair', ...opts };
  }

  #get<T>(path: string): Promise<T> {
    return getJson<T>(`${this.url}/${this.chain}${path}`, this.opts);
  }

  async tip() {
    const r = await this.#get<any>('/stats');
    return { height: Number(r.data.best_block_height), hash: r.data.best_block_hash };
  }

  async address(addr: string): Promise<AddressSummary> {
    const r = await this.#get<any>(`/dashboards/address/${addr}`);
    const a = Object.values<any>(r.data)[0].address;
    return { address: addr, txCount: Number(a.transaction_count ?? 0), confirmed: big(a.balance), unconfirmed: 0n };
  }

  #parse(d: any): ChainTx {
    const t = d.transaction;
    return {
      txid: t.hash,
      height: t.block_id > 0 ? t.block_id : 0,
      time: Math.floor(new Date(`${t.time}Z`).getTime() / 1000),
      fee: big(t.fee),
      size: t.size,
      vsize: t.size,
      inputs: (d.inputs ?? []).map((i: any) => ({ txid: i.transaction_hash, vout: i.index, address: i.recipient, value: big(i.value), sequence: i.spending_sequence })),
      outputs: (d.outputs ?? []).map((o: any) => ({ n: o.index, address: o.recipient, value: big(o.value), script: o.script_hex })),
    };
  }

  async addressTxs(addr: string): Promise<ChainTx[]> {
    const r = await this.#get<any>(`/dashboards/address/${addr}${qs({ limit: 100 })}`);
    const hashes: string[] = Object.values<any>(r.data)[0].transactions ?? [];
    const out: ChainTx[] = [];
    for (let i = 0; i < hashes.length; i += 10) {
      const batch = hashes.slice(i, i + 10);
      const d = await this.#get<any>(`/dashboards/transactions/${batch.join(',')}`);
      for (const h of batch) if (d.data[h]) out.push(this.#parse(d.data[h]));
    }
    return out;
  }

  async utxos(addr: string): Promise<Utxo[]> {
    const r = await this.#get<any>(`/dashboards/address/${addr}${qs({ limit: '0,100' })}`);
    return (Object.values<any>(r.data)[0].utxo ?? []).map((u: any) => ({ txid: u.transaction_hash, vout: u.index, value: big(u.value), height: u.block_id > 0 ? u.block_id : 0, address: addr }));
  }

  async tx(txid: string) {
    const d = await this.#get<any>(`/dashboards/transaction/${txid}`);
    return this.#parse(d.data[txid]);
  }

  async txHex(txid: string) {
    const d = await this.#get<any>(`/raw/transaction/${txid}`);
    return d.data[txid].raw_transaction as string;
  }

  async broadcast(hex: string) {
    const res = await request(`${this.url}/${this.chain}/push/transaction`, `data=${hex}`, { ...this.opts, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, retries: 0, okStatuses: [400] });
    const j = JSON.parse(text(res));
    if (!j.data?.transaction_hash) throw new Error(j.context?.error ?? 'broadcast failed');
    return j.data.transaction_hash as string;
  }

  async fees(): Promise<FeeTable> {
    const r = await this.#get<any>('/stats');
    const f = Number(r.data.suggested_transaction_fee_per_byte_sat);
    return { 1: f * 1.5, 3: f, 6: f, 144: Math.max(1, f / 2) };
  }
}

export function makeIndexer(c: IndexerConfig): Indexer {
  const opts: HttpOptions = { scope: c.scope };
  switch (c.kind) {
    case 'esplora':
      return new EsploraIndexer(c.url, opts);
    case 'blockbook':
      return new BlockbookIndexer(c.url, opts);
    case 'blockchair':
      return new BlockchairIndexer(c.url, c.chain ?? 'bitcoin', opts);
    case 'bitcore':
      return new BitcoreIndexer(c.url, opts);
    default:
      throw new Error(`Unsupported indexer ${c.kind}`);
  }
}
