// Convenience helpers on top of the router: JSON over HTTP(S), JSON-RPC,
// retries on a fresh Tor circuit. Every call goes through the router (Tor).

import { NetRouter, HttpError, PolicyError, type NetRequest, type NetResponse } from './router.ts';
import { ResponseTooLargeError, TorConnectError } from './tor.ts';

let current: NetRouter | null = null;

export function setRouter(r: NetRouter): void {
  current = r;
}

export function router(): NetRouter {
  if (!current) throw new Error('Network not initialised');
  return current;
}

export interface HttpOptions extends Omit<NetRequest, 'url' | 'body'> {
  /** extra attempts on Tor/5xx failures, each on a new circuit (default 2) */
  retries?: number;
  /** accept these non-2xx statuses instead of throwing */
  okStatuses?: number[];
  /** follow up to this many redirects, to https URLs only (default 0: a redirect is an answer like any other) */
  followRedirects?: number;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const dec = new TextDecoder();

export function text(res: NetResponse): string {
  return dec.decode(res.body);
}

function retryable(e: unknown): boolean {
  if (e instanceof PolicyError || e instanceof ResponseTooLargeError) return false;
  if (e instanceof HttpError) return e.status >= 500 || e.status === 429;
  if (e instanceof TorConnectError) return true;
  const msg = (e as Error)?.message ?? '';
  return /tor|circuit|stream|timed out|connection|reset|EOF|TLS/i.test(msg);
}

export async function request(url: string, body: Uint8Array | string | undefined, opts: HttpOptions = {}): Promise<NetResponse> {
  const r = router();
  const attempts = 1 + (opts.retries ?? 2);
  let last: unknown;
  let redirect: { status: number; location: string } | null = null;
  for (let i = 0; i < attempts; i++) {
    if (opts.signal?.aborted) throw new Error('Request cancelled');
    try {
      const res = await r.request({ ...opts, url, body });
      const location = res.headers.location;
      if ((opts.followRedirects ?? 0) > 0 && REDIRECTS.has(res.status) && location) {
        redirect = { status: res.status, location };
        break;
      }
      if ((res.status < 200 || res.status >= 300) && !opts.okStatuses?.includes(res.status)) {
        throw new HttpError(res.status, text(res), url);
      }
      return res;
    } catch (e) {
      last = e;
      if (i + 1 >= attempts || !retryable(e)) throw e;
      r.rotateIsolation(url, opts.scope ?? 'app');
      const limited = e instanceof HttpError && e.status === 429;
      await new Promise((ok) => setTimeout(ok, limited ? Math.min(8_000, 1_500 * 2 ** i) : 400 * (i + 1)));
    }
  }
  if (redirect) {
    const next = new URL(redirect.location, url);
    if (next.protocol !== 'https:') throw new PolicyError(`redirect to a non-https address (${next.protocol})`);
    // 301/302/303 go on as a GET without the body; 307/308 repeat the request
    const keep = redirect.status === 307 || redirect.status === 308;
    return request(next.href, keep ? body : undefined, { ...opts, method: keep ? opts.method : 'GET', followRedirects: opts.followRedirects! - 1 });
  }
  throw last;
}

/**
 * request() + JSON. A 2xx answer that is not valid JSON is most often one whose
 * Tor stream ended early (a cut-off body): it is asked once more, on a new circuit.
 */
async function requestJson<T>(url: string, body: Uint8Array | string | undefined, opts: HttpOptions): Promise<T> {
  const attempts = (opts.retries ?? 2) > 0 ? 2 : 1;
  for (let i = 0; ; i++) {
    const res = await request(url, body, opts);
    try {
      return parseJson<T>(res, url);
    } catch (e) {
      if (i + 1 >= attempts || opts.signal?.aborted) throw e;
      router().rotateIsolation(url, opts.scope ?? 'app');
    }
  }
}

export async function getJson<T = any>(url: string, opts: HttpOptions = {}): Promise<T> {
  return requestJson<T>(url, undefined, { ...opts, method: opts.method ?? 'GET', headers: { Accept: 'application/json', ...opts.headers } });
}

export async function getText(url: string, opts: HttpOptions = {}): Promise<string> {
  const res = await request(url, undefined, { ...opts, method: opts.method ?? 'GET' });
  return text(res);
}

export async function postJson<T = any>(url: string, payload: unknown, opts: HttpOptions = {}): Promise<T> {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return requestJson<T>(url, body, { ...opts, method: opts.method ?? 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...opts.headers } });
}

export function parseJson<T>(res: NetResponse, url: string): T {
  const t = text(res);
  try {
    return (t ? JSON.parse(t) : null) as T;
  } catch {
    throw new Error(`Invalid JSON from ${new URL(url).host}: ${t.slice(0, 200)}`);
  }
}

export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.data = data;
  }
}

let rpcId = 0;

export async function jsonRpc<T = any>(url: string, method: string, params: unknown = [], opts: HttpOptions = {}): Promise<T> {
  const r = await postJson<any>(url, { jsonrpc: '2.0', id: ++rpcId, method, params }, { okStatuses: [400, 500], ...opts });
  if (r?.error) throw new RpcError(r.error.message ?? JSON.stringify(r.error), r.error.code ?? -1, r.error.data);
  if (r === null || typeof r !== 'object' || !('result' in r)) throw new Error(`Bad JSON-RPC response from ${new URL(url).host}`);
  return r.result as T;
}

/** Several JSON-RPC calls in one HTTP request (one Tor round trip). */
export async function jsonRpcBatch<T = any>(url: string, calls: { method: string; params: unknown }[], opts: HttpOptions = {}): Promise<(T | RpcError)[]> {
  if (!calls.length) return [];
  const base = rpcId;
  rpcId += calls.length;
  const payload = calls.map((c, i) => ({ jsonrpc: '2.0', id: base + i + 1, method: c.method, params: c.params }));
  const r = await postJson<any[]>(url, payload, opts);
  if (!Array.isArray(r)) throw new Error(`Bad JSON-RPC batch response from ${new URL(url).host}`);
  const byId = new Map(r.map((x) => [x.id, x]));
  return payload.map((p) => {
    const x = byId.get(p.id);
    if (!x) return new RpcError('missing response', -1);
    if (x.error) return new RpcError(x.error.message ?? 'error', x.error.code ?? -1, x.error.data);
    return x.result as T;
  });
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}
