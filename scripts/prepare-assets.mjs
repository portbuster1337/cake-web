// Build-time asset preparation: copies the prebuilt monero-ts web worker
// (Monero's wallet2 compiled to WebAssembly) into public/vendor, so it is
// served from this site's own origin (no CDN, no third party).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dstDir = path.join(root, 'public', 'vendor');
fs.mkdirSync(dstDir, { recursive: true });
for (const f of ['monero.worker.js', 'monero.worker.js.LICENSE.txt']) {
  const src = path.join(root, 'node_modules', 'monero-ts', 'dist', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dstDir, f));
}
console.log('prepared public/vendor');
