// The single choke point for every network request the app makes.
//
// Policy:
//  * Every public host (.onion or clearnet) is reached only through Tor: the
//    Tor client (Arti compiled to WebAssembly) runs inside this page, so
//    circuits are built and encrypted here and no request ever leaves the
//    browser without Tor.
//  * Requests are isolated: different wallets (scopes) never share a Tor
//    circuit, and different hosts get different circuits, so an exit relay
//    or a server cannot link them.
//  * A node on this computer / the local network is reached directly, but
//    only after the user added it as their own node (Tor cannot reach private
//    networks).
//  * I2P and anything else are refused.

import { parseNodeUrl, type NodeKind } from './addr.ts';
import { TorTransport, TorConnectError, type TorStatus, type RawResponse } from './tor.ts';
import { parseRelayList } from './relays.ts';
import { anySignal, timeoutSignal } from './signals.ts';
import { md5Hex } from './md5.ts';
import type { TorStorage } from 'tor-js/wasm-file';

export interface NetSettings {
  /** Tor relay entry points (tor-js gateways or WebSocket bridges) */
  relays: string[];
  /** normalized origins of local/LAN nodes the user approved for direct access */
  localNodes: string[];
  /** the browser itself routes everything over Tor (Tor Browser): use its fetch */
  browserTor?: boolean;
}

/** monero.fail's onion mirror: reachable (with CORS) only if the browser itself uses Tor */
/**
 * User-Agent of every request sent through the in-page Tor client. Left alone,
 * tor-js would send the browser's own (browser, version, OS: a fingerprint on
 * every request). This is what Cake Wallet's app itself sends (dart:io
 * HttpClient, Flutter 3.41 / Dart 3.11), so servers see the same client as for
 * Cake's own users. Some APIs (Solana's public RPC) also refuse a browser
 * User-Agent that comes without the rest of a browser's headers.
 */
export const TOR_USER_AGENT = 'Dart/3.11 (dart:io)';

export const BROWSER_TOR_PROBE = 'http://livk2fpdv4xjnjrbxfz2tw3ptogqacn2dwfzxbxr3srinryxrcewemid.onion/api/v1/nodes/?crypto=monero&network=stagenet&type=onion&per_page=1';

export interface NetRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  /** explicit circuit isolation key (requests with different keys never share a circuit) */
  isolation?: string;
  /** who is asking (a wallet id, "exchange", "prices", …): scopes never share circuits */
  scope?: string;
  timeoutMs?: number;
  /** HTTP digest auth (monerod RPC login) */
  username?: string;
  password?: string;
  signal?: AbortSignal;
  /** short label for the network activity log */
  purpose?: string;
}

export type Via = 'tor' | 'local' | 'browser-tor';

export interface NetResponse extends RawResponse {
  via: Via;
}

