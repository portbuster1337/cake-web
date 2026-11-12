// Classifies node URLs so the network policy can decide how (and whether)
// a request may leave the browser.

export type NodeKind = 'onion' | 'i2p' | 'clearnet' | 'local' | 'lan';

export interface NodeAddress {
  url: string;          // normalized origin, e.g. "http://abc.onion:18089"
  scheme: 'http' | 'https';
  host: string;         // lowercase, IPv6 without brackets
  port: number;
  kind: NodeKind;
}

const DEFAULT_PORTS: Record<string, number> = { http: 80, https: 443 };

function ipv4Parts(h: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : null;
}

export function isLoopback(host: string): boolean {
  const p = ipv4Parts(host);
  if (p) return p[0] === 127;
  const h = host.toLowerCase();
  return h === '::1' || h === 'localhost' || h.endsWith('.localhost');
}

/** RFC1918 / link-local / ULA / CGNAT / mDNS & home-network names. */
export function isPrivateNetwork(host: string): boolean {
  const p = ipv4Parts(host);
  if (p) {
    const [a, b] = p;
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  const h = host.toLowerCase();
  if (h.includes(':')) {
    return h.startsWith('fc') || h.startsWith('fd') || /^fe[89ab]/.test(h);
  }
  return h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa') ||
    h.endsWith('.internal') || h.endsWith('.home') || !h.includes('.');
}

export function classifyHost(host: string): NodeKind {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (h.endsWith('.onion')) return 'onion';
  if (h.endsWith('.i2p')) return 'i2p';
  if (isLoopback(h)) return 'local';
  if (isPrivateNetwork(h)) return 'lan';
  return 'clearnet';
}

/** v3 onion addresses are 56 base32 chars + ".onion". */
export function isValidOnion(host: string): boolean {
  return /^([a-z0-9-]+\.)*[a-z2-7]{56}\.onion$/.test(host.toLowerCase());
}

/**
 * Parse user input or a list entry into a normalized node address.
 * Accepts "host:port", "http://host:port", "https://host" etc.
 */
export function parseNodeUrl(input: string, defaultPort = 18081): NodeAddress {
  const s = input.trim();
  if (!s) throw new Error('Empty node address');
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  const withScheme = hasScheme ? s : `http://${s}`;
  let u: URL;
  try {
    u = new URL(withScheme);
  } catch {
    throw new Error(`Invalid node address: ${input}`);
  }
  const scheme = u.protocol.replace(':', '');
  if (scheme !== 'http' && scheme !== 'https') throw new Error('Node address must use http or https');
  if (u.username || u.password) throw new Error('Put node credentials in the login fields, not the URL');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new Error(`Invalid node address: ${input}`);
  // URL() hides default ports, so read an explicit port from the authority.
  const authority = withScheme.slice(withScheme.indexOf('//') + 2).split(/[/?#]/)[0];
  const afterHost = authority.startsWith('[')
    ? authority.slice(authority.indexOf(']') + 1)
    : authority.slice(authority.includes(':') ? authority.indexOf(':') : authority.length);
  const explicit = /^:(\d{1,5})$/.exec(afterHost);
  const port = explicit ? Number(explicit[1]) : hasScheme ? DEFAULT_PORTS[scheme] : defaultPort;
  if (port < 1 || port > 65535) throw new Error(`Invalid port in ${input}`);
  const kind = classifyHost(host);
  if (kind === 'onion' && !isValidOnion(host)) throw new Error('Not a valid v3 .onion address');
  const hostPart = host.includes(':') ? `[${host}]` : host;
  const url = `${scheme}://${hostPart}${port === DEFAULT_PORTS[scheme] ? '' : `:${port}`}`;
  return { url, scheme: scheme as 'http' | 'https', host, port, kind };
}

export function shortHost(addr: NodeAddress | string): string {
  const a = typeof addr === 'string' ? parseNodeUrl(addr) : addr;
  if (a.kind === 'onion') {
    const name = a.host.slice(0, a.host.length - '.onion'.length);
    return `${name.slice(0, 10)}…${name.slice(-6)}.onion:${a.port}`;
  }
  return `${a.host.includes(':') ? `[${a.host}]` : a.host}:${a.port}`;
}
