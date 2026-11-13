// Images from other hosts (provider logos, payment method icons): fetched over
// Tor like everything else and shown from a blob: URL (the page's CSP only
// allows its own, data: and blob: images). Cached for the session.

import { useEffect, useState } from 'preact/hooks';
import { fetchRemote, sniffImage } from '../../net/remote.ts';
import { Img } from './core.tsx';

const cache = new Map<string, Promise<string | null>>();
/** logos and card art */
const MAX_BYTES = 512 * 1024;

/** a remote image over Tor as a blob: URL (null when it cannot be had or is no image); `scope`: whose circuits */
export function torImageUrl(url: string, maxBytes = MAX_BYTES, scope = 'images'): Promise<string | null> {
  const key = `${maxBytes}|${url}`;
  let p = cache.get(key);
  if (!p) {
    p = fetchRemote(url, { scope, maxBytes, timeoutMs: 60_000, purpose: 'image' })
      .then((r) => {
        const type = sniffImage(r.body, r.headers['content-type'] ?? '');
        return type ? URL.createObjectURL(new Blob([r.body as BlobPart], { type })) : null;
      })
      .catch(() => null);
    cache.set(key, p);
  }
  return p;
}

const isRemote = (s: string | null | undefined) => !!s && /^https?:\/\//i.test(s);

/** an image path of the app's assets, or a remote URL loaded over Tor (the fallback until then, or if it fails) */
export function RemoteImg({ src, size = 24, fallback, round, cover }: { src?: string | null; size?: number; fallback?: string; round?: boolean; cover?: boolean }) {
  const style = cover ? { width: '100%', height: '100%', objectFit: 'cover' as const } : undefined;
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
  if (url) return <Img src={url} size={size} round={round} style={style} />;
  return fallback ? <Img src={fallback} size={size} round={round} /> : <span style={{ display: 'inline-block', width: `${size}px`, height: `${size}px`, flex: 'none' }} />;
}
