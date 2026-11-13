// IPFS links. normalizeIpfsUrl is Cake's tryNormalizeIpfsUrl
// (cw_core/lib/utils/ipfs_url.dart): ipfs:// through the ipfs.io gateway,
// other links only when they are https. The ipfs.io gateway was retired in
// September 2026 and dweb.link turns Tor away, so the links are fetched from
// the public gateways that still answer over Tor (ipfsGatewayUrls).

const GATEWAY = 'https://ipfs.io/ipfs/';
const SCHEME = 'ipfs://';

export function normalizeIpfsUrl(url: string | null | undefined): string | null {
  if (url === null || url === undefined) return null;
  if (!url.toLowerCase().startsWith(SCHEME)) return url.toLowerCase().startsWith('https://') ? url : null;
  let cid = url.slice(SCHEME.length);
  // some minters write ipfs://ipfs/<cid>, which would double the gateway path
  if (cid.toLowerCase().startsWith('ipfs/')) cid = cid.slice(5);
  return cid ? `${GATEWAY}${cid}` : null;
}

/** the gateways tried, in order */
export const IPFS_GATEWAYS = ['https://ipfs.filebase.io/ipfs/', 'https://gateway.pinata.cloud/ipfs/'];

/** gateways of the form https://<host>/ipfs/<cid>/<path> */
const PATH_GATEWAYS = new Set(['ipfs.io', 'gateway.ipfs.io', 'dweb.link', 'cloudflare-ipfs.com', 'cf-ipfs.com', 'gateway.pinata.cloud', 'ipfs.filebase.io', 'nftstorage.link', 'w3s.link', 'ipfs.moralis.io', '4everland.io', 'ipfs.infura.io', 'infura-ipfs.io', 'ipfs.fleek.co', 'gateway.lighthouse.storage']);
/** gateways of the form https://<cid>.ipfs.<host>/<path> */
const SUBDOMAIN_GATEWAYS = new Set(['dweb.link', 'w3s.link', 'nftstorage.link', '4everland.io', 'cf-ipfs.com', 'infura-ipfs.io', 'inbrowser.link']);

/** the IPFS path (<cid>/<path>?<query>) of an ipfs:// link or a known gateway's https link, else null */
export function ipfsPath(url: string): string | null {
  if (url.toLowerCase().startsWith(SCHEME)) {
    let cid = url.slice(SCHEME.length);
    if (cid.toLowerCase().startsWith('ipfs/')) cid = cid.slice(5);
    return cid || null;
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  if (PATH_GATEWAYS.has(host) && u.pathname.startsWith('/ipfs/')) {
    const rest = u.pathname.slice('/ipfs/'.length);
    return rest ? `${rest}${u.search}` : null;
  }
  const sub = /^([a-z0-9]+)\.ipfs\.(.+)$/.exec(host);
  if (sub && SUBDOMAIN_GATEWAYS.has(sub[2])) return `${sub[1]}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
  return null;
}

/** where to fetch a link from: an IPFS link on each gateway in turn, anything else as it is */
export function ipfsGatewayUrls(url: string): string[] {
  const p = ipfsPath(url);
  return p ? IPFS_GATEWAYS.map((g) => `${g}${p}`) : [url];
}
