// Remote content that is not an API (NFT metadata and art, logos): an IPFS link
// from each gateway in turn, up to 3 https redirects (Cake: maxRedirects = 3,
// https only), and a size limit checked while the body arrives.

import { request } from './http.ts';
import { ipfsGatewayUrls } from './ipfs.ts';
import { ResponseTooLargeError } from './tor.ts';
import type { NetResponse } from './router.ts';

export interface RemoteOptions {
  scope: string;
  maxBytes: number;
  timeoutMs?: number;
  purpose?: string;
}

export async function fetchRemote(url: string, o: RemoteOptions): Promise<NetResponse> {
  const urls = ipfsGatewayUrls(url);
  let last: unknown = new Error('No URL');
  for (const u of urls) {
    try {
      return await request(u, undefined, { scope: o.scope, timeoutMs: o.timeoutMs ?? 45_000, retries: urls.length > 1 ? 0 : 1, followRedirects: 3, maxBytes: o.maxBytes, purpose: o.purpose });
    } catch (e) {
      // too large is too large on every gateway
      if (e instanceof ResponseTooLargeError) throw e;
      last = e;
    }
  }
  throw last;
}

/** the image type from the header, else from the first bytes (gateways often send application/octet-stream) */
export function sniffImage(body: Uint8Array, header: string): string | null {
  const h = header.split(';')[0].trim().toLowerCase();
  if (/^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/.test(h)) return h;
  const head = new TextDecoder().decode(body.subarray(0, 256)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  const ascii = (o: number, n: number) => String.fromCharCode(...body.subarray(o, o + n));
  if (body[0] === 0x89 && body[1] === 0x50) return 'image/png';
  if (body[0] === 0xff && body[1] === 0xd8) return 'image/jpeg';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftypavif') return 'image/avif';
  return null;
}
