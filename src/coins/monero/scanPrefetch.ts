// Faster blockchain scans over Tor.
//
// wallet2 downloads blocks (/getblocks.bin) one batch at a time and only asks
// for the next batch after it has parsed and scanned the last one: the
// network sits idle while it works, and over Tor a single download is slow
// anyway. Its next requests are predictable, though: it continues from the
// last block of the previous answer. The prefetcher downloads the next few
// batches from the same node, in parallel, while wallet2 works, and hands
// them over when wallet2 asks.
//
// (Block *hash* downloads, wallet2's first step for a restored wallet, are not
// prefetched: wallet2 does almost no work between them, and in measurements
// prefetching them was not faster.)
//
// Safety: wallet2 only ever receives its node's genuine answers to
// equivalent requests. A prefetched answer is used only if the request it was
// made with asks exactly what wallet2 asks: the same starting block and the
// same options, except at most BLOCKS_BATCH blocks (nodes may always send
// fewer). The answer itself proves the starting block is on the node's chain.
// Anything else (a reorg, another node, an error, a slow answer) just sends
// wallet2's own request. The node sees the block ranges it would see anyway.

import { T, decode, decodeShallow, encode, getBlob, getNum, getString, arrayLength, withFields, type Section } from '../../net/epee.ts';
import type { RawResponse } from '../../net/tor.ts';

export interface PrefetchIO {
  /** POST a binary RPC request to the node (over wallet2's own circuit). */
  post(origin: string, path: string, body: Uint8Array, signal: AbortSignal): Promise<RawResponse>;
  /** Hash of the main-chain block at a height (JSON-RPC on_getblockhash). */
  blockHash(origin: string, height: number, signal: AbortSignal): Promise<Uint8Array>;
}

const PATH = '/getblocks.bin';
/**
 * Blocks per prefetched answer (~4 MB on mainnet). wallet2's own requests get
 * up to 1000 blocks or 20000 transactions (~11 MB); smaller batches arrive
 * sooner, so the next one is ready while wallet2 still works.
 */
export const BLOCKS_BATCH = 200;
/** prefetched answers nobody asked for are dropped after this */
const STALE_MS = 3 * 60_000;
/**
 * Batches downloading at once. Over Tor one download is slow (each stream has
 * a small flow-control window); two on a circuit move about twice as much.
 * More would mostly share the circuit's own window, and stretch each download
 * on a slow circuit. (monerod also accepts only 3 RPC connections per public
 * IP by default, and a clearnet node sees one Tor exit for all of them.)
 */
const PARALLEL = 2;

