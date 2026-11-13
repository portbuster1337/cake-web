// JSON-RPC to Nano nodes over Tor. Public nodes such as rpc.nano.to ban an IP
// for minutes when it sends too many requests per second ({"error":429,…}
// with HTTP 200), and a Tor exit is shared with many users: requests are
// paced (at most two at a time, 300 ms apart) and a rate-limited one is sent
// again on a new circuit after a pause.

import { HttpError } from '../../net/router.ts';
import { postJson, router } from '../../net/http.ts';

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export function isRateLimited(r: unknown): boolean {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
  const o = r as { error?: unknown; message?: unknown };
  if (o.error === undefined) return false;
  return String(o.error) === '429' || /too many requests|rate limit|banned/i.test(`${String(o.error)} ${String(o.message ?? '')}`);
}

export class NanoRpc {
  #active = 0;
  #waiting: (() => void)[] = [];
  #lastStart = 0;

  constructor(
    readonly scope: string,
    readonly headers: (url: string) => Record<string, string> = () => ({ 'nano-app': 'cake-wallet' }),
    readonly maxInFlight = 2,
    readonly spacingMs = 300,
  ) {}

  async #slot(): Promise<void> {
    while (this.#active >= this.maxInFlight) await new Promise<void>((ok) => this.#waiting.push(ok));
    this.#active++;
    const now = Date.now();
    const at = Math.max(now, this.#lastStart + this.spacingMs);
    this.#lastStart = at;
    if (at > now) await sleep(at - now);
  }

  #release(): void {
    this.#active--;
    this.#waiting.shift()?.();
  }

  async call<T = any>(url: string, body: Record<string, unknown>, purpose: string, timeoutMs = 45_000): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.#slot();
      let r: any;
      let limited = false;
      try {
        r = await postJson<any>(url, body, { scope: this.scope, timeoutMs, retries: 2, purpose, headers: this.headers(url) });
        limited = isRateLimited(r);
      } catch (e) {
        if (!(e instanceof HttpError && e.status === 429) || attempt >= 4) throw e;
        limited = true;
      } finally {
        this.#release();
      }
      if (!limited || attempt >= 4) return r as T;
      router().rotateIsolation(url, this.scope);
      await sleep(1000 * 2 ** attempt);
    }
  }
}
