// In-browser Tor client (Arti compiled to WebAssembly, via tor-js).
//
// The page itself builds Tor circuits and talks end-to-end encrypted to
// .onion nodes. The relay entry points (tor-js gateways / WebSocket bridges)
// only carry encrypted Tor cells to the first Tor relay.

import { TorClient, Log, storage as torStorage } from 'tor-js/wasm-file';
import type { ArtiSocketProvider, TorStorage } from 'tor-js/wasm-file';
import { RelayPool, type RelayEntry } from './relays.ts';
import { anySignal, timeoutSignal } from './signals.ts';

export type TorState = 'idle' | 'starting' | 'ready' | 'error' | 'closed';

export interface TorStatus {
  state: TorState;
  message: string;
  startedAt?: number;
  readyAt?: number;
  error?: string;
  /** the relay entry point currently in use */
  via?: string;
}

export interface TorFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  isolationKey?: string;
  timeoutMs?: number;
  /** give up if no data arrives for this long (a stalled stream); default 90 s */
  idleMs?: number;
  signal?: AbortSignal;
  /** stop reading (and fail) once the body is larger than this */
  maxBytes?: number;
}

/** a response body over the request's maxBytes (not retried) */
export class ResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`Response larger than ${limit} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

export interface RawResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** A failure to open a stream over a Tor circuit (as opposed to an HTTP error). */
export class TorConnectError extends Error {
  readonly torKind?: string;
  readonly timedOut: boolean;
  /** the stream stopped delivering data: a new circuit usually helps */
  readonly stalled: boolean;
  constructor(message: string, torKind?: string, timedOut = false, stalled = false) {
    super(message);
    this.name = 'TorConnectError';
    this.torKind = torKind;
    this.timedOut = timedOut;
    this.stalled = stalled;
  }
}

const PROGRESS_PATTERNS: [RegExp, string][] = [
  [/Fast bootstrap: fetching/i, 'Downloading the Tor directory…'],
  [/Downloading certificates/i, 'Downloading Tor directory certificates…'],
  [/Downloading microdescriptors/i, 'Downloading Tor relay descriptors…'],
  [/Downloading a consensus|consensus/i, 'Fetching the Tor network consensus…'],
  [/enough information to build circuits/i, 'Building Tor circuits…'],
  [/Bootstrap complete/i, 'Connected to the Tor network'],
];

const STICKY_KEY = 'cw-relay-sticky';

export class TorTransport {
  readonly entries: RelayEntry[];
  #client: TorClient | null = null;
  #pool: RelayPool | null = null;
  #status: TorStatus = { state: 'idle', message: 'Not started' };
  #listeners = new Set<(s: TorStatus) => void>();
  #ready: Promise<void> | null = null;
  #storage: TorStorage | undefined;
  readonly logs: string[] = [];

  constructor(entries: RelayEntry[], opts: { storage?: TorStorage } = {}) {
    this.entries = entries;
    this.#storage = opts.storage;
  }

  get status(): TorStatus {
    return this.#status;
  }

  onStatus(fn: (s: TorStatus) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #set(patch: Partial<TorStatus>) {
    this.#status = { ...this.#status, ...patch };
    for (const fn of this.#listeners) fn(this.#status);
  }

  #log(level: string, args: unknown[]) {
    const line = args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(' ');
    this.logs.push(`${new Date().toISOString().slice(11, 19)} ${level} ${line}`);
    if (this.logs.length > 400) this.logs.splice(0, this.logs.length - 400);
    if (this.#status.state === 'starting') {
      for (const [re, msg] of PROGRESS_PATTERNS) {
        if (re.test(line)) {
          this.#set({ message: msg });
          break;
        }
      }
    }
  }

  start(): Promise<void> {
    if (this.#ready) return this.#ready;
    this.#set({ state: 'starting', message: 'Starting Tor…', startedAt: Date.now(), error: undefined });
    const log = new Log({ rawLog: (level, ...args) => this.#log(level, args) });
    const options: ConstructorParameters<typeof TorClient>[0] = { log, logLevel: 'info' };
    const direct = this.entries.length === 1 && this.entries[0].kind === 'direct';
    if (!direct) {
      let preferred: string | undefined;
      try {
        preferred = globalThis.localStorage?.getItem(STICKY_KEY) ?? undefined;
      } catch { /* no storage */ }
      const pool = new RelayPool(this.entries.filter((e) => e.kind !== 'direct'), { log, preferred });
      pool.onChange = (short) => {
        this.#set({ via: short });
        try {
          if (pool.current) globalThis.localStorage?.setItem(STICKY_KEY, pool.current);
        } catch { /* no storage */ }
      };
      this.#pool = pool;
      options.socketProvider = pool as unknown as ArtiSocketProvider;
    }
    options.storage = this.#storage ?? (typeof indexedDB !== 'undefined'
      ? torStorage.addLocking(new torStorage.IndexedDBStorage('cw-tor'), 'cw-tor')
      : new torStorage.MemoryStorage());
    this.#ready = (async () => {
      try {
        this.#client = new TorClient(options);
        await this.#client.ready();
        this.#set({ state: 'ready', message: 'Connected to the Tor network', readyAt: Date.now() });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.#set({ state: 'error', message: 'Could not connect to Tor', error: msg });
        this.#ready = null;
        this.#client?.close();
        this.#client = null;
        throw e;
      }
    })();
    return this.#ready;
  }

  async fetch(url: string, init: TorFetchInit = {}): Promise<RawResponse> {
    await this.start();
    const client = this.#client;
    if (!client) throw new Error('Tor is not running');
    const timeout = timeoutSignal(init.timeoutMs ?? 120_000);
    // Over Tor a stream sometimes just stops: no data, no error. Notice it
    // within idleMs instead of waiting for the overall timeout.
    const idle = new AbortController();
    const idleMs = init.idleMs ?? 90_000;
    let timer = setTimeout(() => idle.abort(), idleMs);
    const alive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(), idleMs);
    };
    const signal = anySignal([init.signal, timeout, idle.signal]);
    const fail = (e: unknown): Error => {
      const err = e as Error & { code?: string; torKind?: string };
      if (init.signal?.aborted) return new Error('Request cancelled');
      if (timeout.aborted) return new TorConnectError('Request over Tor timed out', err.torKind, true);
      if (idle.signal.aborted) return new TorConnectError(`Tor stream stalled (no data for ${Math.round(idleMs / 1000)} s)`, err.torKind, true, true);
      return new TorConnectError(`Tor request failed: ${err.message}${err.torKind ? ` (${err.torKind})` : ''}`, err.torKind);
    };
    try {
      let res: Response;
      try {
        res = await client.fetch(url, {
          method: init.method ?? 'GET',
          headers: init.headers,
          body: init.body,
          signal,
          anonOptions: init.isolationKey ? { isolationKey: init.isolationKey } : undefined,
        });
      } catch (e) {
        throw fail(e);
      }
      alive();
      const chunks: Uint8Array[] = [];
      let size = 0;
      let tooLarge = false;
      try {
        const reader = res.body?.getReader();
        if (reader) {
          const aborted = new Promise<never>((_, reject) => {
            const stop = () => {
              reader.cancel().catch(() => {});
              reject(new Error('aborted'));
            };
            if (signal.aborted) stop();
            else signal.addEventListener('abort', stop, { once: true });
          });
          aborted.catch(() => {});
          for (;;) {
            const { done, value } = await Promise.race([reader.read(), aborted]);
            if (done) break;
            chunks.push(value);
            size += value.length;
            if (init.maxBytes !== undefined && size > init.maxBytes) {
              tooLarge = true;
              reader.cancel().catch(() => {});
              break;
            }
            alive();
          }
        } else {
          chunks.push(new Uint8Array(await res.arrayBuffer()));
          size = chunks[0].length;
          tooLarge = init.maxBytes !== undefined && size > init.maxBytes;
        }
      } catch (e) {
        throw fail(e);
      }
      if (tooLarge) throw new ResponseTooLargeError(init.maxBytes!);
      const body = chunks.length === 1 ? chunks[0] : new Uint8Array(size);
      if (chunks.length > 1) {
        let o = 0;
        for (const c of chunks) {
          body.set(c, o);
          o += c.length;
        }
      }
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headers[k] = v;
      });
      return { status: res.status, statusText: res.statusText, headers, body };
    } finally {
      clearTimeout(timer);
    }
  }

  close(): void {
    this.#client?.close();
    this.#pool?.close();
    this.#client = null;
    this.#pool = null;
    this.#ready = null;
    this.#set({ state: 'closed', message: 'Tor stopped' });
  }
}
