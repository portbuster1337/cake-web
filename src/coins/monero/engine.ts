// Main-thread client for the wallet worker. It speaks monero-ts's worker
// message protocol ([objectId, fnName, callbackId, ...args]) and serves the
// worker's HTTP requests through the network router (Tor-only policy).

import type { NetRouter } from '../../net/router.ts';
import type { RawResponse } from '../../net/tor.ts';
import { ScanPrefetcher, parseHex32 } from './scanPrefetch.ts';

type Callback = (...args: any[]) => void;

interface NetMessage {
  id: number;
  cancel?: number;
  method: 'GET' | 'POST';
  uri: string;
  body: Uint8Array | string;
  binary: boolean;
  username: string;
  password: string;
}

export class WorkerError extends Error {
  code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
  }
}

function uuid(): string {
  return crypto.randomUUID();
}

export class WalletWorker {
  /** engines currently running (diagnostics: a closed wallet's engine must go away) */
  static live = 0;
  readonly worker: Worker;
  #callbacks = new Map<string, Callback | [Callback, boolean]>();
  #inflight = new Map<number, AbortController>();
  #router: NetRouter;
  #offline = false;
  #terminated = false;
  #prefetchSeq = 0;
  #auth: { username?: string; password?: string } = {};
  /** fetches the next blocks of a scan ahead of wallet2 (see scanPrefetch.ts) */
  readonly prefetch: ScanPrefetcher;

  constructor(router: NetRouter, workerUrl = './monero.worker.host.js', opts: { prefetch?: boolean } = {}) {
    this.#router = router;
    this.prefetch = new ScanPrefetcher({
      post: (origin, path, body, signal) => this.#prefetchRequest(`${origin}${path}`, body, `scan prefetch ${path}`, signal),
      blockHash: async (origin, height, signal) => {
        const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'on_get_block_hash', params: [height] });
        const res = await this.#prefetchRequest(`${origin}/json_rpc`, body, 'scan prefetch block hash', signal);
        const hash = parseHex32(JSON.parse(new TextDecoder().decode(res.body))?.result);
        if (!hash) throw new Error('bad block hash');
        return hash;
      },
    });
    if (opts.prefetch === false) this.prefetch.close();
    this.worker = new Worker(workerUrl, { name: 'wallet' });
    WalletWorker.live++;
    const ch = new MessageChannel();
    this.worker.postMessage({ __cwNetPort: ch.port2 }, [ch.port2]);
    ch.port1.onmessage = (ev) => this.#onNet(ch.port1, ev.data as NetMessage);
    this.worker.onmessage = (e) => this.#onMessage(e.data);
    this.worker.onerror = (e) => console.error('wallet worker error', e.message);
  }

  get terminated(): boolean {
    return this.#terminated;
  }

  #onMessage(data: any[]) {
    const key = `${data[0]}:${data[1]}`;
    const cb = this.#callbacks.get(key);
    if (!cb) return;
    if (Array.isArray(cb)) {
      cb[0](...data.slice(2)); // persistent listener callback
    } else {
      this.#callbacks.delete(key);
      cb(data[2]);
    }
  }

  async #onNet(port: MessagePort, m: NetMessage) {
    if (m.cancel) {
      this.#inflight.get(m.cancel)?.abort();
      return;
    }
    if (this.#offline) {
      port.postMessage({ id: m.id, ok: false, error: 'Wallet closed' });
      return;
    }
    const ac = new AbortController();
    this.#inflight.set(m.id, ac);
    try {
      const path = new URL(m.uri).pathname;
      this.#auth = { username: m.username || undefined, password: m.password || undefined };
      const forward = (body?: Uint8Array) => this.#router.request({
        url: m.uri,
        method: m.method,
        body: body ?? m.body,
        username: m.username || undefined,
        password: m.password || undefined,
        timeoutMs: path.endsWith('.bin') ? 300_000 : 120_000,
        signal: ac.signal,
        purpose: `wallet ${path}`,
      });
      const res = m.method === 'POST' ? await this.prefetch.request(m.uri, m.body, forward) : await forward();
      if (this.#offline) throw new Error('Wallet closed');
      const body = res.body.slice().buffer;
      port.postMessage({ id: m.id, ok: true, status: res.status, statusText: res.statusText, headers: res.headers, body }, [body]);
    } catch (e) {
      port.postMessage({ id: m.id, ok: false, error: (e as Error).message });
    } finally {
      this.#inflight.delete(m.id);
    }
  }

  /**
   * Cut this engine off the network for good: running requests are aborted
   * and new ones fail at once. Used when its wallet is closed, so a scan that
   * is still winding down can't send anything (over circuits that belong to
   * the next session).
   */
  cutNetwork(): void {
    this.#offline = true;
    this.prefetch.close();
    for (const ac of this.#inflight.values()) ac.abort();
  }

  /** Prefetches go to wallet2's node over the same circuit as its own requests. */
  async #prefetchRequest(url: string, body: Uint8Array | string, purpose: string, signal: AbortSignal): Promise<RawResponse> {
    if (this.#offline) throw new Error('Wallet closed');
    const ac = new AbortController();
    signal.addEventListener('abort', () => ac.abort(), { once: true });
    const id = -(++this.#prefetchSeq);
    this.#inflight.set(id, ac);
    try {
      return await this.#router.request({ url, method: 'POST', body, ...this.#auth, timeoutMs: 300_000, signal: ac.signal, purpose });
    } finally {
      this.#inflight.delete(id);
    }
  }

  invoke<T = any>(objectId: string | undefined, fn: string, args: unknown[] = []): Promise<T> {
    if (this.#terminated) return Promise.reject(new WorkerError('Wallet engine stopped'));
    const oid = objectId ?? uuid();
    const callbackId = uuid();
    return new Promise<T>((resolve, reject) => {
      this.#callbacks.set(`${oid}:${callbackId}`, (resp: any) => {
        if (resp && resp.error) {
          const err = new WorkerError(resp.error.message ?? String(resp.error), resp.error.code);
          reject(err);
        } else resolve(resp ? resp.result : undefined);
      });
      this.worker.postMessage([oid, fn, callbackId, ...args]);
    });
  }

  /** Register a persistent callback for worker events like "onSyncProgress_<id>". */
  on(objectId: string, event: string, fn: Callback): () => void {
    const key = `${objectId}:${event}`;
    this.#callbacks.set(key, [fn, true]);
    return () => this.#callbacks.delete(key);
  }

  /** Discard the engine and everything in its memory (keys included). */
  terminate(): void {
    if (this.#terminated) return;
    this.#terminated = true;
    WalletWorker.live--;
    this.cutNetwork();
    this.worker.terminate();
    const pending = [...this.#callbacks.values()].filter((cb): cb is Callback => !Array.isArray(cb));
    this.#callbacks.clear();
    for (const cb of pending) cb({ error: { message: 'Wallet engine stopped' } });
  }
}
