// Images from other hosts (provider logos, payment method icons): fetched over
// Tor like everything else and shown from a blob: URL (the page's CSP only
// allows its own, data: and blob: images). Cached for the session.

import { useEffect, useState } from 'preact/hooks';
import { request } from '../../net/http.ts';
import { Img } from './core.tsx';

const cache = new Map<string, Promise<string | null>>();
const MAX_BYTES = 512 * 1024;

function sniff(body: Uint8Array, header: string): string | null {
  const h = header.split(';')[0].trim().toLowerCase();
  if (/^image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/.test(h)) return h;
  const head = new TextDecoder().decode(body.subarray(0, 256)).trimStart().toLowerCase();
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
  if (body[0] === 0x89 && body[1] === 0x50) return 'image/png';
  if (body[0] === 0xff && body[1] === 0xd8) return 'image/jpeg';
  return null;
}

export function torImageUrl(url: string): Promise<string | null> {
  let p = cache.get(url);
  if (!p) {
    p = request(url, undefined, { scope: 'images', timeoutMs: 45_000, retries: 1, purpose: 'image' })
      .then((r) => {
        if (r.body.length > MAX_BYTES) return null;
        const type = sniff(r.body, r.headers['content-type'] ?? '');
        return type ? URL.createObjectURL(new Blob([r.body as BlobPart], { type })) : null;
      })
      .catch(() => null);
    cache.set(url, p);
  }
  return p;
}

const isRemote = (s: string | null | undefined) => !!s && /^https?:\/\//i.test(s);

/** an image path of the app's assets, or a remote URL loaded over Tor (the fallback until then, or if it fails) */
export function RemoteImg({ src, size = 24, fallback, round }: { src?: string | null; size?: number; fallback?: string; round?: boolean }) {
  const remote = isRemote(src);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!remote || !src) return;
    let live = true;
    void torImageUrl(src).then((u) => live && setUrl(u));
    return () => {
      live = false;
    };
  }, [src]);
  if (!remote) return <Img src={src ?? fallback} size={size} round={round} />;
  if (url) return <Img src={url} size={size} round={round} />;
  return fallback ? <Img src={fallback} size={size} round={round} /> : <span style={{ display: 'inline-block', width: `${size}px`, height: `${size}px`, flex: 'none' }} />;
}
