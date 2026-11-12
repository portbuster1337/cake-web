import { defineConfig, type Plugin } from 'vite';
import process from 'node:process';

// Cake Wallet Web is a static site: every action (Tor, wallets, signing,
// exchange quotes) runs in the browser. Any static host works (GitHub Pages,
// Codeberg Pages, IPFS, nginx). All URLs are relative (base './').
//
// Static hosts can't send headers, so the policy ships inside the page.
// connect-src can't express "only via Tor"; that is enforced in code
// (src/net/router.ts is the only place requests are made, and the Tor client
// runs in the page). http:/https: are needed only for a node on your own
// machine/LAN and for Tor Browser mode. Images may only come from this site
// or from memory (blob:/data:): remote images are fetched over Tor first.
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' ws: wss: https: http: data: blob:",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: mediastream:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "manifest-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cspMeta(): Plugin {
  return {
    name: 'cw-csp-meta',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<meta charset="utf-8" />', `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`);
    },
  };
}

// Workers get their own policy from response headers. The wallet engines need
// no network at all: their requests are handed to the page's router.
const WORKER_CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' data: blob:";

/** Netlify-style `_headers` (Codeberg Pages, Netlify, Cloudflare Pages) when PAGES_BASE is set. */
function pagesHeaders(): Plugin {
  return {
    name: 'cw-pages-headers',
    apply: 'build',
    generateBundle() {
      const raw = process.env.PAGES_BASE;
      if (!raw) return;
      const base = `/${raw.replace(/^\/+|\/+$/g, '')}/`.replace('//', '/');
      const page = [
        `  Content-Security-Policy: ${CSP}; frame-ancestors 'none'`,
        '  X-Frame-Options: DENY',
        '  Referrer-Policy: no-referrer',
        // (X-Content-Type-Options: nosniff is sent by git-pages itself and is not on its allowlist)
        '  Permissions-Policy: microphone=(), geolocation=(), payment=(), browsing-topics=(), interest-cohort=()',
      ];
      const worker = [`  Content-Security-Policy: ${WORKER_CSP}`, '  Referrer-Policy: no-referrer'];
      const source = [
        '# Security headers. The first matching rule applies.',
        `${base}monero.worker.host.js`, ...worker,
        `${base}vendor/*`, ...worker,
        `${base}*`, ...page,
        '',
      ].join('\n');
      this.emitFile({ type: 'asset', fileName: '_headers', source });
    },
  };
}

// GitHub Pages runs Jekyll, which drops files whose names start with "_".
const noUnderscore = (name: string) => name.replace(/^_+/, '');

export default defineConfig({
  base: './',
  plugins: [cspMeta(), pagesHeaders()],
  esbuild: { jsx: 'automatic', jsxImportSource: 'preact' },
  resolve: { alias: { react: 'preact/compat', 'react-dom': 'preact/compat' } },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    sourcemap: false,
    chunkSizeWarningLimit: 8000,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: (chunk) => `assets/${noUnderscore(chunk.name)}-[hash].js`,
        assetFileNames: (asset) => `assets/${noUnderscore((asset.names?.[0] ?? 'asset').replace(/\.[^.]+$/, ''))}-[hash][extname]`,
      },
    },
  },
  worker: { format: 'es' },
  // keep tor-js un-prebundled so its `new URL('…wasm', import.meta.url)` resolves
  optimizeDeps: { exclude: ['tor-js'] },
  server: { host: '127.0.0.1', port: 5173 },
  preview: { host: '127.0.0.1' },
});