export interface ActivityEntry {
  at: number;
  host: string;
  kind: NodeKind;
  via: Via | 'blocked';
  method: string;
  path: string;
  scope?: string;
  purpose?: string;
  status?: number;
  ms?: number;
  bytes?: number;
  error?: string;
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, url: string) {
    super(`HTTP ${status} from ${new URL(url).host}${body ? `: ${body.slice(0, 300)}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

function randomId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function parseDigestChallenge(header: string): Record<string, string> | null {
  const m = /Digest\s+(.*)/i.exec(header);
  if (!m) return null;
  const out: Record<string, string> = {};
  for (const part of m[1].match(/(\w+)=("[^"]*"|[^,]*)/g) || []) {
    const i = part.indexOf('=');
    out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim().replace(/^"|"$/g, '');
  }
  return out;
}

export function digestAuthHeader(ch: Record<string, string>, method: string, uri: string, user: string, pass: string, nc = 1, cnonce = randomId()): string {
  const realm = ch.realm ?? '';
  const nonce = ch.nonce ?? '';
  const qop = (ch.qop ?? '').split(',').map((s) => s.trim()).includes('auth') ? 'auth' : '';
  const ha1 = md5Hex(`${user}:${realm}:${pass}`);
  const ha2 = md5Hex(`${method}:${uri}`);
  const ncHex = nc.toString(16).padStart(8, '0');
  const response = qop ? md5Hex(`${ha1}:${nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`) : md5Hex(`${ha1}:${nonce}:${ha2}`);
  let h = `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;
  if (ch.algorithm) h += `, algorithm=${ch.algorithm}`;
  if (ch.opaque) h += `, opaque="${ch.opaque}"`;
  if (qop) h += `, qop=${qop}, nc=${ncHex}, cnonce="${cnonce}"`;
  return h;
}

/** Explain why a direct request to the user's own node failed (CORS, mixed content…). */
export function explainDirectFailure(url: string, e: unknown): string {
  const pageHttps = typeof location !== 'undefined' && location.protocol === 'https:';
  const u = new URL(url);
  const hints: string[] = [];
  if (pageHttps && u.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) {
    hints.push('this page is https, so browsers block plain-http LAN addresses: enable https on the node or use its .onion address');
  }
  hints.push(`the node must allow cross-origin requests from ${typeof location !== 'undefined' ? location.origin : 'this site'}`);
  return `Could not reach your node at ${u.host} (${(e as Error).message}). Check that ${hints.join('; and ')}.`;
}

export class NetRouter {
  #settings: NetSettings;
  #tor: TorTransport | null = null;
  #torStorage: TorStorage | undefined;
  #session = randomId();
  #salts = new Map<string, string>();
  #statusListeners = new Set<(s: TorStatus) => void>();
  #unsubTor: (() => void) | null = null;
  readonly activity: ActivityEntry[] = [];
  #activityListeners = new Set<(e: ActivityEntry) => void>();
  /** set to false to refuse every request (e.g. while the app is locked) */
  online = true;

  constructor(settings: NetSettings, opts: { torStorage?: TorStorage } = {}) {
    this.#settings = { relays: [...settings.relays], localNodes: [...settings.localNodes], browserTor: !!settings.browserTor };
    this.#torStorage = opts.torStorage;
  }

  get settings(): NetSettings {
    return this.#settings;
  }

  get torStatus(): TorStatus {
    if (this.#settings.browserTor) return { state: 'ready', message: "Using this browser's own Tor connection", via: 'browser' };
    return this.#tor?.status ?? { state: 'idle', message: 'Tor not started' };
  }

  get torLogs(): string[] {
    return this.#tor?.logs ?? [];
  }

  onTorStatus(fn: (s: TorStatus) => void): () => void {
    this.#statusListeners.add(fn);
    return () => this.#statusListeners.delete(fn);
  }

  onActivity(fn: (e: ActivityEntry) => void): () => void {
    this.#activityListeners.add(fn);
    return () => this.#activityListeners.delete(fn);
  }

  #emitStatus(s: TorStatus) {
    for (const fn of this.#statusListeners) fn(s);
  }

  /** Apply new settings; restarts Tor if the relays changed. */
  configure(next: Partial<NetSettings>): void {
    const prev = this.#settings;
    this.#settings = {
      relays: [...(next.relays ?? prev.relays)],
      localNodes: [...(next.localNodes ?? prev.localNodes)],
      browserTor: next.browserTor ?? prev.browserTor,
    };
    if (prev.browserTor !== this.#settings.browserTor) this.#emitStatus(this.torStatus);
    if (prev.relays.join('\n') !== this.#settings.relays.join('\n')) {
      this.#tor?.close();
      this.#unsubTor?.();
      this.#tor = null;
      this.#session = randomId();
      this.#emitStatus(this.torStatus);
    }
  }

  /** New circuits for everything from now on (unlinkable to earlier requests). */
  newIdentity(): void {
    this.#session = randomId();
    this.#salts.clear();
  }

  async startTor(): Promise<void> {
    if (this.#settings.browserTor) return;
    await this.#torTransport().start();
  }

  static async probeBrowserTor(timeoutMs = 45_000): Promise<boolean> {
    try {
      const res = await fetch(BROWSER_TOR_PROBE, { mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: timeoutSignal(timeoutMs) });
      return res.ok && Array.isArray((await res.json())?.nodes);
    } catch {
      return false;
    }
  }

  #torTransport(): TorTransport {
    if (!this.#tor) {
      let entries;
      try {
        entries = parseRelayList(this.#settings.relays);
      } catch (e) {
        throw new PolicyError((e as Error).message);
      }
      if (!entries.length) throw new PolicyError('No Tor relay configured. Add one in Settings → Privacy → Tor.');
      const tor = new TorTransport(entries, { storage: this.#torStorage });
      this.#unsubTor = tor.onStatus((s) => this.#emitStatus(s));
      this.#tor = tor;
    }
    return this.#tor;
  }

  isolationFor(scope: string, host: string, port: number): string {
    const k = `${scope}|${host}:${port}`;
    return `${this.#session}|${k}|${this.#salts.get(k) ?? ''}`;
  }

  /** Use a brand-new circuit for further requests of this scope to this host. */
  rotateIsolation(url: string, scope = 'app'): void {
    const a = parseNodeUrl(new URL(url).origin);
    this.#salts.set(`${scope}|${a.host}:${a.port}`, randomId());
  }

  #log(e: ActivityEntry) {
    this.activity.push(e);
    if (this.activity.length > 500) this.activity.splice(0, this.activity.length - 500);
    for (const fn of this.#activityListeners) fn(e);
  }

  /** How a URL would be reached, or throws PolicyError if it may not be. */
  route(url: string): { kind: NodeKind; via: Via } {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new PolicyError(`Unsupported protocol ${u.protocol}`);
    const addr = parseNodeUrl(u.origin);
    switch (addr.kind) {
      case 'onion':
      case 'clearnet':
        return { kind: addr.kind, via: this.#settings.browserTor ? 'browser-tor' : 'tor' };
      case 'local':
      case 'lan':
        if (!this.#settings.localNodes.includes(addr.url)) {
          throw new PolicyError(`${addr.host} is a ${addr.kind === 'local' ? 'local' : 'LAN'} address. Add it as your own node to allow a direct connection (Tor cannot reach private networks).`);
        }
        return { kind: addr.kind, via: 'local' };
      case 'i2p':
        throw new PolicyError('I2P addresses are not supported; use a .onion address instead');
    }
  }

  async request(req: NetRequest): Promise<NetResponse> {
    const u = new URL(req.url);
    const method = (req.method ?? (req.body !== undefined ? 'POST' : 'GET')).toUpperCase();
    let addr;
    try {
      addr = parseNodeUrl(u.origin);
    } catch (e) {
      throw new PolicyError((e as Error).message);
    }
    const started = Date.now();
    const base: ActivityEntry = { at: started, host: addr.host, kind: addr.kind, via: 'blocked', method, path: u.pathname, scope: req.scope, purpose: req.purpose };
    if (!this.online) {
      this.#log({ ...base, error: 'offline (app locked)' });
      throw new PolicyError('The app is locked');
    }
    let route: { kind: NodeKind; via: Via };
    try {
      route = this.route(u.href);
    } catch (e) {
      this.#log({ ...base, error: (e as Error).message });
      throw e;
    }
    base.via = route.via;
    try {
      let res = await this.#send(route.via, { ...req, method }, addr.host, addr.port);
      if (res.status === 401 && req.username) {
        const ch = parseDigestChallenge(res.headers['www-authenticate'] || '');
        if (ch) {
          const auth = digestAuthHeader(ch, method, u.pathname + u.search, req.username, req.password ?? '');
          res = await this.#send(route.via, { ...req, method, headers: { ...req.headers, Authorization: auth } }, addr.host, addr.port);
        }
      }
      this.#log({ ...base, status: res.status, ms: Date.now() - started, bytes: res.body.length });
      return { ...res, via: route.via };
    } catch (e) {
      this.#log({ ...base, ms: Date.now() - started, error: (e as Error).message });
      throw e;
    }
  }

  async #send(via: Via, req: NetRequest & { method: string }, host: string, port: number): Promise<RawResponse> {
    const headers: Record<string, string> = { ...req.headers };
    if (req.body !== undefined && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    const scope = req.scope ?? 'app';
    const isolation = req.isolation ?? this.isolationFor(scope, host, port);
    const timeoutMs = req.timeoutMs ?? 120_000;
    if (via === 'local') return this.#direct(req, headers, timeoutMs);
    if (via === 'browser-tor') return this.#direct(req, headers, timeoutMs, true);
    const tor = this.#torTransport();
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'user-agent')) headers['User-Agent'] = TOR_USER_AGENT;
    const opts = { method: req.method, headers, body: req.body, timeoutMs, signal: req.signal };
    try {
      return await tor.fetch(req.url, { ...opts, isolationKey: isolation });
    } catch (e) {
      // A stream that failed to open (exit refused, unreachable onion intro
      // point, …) or stalled keeps failing on the same circuit: retry once on
      // a new one.
      if (!(e instanceof TorConnectError) || (e.timedOut && !e.stalled) || req.signal?.aborted) throw e;
      if (!req.isolation) this.#salts.set(`${scope}|${host}:${port}`, randomId());
      const retryKey = req.isolation ? `${req.isolation}|retry|${randomId()}` : this.isolationFor(scope, host, port);
      return tor.fetch(req.url, { ...opts, isolationKey: retryKey });
    }
  }

  async #direct(req: NetRequest & { method: string }, headers: Record<string, string>, timeoutMs: number, overBrowserTor = false): Promise<RawResponse> {
    const addr = parseNodeUrl(new URL(req.url).origin);
    if (overBrowserTor && (addr.kind === 'local' || addr.kind === 'lan')) throw new PolicyError('internal: private address on the Tor path');
    const init: RequestInit & { targetAddressSpace?: string } = {
      method: req.method,
      headers,
      body: typeof req.body === 'string' ? req.body : req.body ? new Uint8Array(req.body) : undefined,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: anySignal([req.signal, timeoutSignal(timeoutMs)]),
    };
    if (!overBrowserTor) init.targetAddressSpace = addr.kind === 'local' ? 'loopback' : 'local';
    let res: Response;
    try {
      res = await fetch(req.url, init);
    } catch (e) {
      if (req.signal?.aborted) throw e;
      if (overBrowserTor) throw new Error(`Request through the browser's Tor failed: ${(e as Error).message} (the server must allow cross-origin requests)`);
      throw new Error(explainDirectFailure(req.url, e));
    }
    const out: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      out[k] = v;
    });
    return { status: res.status, statusText: res.statusText, headers: out, body: new Uint8Array(await res.arrayBuffer()) };
  }

  close(): void {
    this.#tor?.close();
    this.#tor = null;
  }
}
