// Address resolution for the send/contact/swap address fields
// (lib/core/address_resolver/*): the providers in Cake's order, each behind
// its Domain Lookups toggle. Every lookup goes through Tor.

import { keccak_256 } from '@noble/hashes/sha3.js';
import { bech32 } from '@scure/base';
import { getJson, getText, postJson, request, text } from '../net/http.ts';
import { settings } from './settings.ts';
import type { WalletBase } from '../core/wallet.ts';
import { isValidAddressFor } from '../core/addressValidator.ts';
import type { Currency } from '../coins/types.ts';

export interface ResolvedAddress {
  address: string;
  name: string;
  source: string;
  icon: string;
  description?: string;
  profileName?: string;
  profileImage?: string;
}

const H = { scope: 'lookups', purpose: 'address lookup', retries: 1, timeoutMs: 45_000 };

const RELIABLE = new Set(['xmr', 'btc', 'ltc', 'bch', 'trx', 'nano', 'sol', 'zano', 'ada', 'xrp', 'xhv', 'zaddr', 'zec', 'dcr', 'rvn', 'near', 'rune', 'scrt', 'stx', 'kmd', 'doge', 'btcln']);

/** DNS TXT over Google DoH (Cake's DnsUtils.lookupRecord with dnssec) */
export async function dnsTxt(name: string): Promise<{ records: string[]; authenticated: boolean }> {
  const r = await getJson<any>(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=16&do=1`, { ...H, headers: { Accept: 'application/dns-json' } });
  const records = (r?.Answer ?? []).filter((a: any) => a.type === 16).map((a: any) => String(a.data).replace(/^"|"$/g, '').replace(/"\s*"/g, ''));
  return { records, authenticated: !!r?.AD };
}

function lnurlEncode(url: string): string {
  const words = bech32.toWords(new TextEncoder().encode(url));
  return bech32.encode('lnurl', words, 2000).toUpperCase();
}

// ------------------------------------------------------------- providers --

async function lnurlPay(q: string): Promise<string | null> {
  const parts = q.split('@');
  const name = (parts.length === 3 ? parts[1] : parts[0]).toLowerCase() || '_';
  const domain = parts[parts.length - 1];
  const url = `https://${domain}/.well-known/lnurlp/${name}`;
  const res = await request(url, undefined, { ...H, headers: { Accept: 'application/json' }, okStatuses: [404] });
  return res.status === 200 ? lnurlEncode(url) : null;
}

async function mastodon(q: string, cur: Currency): Promise<Partial<ResolvedAddress> | null> {
  const [, user, host] = q.split('@');
  const acc = await getJson<any>(`https://${host}/api/v1/accounts/lookup?acct=${encodeURIComponent(user)}`, H);
  const statuses = await getJson<any[]>(`https://${host}/api/v1/accounts/${acc.id}/statuses?pinned=true`, H).catch(() => []);
  const addr = extractAddress(stripHtml(acc.note ?? ''), cur) ?? extractAddress(stripHtml(statuses.map((s) => s.content).join('\n')), cur);
  return addr ? { address: addr, profileName: acc.username, profileImage: acc.avatar } : null;
}

async function yat(q: string, cur: Currency): Promise<string | null> {
  const tags: Record<string, string> = { xmr: '0x1001,0x1002', btc: '0x1003', ltc: '0x1019' };
  if (!tags[cur.key]) return null;
  const r = await getJson<any>(`https://a.y.at/emoji_id/${encodeURIComponent(q.replace(/\s/g, ''))}/payment?tags=${tags[cur.key]}`, H);
  const res = r?.result;
  const recs: { tag: string; address: string }[] = Array.isArray(res) ? res : Object.entries(res ?? {}).map(([tag, v]: any) => ({ tag, address: v.address }));
  return (recs.find((x) => x.tag === '0x1002') ?? recs[0])?.address ?? null;
}

const UD_TLDS = ['crypto', 'nft', 'blockchain', 'bitcoin', 'coin', 'wallet', 'x', '888', 'dao', 'zil', 'polygon', 'unstoppable', 'pudgy', 'go', 'austin', 'raiin', 'tball', 'farms', 'dream', 'klever', 'hi', 'kresus', 'anime', 'manga', 'binanceus', 'altimist', 'clay', 'witg', 'pog', 'secret', 'ubu', 'stepn', 'smobler', 'kryptic', 'lfg', 'bitget', 'tea', 'com', 'ca', 'pw', 'co', 'io', 'org', 'eth'];

async function unstoppable(q: string, cur: Currency): Promise<string | null> {
  const r = await getJson<any>(`https://api.unstoppabledomains.com/profile/public/${encodeURIComponent(q)}?fields=records`, H);
  return r?.records?.[`crypto.${cur.title}.address`] ?? null;
}

async function openAlias(q: string, cur: Currency): Promise<Partial<ResolvedAddress> | null> {
  const name = q.replace('@', '.');
  const { records } = await dnsTxt(name);
  const rec = records.find((r) => r.toLowerCase().includes(`oa1:${cur.title.toLowerCase()}`));
  if (!rec) return null;
  const addr = /recipient_address=([^;\s]+)/i.exec(rec)?.[1];
  const rname = /recipient_name=([^;]+)/i.exec(rec)?.[1];
  const desc = /tx_description=([^;]+)/i.exec(rec)?.[1];
  return addr ? { address: addr, profileName: rname?.trim(), description: desc?.trim() } : null;
}

function namehash(name: string): Uint8Array {
  let node: Uint8Array = new Uint8Array(32);
  if (name) {
    for (const label of name.split('.').reverse()) {
      const h = keccak_256(new TextEncoder().encode(label));
      node = keccak_256(new Uint8Array([...node, ...h]));
    }
  }
  return node;
}

const hexOf = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

async function ens(q: string, w: WalletBase): Promise<string | null> {
  const rpc = (w.type === 'ethereum' || w.type === 'polygon') && (w as any).rpcUrl ? (w as any).rpcUrl : 'https://ethereum-rpc.publicnode.com';
  const node = hexOf(namehash(q.toLowerCase()));
  const call = async (to: string, data: string) => {
    const r = await postJson<any>(rpc, { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }, H);
    if (r.error) throw new Error(r.error.message);
    return String(r.result);
  };
  const resolver = `0x${(await call('0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e', `0x0178b8bf${node}`)).slice(-40)}`;
  if (/^0x0{40}$/.test(resolver)) return null;
  const addr = `0x${(await call(resolver, `0x3b3b57de${node}`)).slice(-40)}`;
  return /^0x0{40}$/.test(addr) ? null : addr;
}

async function zcashNames(q: string): Promise<string | null> {
  const name = q.replace(/\.(zcash|zec)$/i, '');
  if (!/^[A-Za-z0-9_-]{1,63}$/.test(name)) return null;
  const r = await postJson<any>('https://main.zcashnames.com', { jsonrpc: '2.0', id: 1, method: 'resolve', params: { query: name } }, H);
  return r?.result?.address ?? null;
}

async function zcashMe(q: string): Promise<string | null> {
  const handle = q.trim().replace(/^zcash\.me\//i, '').split('/').filter(Boolean).pop();
  if (!handle) return null;
  const html = await getText(`https://zcash.me/${encodeURIComponent(handle)}`, H);
  return /(t1[0-9A-Za-z]{33}|t3[0-9A-Za-z]{33}|zs[a-z0-9]{76}|u1[a-z0-9]{1,300})/.exec(html)?.[1] ?? null;
}

async function wellKnown(q: string): Promise<Partial<ResolvedAddress> | null> {
  const parts = q.split('@');
  const alias = (parts.length === 3 ? parts[1] : parts[0]) || '_';
  const domain = parts[parts.length - 1];
  const res = await request(`https://${domain}/.well-known/nano-currency.json?names=${encodeURIComponent(encodeURIComponent(alias))}`, undefined, { ...H, headers: { Accept: 'application/json' } });
  if (!(res.headers['content-type'] ?? '').includes('application/json')) return null;
  const j = JSON.parse(text(res));
  const n = (j.names ?? []).find((x: any) => String(x.name).toLowerCase() === alias.toLowerCase());
  return n?.address ? { address: n.address, profileImage: n.image, profileName: n.name } : null;
}

async function bip353(q: string, cur: Currency): Promise<Partial<ResolvedAddress> | null> {
  const [user, domain] = q.replace(/^₿/, '').split('@');
  const { records, authenticated } = await dnsTxt(`${user}.user._bitcoin-payment.${domain}`);
  // Cake requires a DNSSEC proof; here the DoH resolver's DNSSEC validation (AD flag) is required instead
  if (!authenticated) return null;
  const prefix = `${(cur.fullName ?? 'bitcoin').toLowerCase().replace(/\s/g, '')}:`;
  const rec = records.find((r) => r.toLowerCase().startsWith(prefix));
  if (!rec) return null;
  const body = rec.slice(prefix.length);
  const [path, query = ''] = body.split('?');
  const params = new URLSearchParams(query);
  const addr = params.get('sp') || path;
  return addr ? { address: addr } : null;
}

async function fio(q: string, cur: Currency): Promise<string | null> {
  const a = await postJson<any>('https://fio.blockpane.com/v1/chain/avail_check', { fio_name: q }, H);
  if (a?.is_registered !== 1) return null;
  const r = await postJson<any>('https://fio.blockpane.com/v1/chain/get_pub_address', { fio_address: q, chain_code: cur.title, token_code: cur.title }, H);
  return r?.public_address ?? null;
}

async function thorchain(q: string, cur: Currency): Promise<string | null> {
  if (q.length > 30) return null;
  const r = await getJson<any>(`https://midgard.ninerealms.com/v2/thorname/lookup/${encodeURIComponent(q)}`, H);
  const chain = cur.key === 'rune' ? 'THOR' : cur.title.toUpperCase();
  return (r?.entries ?? []).find((e: any) => e.chain === chain)?.address ?? null;
}

async function nostr(q: string, cur: Currency): Promise<Partial<ResolvedAddress> | null> {
  const [name, domain] = q.split('@');
  if (!/^[A-Za-z0-9-_.]+$/.test(name)) return null;
  const j = await getJson<any>(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`, H);
  const pub = j?.names?.[name];
  if (!pub) return null;
  // relays speak WebSocket, which Tor-in-the-page cannot carry: read the profile from an HTTP gateway instead
  const p = await getJson<any>(`https://api.nostr.band/v0/profile/${pub}`, H).catch(() => null);
  const meta = p?.profile?.event?.content ? JSON.parse(p.profile.event.content) : null;
  const addr = meta?.about ? extractAddress(meta.about, cur) : null;
  return addr ? { address: addr, profileName: meta?.name, profileImage: meta?.picture } : null;
}

// --------------------------------------------------------------- helpers --

export function stripHtml(s: string): string {
  return s.replace(/[\u2028\u2029]/g, '\n').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ').trim();
}

const EXTRACT: Record<string, string> = {
  xmr: '(4[0-9a-zA-Z]{94})|(8[0-9a-zA-Z]{94})|([0-9a-zA-Z]{106})',
  btc: '[1mnL][a-km-zA-HJ-NP-Z1-9]{25,34}|[23M][a-km-zA-HJ-NP-Z1-9]{25,34}|(bc|tb|ltc)1q[ac-hj-np-z02-9]{25,39}|(bc|tb)1p([ac-hj-np-z02-9]{39}|[ac-hj-np-z02-9]{59}|[ac-hj-np-z02-9]{8,89})|(bc|tb)1q[ac-hj-np-z02-9]{40,80}|(tsp|sp|sprt)1[0-9a-zA-Z]{113}',
  ltc: 'L[a-zA-Z0-9]{26,33}|[LM][a-km-zA-HJ-NP-Z1-9]{26,33}|ltc[a-zA-Z0-9]{26,45}|(ltc|t)mweb1q[ac-hj-np-z02-9]{90,120}',
  eth: '0x[0-9a-zA-Z]+',
  nano: 'nano_[0-9a-zA-Z]{60}',
  bch: '(bitcoincash:)?q[0-9a-zA-Z]{41,42}',
  sol: '[1-9A-HJ-NP-Za-km-z]{43,44}',
  trx: '(T|t)[1-9A-HJ-NP-Za-km-z]{33}',
  zec: '(?:t1[0-9A-Za-z]{33}|t3[0-9A-Za-z]{33}|zs[a-z0-9]{76}|u1[a-z0-9]{1,300})',
  doge: 'D[a-km-zA-HJ-NP-Z1-9]{25,34}',
};

export function extractAddress(raw: string, cur: Currency): string | null {
  const p = EXTRACT[cur.key];
  if (!p) return null;
  const m = new RegExp(`(^|\\s)(${p})($|\\s)`, 'mi').exec(stripHtml(raw));
  if (!m) return null;
  return m[2].replace(/(bitcoincash:|nano_|ban_)|[^0-9a-zA-Z]/g, (x, keep) => keep ?? '');
}

// --------------------------------------------------------------- resolve --

const ICONS = 'address_sources/';

export async function resolveAddress(query: string, w: WalletBase, curOverride?: Currency): Promise<ResolvedAddress | null> {
  const q = query.trim();
  if (!q) return null;
  const cur = curOverride ?? w.currency;
  if (cur.key !== 'zano' && isValidAddressFor(cur, q)) return null;
  const s = settings.value as any;
  const at = q.includes('@');
  const dot = q.includes('.');
  const providers: { on: boolean; can: boolean; currencies: (c: Currency) => boolean; source: string; icon: string; run: () => Promise<Partial<ResolvedAddress> | string | null> }[] = [
    { on: s.lookupsLnurl ?? true, can: dot && at, currencies: (c) => c.key === 'btc' && w.type === 'bitcoin', source: 'Lightning Address', icon: 'icon-lnurl-pay.svg', run: () => lnurlPay(q) },
    { on: s.lookupsMastodon, can: q.startsWith('@') && q.indexOf('@', 1) > 0 && q.indexOf('.', 1) > 0, currencies: (c) => RELIABLE.has(c.key), source: 'Mastodon', icon: 'mastodon.svg', run: () => mastodon(q, cur) },
    { on: s.lookupsYatService, can: /^[\p{Extended_Pictographic}\s\u200d\ufe0f]+$/u.test(q), currencies: (c) => ['xmr', 'btc', 'eth', 'ltc'].includes(c.key), source: 'Yat', icon: 'yat.svg', run: () => yat(q, cur) },
    { on: s.lookupsUnstoppableDomains, can: (() => { const l = q.replace('@', '.').split('.'); return l.length >= 2 && !!l[0] && UD_TLDS.includes(l[l.length - 1].toLowerCase()); })(), currencies: (c) => ['xmr', 'btc'].includes(c.key), source: 'Unstoppable Domains', icon: 'unstoppable.svg', run: () => unstoppable(q, cur) },
    { on: s.lookupsOpenAlias, can: q.replace('@', '.').includes('.'), currencies: (c) => ['xmr', 'btc'].includes(c.key), source: 'OpenAlias', icon: 'openalias.svg', run: () => openAlias(q, cur) },
    { on: s.lookupsENS, can: q.toLowerCase().endsWith('.eth'), currencies: (c) => c.key === 'eth', source: 'Ethereum Name Service', icon: 'ens.svg', run: () => ens(q, w) },
    { on: s.lookupsZcashNames ?? true, can: /\.(zec|zcash)$/i.test(q), currencies: (c) => c.key === 'zec', source: 'Zcash Names', icon: 'icon-zcashnames.svg', run: () => zcashNames(q) },
    { on: s.lookupsZcashMe ?? true, can: /^zcash\.me\/.+/i.test(q), currencies: (c) => c.key === 'zec', source: 'Zcash.me', icon: 'icon-zcash-me.svg', run: () => zcashMe(q) },
    { on: s.lookupsWellKnown, can: dot && at, currencies: (c) => c.key === 'nano', source: '.well-known', icon: 'wellknown.svg', run: () => wellKnown(q) },
    { on: s.lookupsBip353, can: at && dot && !q.startsWith('@'), currencies: (c) => c.key === 'btc', source: 'BIP-353', icon: 'bip353.svg', run: () => bip353(q, cur) },
    { on: s.lookupsFio, can: !q.startsWith('@') && at && !dot, currencies: (c) => RELIABLE.has(c.key), source: 'FIO', icon: 'fio.svg', run: () => fio(q, cur) },
    { on: s.lookupsThorChain, can: q.length > 0, currencies: (c) => RELIABLE.has(c.key), source: 'ThorChain', icon: 'icon-thorchain.svg', run: () => thorchain(q, cur) },
    { on: s.lookupsNostr, can: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/i.test(q), currencies: (c) => RELIABLE.has(c.key), source: 'Nostr', icon: 'nostr.svg', run: () => nostr(q, cur) },
  ];
  for (const p of providers) {
    if (!p.on || !p.can || !p.currencies(cur)) continue;
    try {
      const r = await p.run();
      if (!r) continue;
      const res = typeof r === 'string' ? { address: r } : r;
      if (!res.address) continue;
      return { address: res.address, name: q, source: p.source, icon: `${ICONS}${p.icon}`, description: res.description, profileName: res.profileName, profileImage: res.profileImage };
    } catch {
      /* errors are swallowed, like Cake */
    }
  }
  return null;
}