interface Ahead {
  /** requestKey() of the request sent for this batch (null if it could not be made) */
  key: Promise<string | null>;
  res: Promise<RawResponse | null>;
  at: number;
  /** stops the download when the batch is no longer wanted */
  abort: AbortController;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

function hex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

export function parseHex32(s: unknown): Uint8Array | null {
  if (typeof s !== 'string' || !/^[0-9a-f]{64}$/i.test(s)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const u64 = (v: number) => ({ type: T.U64, value: BigInt(v) });

/**
 * The request for the batch that continues from block `top`: wallet2's own
 * request with a chain history of just that block (plus genesis, which the
 * node requires), without pool data, for at most BLOCKS_BATCH blocks.
 */
export function batchRequest(template: Section, top: Uint8Array, genesis: Uint8Array): Section {
  const ids = sameBytes(top, genesis) ? genesis : concat(top, genesis);
  return withFields(template, {
    block_ids: { type: T.STR, value: ids },
    start_height: u64(0),
    requested_info: { type: T.U8, value: 0 },
    pool_info_since: u64(0),
    max_block_count: u64(BLOCKS_BATCH),
  });
}

/**
 * Fields left out of the comparison: the ones a batch request sets itself,
 * and `client`, wallet2's per-request RPC-payment signature, which nodes
 * ignore unless they charge for RPC (then a reused one is refused, the
 * prefetch fails, and wallet2's own request is sent).
 */
const BATCH_FIELDS = new Set(['block_ids', 'start_height', 'requested_info', 'pool_info_since', 'max_block_count', 'client']);

/**
 * What a request asks for apart from those fields: a starting block and
 * options. The node answers two requests with the same key with the same
 * blocks.
 */
export function requestKey(top: Uint8Array, req: Section): string {
  const rest = [...req].filter(([k]) => !BATCH_FIELDS.has(k)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${hex(top)}|${hex(encode(new Map(rest)))}`;
}

export class ScanPrefetcher {
  #io: PrefetchIO;
  #ahead = new Map<number, Ahead>();
  /** the last answer wallet2 got: [start, start + n) */
  #last: { start: number; n: number } | null = null;
  #origin = '';
  #template: Section | null = null;
  #genesis: Uint8Array | null = null;
  /** the node ignores max_block_count (older nodes): no prefetching */
  #off = false;
  #closed = false;
  #running = 0;
  #queue: (() => void)[] = [];
  readonly stats = { hits: 0, misses: 0, prefetched: 0 };

  constructor(io: PrefetchIO) {
    this.#io = io;
  }

  close(): void {
    this.#closed = true;
    this.#reset();
    for (const go of this.#queue.splice(0)) go();
  }

  /** forget planned batches, stopping their downloads */
  #drop(height?: number) {
    for (const [h, e] of this.#ahead) {
      if (height !== undefined && h !== height) continue;
      e.abort.abort();
      this.#ahead.delete(h);
    }
  }

  /** run fn when one of the PARALLEL download slots is free */
  async #slot<R>(fn: () => Promise<R>): Promise<R> {
    while (this.#running >= PARALLEL) await new Promise<void>((r) => this.#queue.push(r));
    this.#running++;
    try {
      if (this.#closed) throw new Error('closed');
      return await fn();
    } finally {
      this.#running--;
      this.#queue.shift()?.();
    }
  }

  #reset() {
    this.#drop();
    this.#last = null;
    this.#template = null;
  }

  /**
   * Handle one of wallet2's requests. `forward(body?)` sends it to the node:
   * as is, or with the given body (the same request asking for at most
   * BLOCKS_BATCH blocks, so wallet2 gets to work sooner).
   */
  async request(url: string, body: Uint8Array | string | undefined, forward: (body?: Uint8Array) => Promise<RawResponse>): Promise<RawResponse> {
    const u = new URL(url);
    if (u.pathname !== PATH || !(body instanceof Uint8Array) || this.#closed) return forward();
    let req: Section;
    try {
      req = decode(body);
    } catch {
      return forward();
    }
    const ids = getBlob(req, 'block_ids');
    const info = getNum(req, 'requested_info') ?? 0;
    if (!ids || ids.length < 32 || ids.length % 32 || (getNum(req, 'start_height') ?? 0) !== 0 || req.get('block_ids_exclusive')?.value || info > 1) return forward();
    if (u.origin !== this.#origin) {
      this.#reset(); // another node: nothing prefetched applies
      this.#origin = u.origin;
    }
    const top = ids.subarray(0, 32);
    const genesis = ids.slice(ids.length - 32);
    if (this.#genesis && !sameBytes(genesis, this.#genesis)) this.#reset();
    this.#genesis = genesis;
    this.#template = req;

    let res: RawResponse | null = null;
    // requests that want pool data (the first of each wallet2 refresh) always go out as they are
    const at = this.#last ? this.#last.start + this.#last.n - 1 : undefined;
    const entry = info === 0 && at !== undefined ? this.#ahead.get(at) : undefined;
    if (entry) {
      this.#ahead.delete(at!);
      // a matching download still arriving is waited for: asking again would only compete with it
      if ((await entry.key) === requestKey(top, req)) res = await entry.res;
      else entry.abort.abort();
    }
    let capped = false;
    if (res) this.stats.hits++;
    else {
      this.stats.misses++;
      // wallet2 went elsewhere: drop the plan. (A request with pool data starts a
      // new refresh from where wallet2 was, e.g. after a pause: keep what's ahead.)
      if (info === 0) this.#drop();
      const max = getNum(req, 'max_block_count') ?? 0;
      capped = !this.#off && !(max > 0 && max <= BLOCKS_BATCH);
      res = await forward(capped ? encode(withFields(req, { max_block_count: u64(BLOCKS_BATCH) })) : undefined);
    }
    this.#plan(res, capped);
    return res;
  }

  /**
   * After an answer went to wallet2: download the next batches while it works.
   * `capped`: wallet2's request was sent asking for at most BLOCKS_BATCH blocks.
   */
  #plan(res: RawResponse, capped: boolean) {
    if (this.#closed || this.#off || res.status !== 200) return;
    let r: Section;
    try {
      r = decodeShallow(res.body);
    } catch {
      return;
    }
    if (getString(r, 'status') !== 'OK') return;
    const start = getNum(r, 'start_height');
    const tip = getNum(r, 'current_height');
    const n = arrayLength(r, 'blocks') ?? 0;
    if (start === undefined || tip === undefined || n < 2) return;
    this.#last = { start, n };
    if (capped && n > BLOCKS_BATCH) {
      this.#off = true; // the node ignores max_block_count: batches would never line up
      return;
    }
    const now = Date.now();
    for (const [height, e] of this.#ahead) if (height < start + n - 1 || now - e.at > STALE_MS) this.#drop(height);
    // a short answer means wallet2 has reached the node's tip
    if (n < Math.min(BLOCKS_BATCH, 100)) return;
    // wallet2 continues from the last block it got, and each batch from the last of the one before
    for (let k = 0, height = start + n - 1; k < PARALLEL; k++, height += BLOCKS_BATCH - 1) {
      if (height + 2 >= tip) break;
      if (!this.#ahead.has(height)) this.#ahead.set(height, this.#fetch(height));
    }
  }

  #fetch(height: number): Ahead {
    const origin = this.#origin;
    const template = this.#template!;
    const genesis = this.#genesis!;
    const abort = new AbortController();
    // (the tiny hash lookup doesn't wait for a download slot)
    const hash = this.#io.blockHash(origin, height, abort.signal)
      .then((h) => (h.length === 32 && !this.#closed && origin === this.#origin ? h : null))
      .catch(() => null);
    const res = hash.then(async (h) => {
      if (!h) return null;
      this.stats.prefetched++;
      const out = await this.#slot(() => (abort.signal.aborted ? Promise.reject(new Error('dropped')) : this.#io.post(origin, PATH, encode(batchRequest(template, h, genesis)), abort.signal)));
      if (out.status !== 200) return null;
      const r = decodeShallow(out.body);
      // the answer starting at this height proves the block is on the node's chain
      if (getString(r, 'status') !== 'OK' || getNum(r, 'start_height') !== height) return null;
      if ((arrayLength(r, 'blocks') ?? 0) > BLOCKS_BATCH) {
        this.#off = true; // the node ignores max_block_count
        return null;
      }
      return out;
    }).catch(() => null);
    return { key: hash.then((h) => (h ? requestKey(h, template) : null)), res, at: Date.now(), abort };
  }
}
