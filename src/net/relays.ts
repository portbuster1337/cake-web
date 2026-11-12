// Tor relays: how the in-page Tor client reaches the Tor network.
//
// Browsers can't open TCP sockets, so Arti's connections to Tor relays are
// tunneled through a relay entry point that browsers can talk to:
//   * a tor-js gateway, "ip:port:certhash" (WebRTC; public ones exist), or
//   * a WebSocket bridge, "wss://host/tor" (e.g. server/index.mjs --public).
// Both only ever see TLS-encrypted Tor link traffic. Nothing has to be
// installed on the user's machine.

import { ArtiSocketProvider } from 'tor-js/wasm-file';
import type { ArtiSocket, GatewayResponse, Log } from 'tor-js/wasm-file';
import { WsBridgeSocketProvider } from './wsBridge.ts';

export type RelayEntry =
  | { kind: 'bridge'; url: string }
  | { kind: 'gateway'; address: string }
  | { kind: 'direct' }; // Node.js only (tests): Arti dials relays itself

export function parseRelay(input: string): RelayEntry {
  const r = input.trim();
  if (r === 'direct') return { kind: 'direct' };
  if (/^wss?:\/\//i.test(r)) {
    const u = new URL(r);
    return { kind: 'bridge', url: u.toString() };
  }
  if (/^(\[[0-9a-fA-F:]+\]|\d{1,3}(\.\d{1,3}){3}):\d{1,5}:u[A-Za-z0-9_-]{20,}$/.test(r)) return { kind: 'gateway', address: r };
  throw new Error(`Not a Tor relay: "${r}". Use a tor-js gateway (ip:port:certhash) or a WebSocket bridge (wss://…).`);
}

/** Parse a list (array or one entry per line); comments (#) and blanks are ignored. */
export function parseRelayList(input: string | string[]): RelayEntry[] {
  const lines = Array.isArray(input) ? input : input.split('\n');
  const out: RelayEntry[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const s = line.replace(/#.*$/, '').trim();
    if (!s) continue;
    const e = parseRelay(s);
    const key = relayLabel(e);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

export function relayLabel(e: RelayEntry): string {
  if (e.kind === 'bridge') return e.url;
  if (e.kind === 'gateway') return e.address;
  return 'direct';
}

/** Short human label, e.g. "gateway 152.236.3.22" or "bridge example.com". */
export function relayShort(e: RelayEntry): string {
  if (e.kind === 'bridge') return `bridge ${new URL(e.url).host}`;
  if (e.kind === 'gateway') return `gateway ${e.address.slice(0, e.address.lastIndexOf(':', e.address.lastIndexOf(':') - 1))}`;
  return 'direct';
}

export interface RelayMember {
  label: string;
  short: string;
  connect: (target: string) => Promise<ArtiSocket>;
  close: () => void;
}

/**
 * A socket provider over several relays. Like Tor's entry guards, it sticks
 * to the relay that works and only falls back when it fails. Every relay is
 * tried for the SAME target, so a hostile relay can't steer which Tor relay
 * (guard) we connect to by refusing some of them.
 */
export class RelayPool {
  readonly entries: RelayEntry[];
  #members: RelayMember[] = [];
  #kps: ArtiSocketProvider | null = null;
  #sticky = 0;
  current: string | null = null;
  onChange: ((short: string) => void) | null = null;

  constructor(entries: RelayEntry[], opts: { log?: Log; preferred?: string; members?: RelayMember[] } = {}) {
    if (!entries.length && !opts.members?.length) throw new Error('No Tor relay configured');
    this.entries = entries;
    if (opts.members) this.#members = opts.members; // tests
    const gateways = entries.filter((e): e is { kind: 'gateway'; address: string } => e.kind === 'gateway').map((e) => e.address);
    for (const e of opts.members ? [] : entries) {
      if (e.kind === 'bridge') {
        const p = new WsBridgeSocketProvider(e.url);
        this.#members.push({ label: e.url, short: relayShort(e), connect: (t) => p.connect(t), close: () => p.close() });
      } else if (e.kind === 'gateway') {
        // all gateways share one tor-js provider (it fails over between them)
        if (!this.#kps) {
          const kps = new ArtiSocketProvider({ gateway: gateways, log: opts.log });
          this.#kps = kps;
          this.#members.push({
            label: gateways.join(' '),
            short: gateways.length > 1 ? `${gateways.length} gateways` : relayShort(e),
            connect: (t) => kps.connect(t),
            close: () => kps.close(),
          });
        }
      }
    }
    const pref = opts.preferred ? this.#members.findIndex((m) => m.label === opts.preferred) : -1;
    if (pref >= 0) this.#sticky = pref;
  }

  /** Lets tor-js fetch a directory snapshot from a gateway (fast bootstrap). */
  get gateway(): unknown {
    return this.#kps?.gateway ?? null;
  }

  gatewayFetch(path: string): Promise<GatewayResponse> {
    if (!this.#kps) return Promise.reject(new Error('no gateway for fast bootstrap'));
    return this.#kps.gatewayFetch(path);
  }

  async connect(target: string): Promise<ArtiSocket> {
    const order = [this.#sticky, ...this.#members.map((_, i) => i).filter((i) => i !== this.#sticky)];
    const errors: string[] = [];
    for (const i of order) {
      const m = this.#members[i];
      try {
        const sock = await m.connect(target);
        if (this.#sticky !== i || this.current !== m.label) {
          this.#sticky = i;
          this.current = m.label;
          this.onChange?.(m.short);
        }
        return sock;
      } catch (e) {
        errors.push(`${m.short}: ${(e as Error).message}`);
      }
    }
    throw new Error(`no Tor relay reachable for ${target} (${errors.join('; ')})`);
  }

  close(): void {
    for (const m of this.#members) m.close();
  }
}
