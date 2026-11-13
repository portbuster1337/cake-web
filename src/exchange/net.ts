// HTTP for the swap providers, through the Tor router like every other request.
// Answers of any status are returned (providers read their own error bodies);
// Tor failures are retried on a new circuit, except for requests that create
// something (a retried order could be placed twice).

import { request, text } from '../net/http.ts';

const ANY_STATUS = Array.from({ length: 500 }, (_, i) => i + 100);

export interface ExResponse {
  status: number;
  text: string;
  json<T = any>(): T;
}

export interface ExOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** extra attempts after a Tor failure (default 1; 0 for requests that create orders) */
  retries?: number;
  purpose?: string;
}

/** quotes and limits: Cake waits 7 s on clearnet; a Tor circuit to a new host alone can take that long */
export const QUOTE_TIMEOUT_MS = 25_000;

export async function exFetch(url: string, o: ExOptions = {}): Promise<ExResponse> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  let body: string | undefined;
  if (o.body !== undefined) {
    body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  }
  const res = await request(url, body, { scope: 'exchange', method: o.method ?? (body !== undefined ? 'POST' : 'GET'), headers, timeoutMs: o.timeoutMs ?? 60_000, retries: o.retries ?? 1, purpose: o.purpose ?? 'swap', okStatuses: ANY_STATUS });
  const t = text(res);
  return {
    status: res.status,
    text: t,
    json<T>() {
      return JSON.parse(t) as T;
    },
  };
}

/** a JSON body, or null when the answer is not JSON */
export function tryJson<T = any>(r: ExResponse): T | null {
  try {
    return r.json<T>();
  } catch {
    return null;
  }
}

export { dartDouble, toBaseUnits, fromBaseUnits, plainNumber } from './amounts.ts';
