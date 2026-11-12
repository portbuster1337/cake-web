// Keeps an allowlist of Tor relay OR addresses so the WebSocket bridge can
// only ever be used to reach Tor relays (never as a generic TCP proxy).

import net from 'node:net';

const ONIONOO_URL = 'https://onionoo.torproject.org/details?type=relay&running=true&fields=or_addresses';

// Directory authorities (DirPort) used as a fallback source for the consensus.
const DIRAUTHS = [
  '128.31.0.39:9231',
  '217.196.147.77:80',
  '45.66.33.45:80',
  '131.188.40.189:80',
  '193.23.244.244:80',
  '171.25.193.9:443',
  '199.58.81.140:80',
  '204.13.164.118:80',
];

const REFRESH_MS = 30 * 60 * 1000;

export function normalizeHostPort(target) {
  const m = /^\[([0-9a-fA-F:.]+)\]:(\d{1,5})$/.exec(target) || /^([0-9.]+):(\d{1,5})$/.exec(target);
  if (!m) return null;
  const host = m[1].toLowerCase();
  const port = Number(m[2]);
  if (!net.isIP(host) || port < 1 || port > 65535) return null;
  return { host, port, key: `${host}:${port}` };
}

/** True for addresses that must never be reachable through the bridge. */
export function isNonPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19));
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isNonPublicIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') ||
    v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb') ||
    v.startsWith('ff');
}

function parseOnionoo(json) {
  const out = new Set();
  for (const relay of json.relays || []) {
    for (const addr of relay.or_addresses || []) {
      const hp = normalizeHostPort(addr);
      if (hp) out.add(hp.key);
    }
  }
  return out;
}

function parseConsensus(text) {
  const out = new Set();
  for (const line of text.split('\n')) {
    if (line.startsWith('r ')) {
      // r <nick> <identity> <published-date> <published-time> <ip> <orport> <dirport>   (microdesc flavor)
      const parts = line.split(' ');
      const ip = parts[parts.length - 3];
      const port = parts[parts.length - 2];
      const hp = normalizeHostPort(`${ip}:${port}`);
      if (hp) out.add(hp.key);
    } else if (line.startsWith('a ')) {
      const hp = normalizeHostPort(line.slice(2).trim());
      if (hp) out.add(hp.key);
    }
  }
  return out;
}

export class RelayAllowlist {
  constructor({ log = console, disabled = false } = {}) {
    this.log = log;
    this.disabled = disabled;
    this.addrs = new Set();
    this.ips = new Set();
    this.updatedAt = 0;
    this.source = 'none';
    this.timer = null;
  }

  async start() {
    if (this.disabled) return;
    await this.refresh();
    this.timer = setInterval(() => this.refresh().catch(() => {}), REFRESH_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh() {
    let set = null;
    try {
      const res = await fetch(ONIONOO_URL, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      set = parseOnionoo(await res.json());
      if (set.size < 1000) throw new Error(`only ${set.size} relays`);
      this.source = 'onionoo';
    } catch (e) {
      this.log.warn(`[relays] onionoo failed (${e.message}); trying directory authorities`);
      for (const auth of DIRAUTHS.sort(() => Math.random() - 0.5)) {
        try {
          const res = await fetch(`http://${auth}/tor/status-vote/current/consensus-microdesc`, { signal: AbortSignal.timeout(30_000) });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          set = parseConsensus(await res.text());
          if (set.size < 1000) throw new Error(`only ${set.size} relays`);
          this.source = `dirauth ${auth}`;
          break;
        } catch (e2) {
          this.log.warn(`[relays] ${auth} failed: ${e2.message}`);
          set = null;
        }
      }
    }
    if (set) {
      this.addrs = set;
      this.ips = new Set([...set].map((k) => k.slice(0, k.lastIndexOf(':'))));
      this.updatedAt = Date.now();
      this.log.info(`[relays] allowlist: ${set.size} relay addresses (${this.source})`);
    }
  }

  get ready() {
    return this.disabled || this.addrs.size > 0;
  }

  /** Returns null if the target may be dialed, or a reason string if not. */
  check(target) {
    const hp = normalizeHostPort(target);
    if (!hp) return 'target must be ip:port';
    if (isNonPublicIp(hp.host)) return 'target is not a public address';
    if (this.disabled) return null;
    if (!this.addrs.size) return 'relay list not loaded yet';
    if (this.addrs.has(hp.key)) return null;
    // Relays occasionally change ORPort between snapshots; accept a known relay
    // IP on typical ORPort values only (never low service ports such as 22/25).
    if (this.ips.has(hp.host) && (hp.port === 80 || hp.port === 443 || hp.port >= 1024)) return null;
    return 'target is not a known Tor relay';
  }
}
