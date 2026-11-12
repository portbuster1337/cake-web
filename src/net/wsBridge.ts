// A tor-js socket provider that reaches Tor relays through a WebSocket bridge
// ("Tor relay" in the UI). Browsers cannot open raw TCP sockets, so the
// in-browser Tor client tunnels each relay connection through the bridge.
// The bridge only ever sees TLS-encrypted Tor link traffic: it cannot read or
// alter what goes through the circuit, nor learn which node is contacted.

import { ArtiSocket } from 'tor-js/wasm-file';

const CONNECT_TIMEOUT_MS = 20_000;
const HIGH_WATER = 1 << 20;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export function bridgeTargetUrl(bridgeUrl: string, target: string): string {
  const u = new URL(bridgeUrl);
  u.searchParams.set('target', target);
  return u.toString();
}

export class WsBridgeSocketProvider {
  readonly url: string;
  #sockets = new Set<WebSocket>();
  #closed = false;
  onActivity: ((event: 'open' | 'close' | 'error', target: string, detail?: string) => void) | null = null;

  constructor(url: string) {
    const u = new URL(url);
    if (u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error('Tor relay URL must start with ws:// or wss://');
    this.url = u.toString();
  }

  /** tor-js uses this for "fast bootstrap"; a plain bridge has none, so Arti bootstraps over Tor itself. */
  get gateway(): null {
    return null;
  }

  async gatewayFetch(): Promise<never> {
    throw new Error('fast bootstrap is not available through a WebSocket bridge');
  }

  close(): void {
    this.#closed = true;
    for (const ws of this.#sockets) ws.close();
    this.#sockets.clear();
  }

  connect(target: string): Promise<ArtiSocket> {
    if (this.#closed) return Promise.reject(new Error('bridge provider closed'));
    return new Promise<ArtiSocket>((resolve, reject) => {
      const ws = new WebSocket(bridgeTargetUrl(this.url, target));
      ws.binaryType = 'arraybuffer';
      this.#sockets.add(ws);
      let opened = false;
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      let resolveClosed!: (info: { ok: boolean; reason?: string }) => void;
      const closed = new Promise<{ ok: boolean; reason?: string }>((r) => (resolveClosed = r));
      const readable = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
        cancel() {
          ws.close();
        },
      });
      const writable = new WritableStream<Uint8Array>({
        async write(chunk) {
          if (ws.readyState !== WebSocket.OPEN) throw new Error('relay connection closed');
          ws.send(chunk);
          while (ws.bufferedAmount > HIGH_WATER && ws.readyState === WebSocket.OPEN) await sleep(5);
        },
        close() {
          if (ws.readyState === WebSocket.OPEN) ws.send('FIN');
        },
        abort() {
          ws.close();
        },
      });
      const timer = setTimeout(() => {
        if (!opened) {
          ws.close();
          reject(new Error(`Tor relay bridge: timed out connecting to ${target}`));
        }
      }, CONNECT_TIMEOUT_MS);

      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          if (!opened) {
            clearTimeout(timer);
            if (ev.data === 'OK') {
              opened = true;
              this.onActivity?.('open', target);
              resolve(new ArtiSocket({
                readable,
                writable,
                closed,
                closeWrite: async () => {
                  if (ws.readyState === WebSocket.OPEN) ws.send('FIN');
                },
                close: () => ws.close(),
              }));
            } else {
              reject(new Error(`Tor relay bridge: ${ev.data.replace(/^ERR\s*/, '')} (${target})`));
              ws.close();
            }
          } else if (ev.data === 'FIN') {
            try {
              controller.close();
            } catch { /* already closed */ }
          }
          return;
        }
        if (opened) controller.enqueue(new Uint8Array(ev.data as ArrayBuffer));
      };
      ws.onerror = () => {
        this.onActivity?.('error', target);
      };
      ws.onclose = (ev) => {
        clearTimeout(timer);
        this.#sockets.delete(ws);
        if (!opened) {
          reject(new Error(`Tor relay bridge refused or unreachable (${ev.code}) for ${target}`));
        } else {
          this.onActivity?.('close', target);
          try {
            if (ev.code === 1000 || ev.code === 1005) controller.close();
            else controller.error(new Error(`relay connection lost (${ev.code})`));
          } catch { /* already closed */ }
        }
        resolveClosed({ ok: ev.code === 1000 || ev.code === 1005, reason: ev.reason || undefined });
      };
    });
  }
}
