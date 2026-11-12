#!/usr/bin/env node
// Optional Tor relay bridge for people who want to run their own relay entry
// point. Neither users nor the wallet need it: the wallet is a static site
// (GitHub Pages works) that does everything in the browser and reaches the
// Tor network through public relays.
//
// What it does:
//  * /tor  WebSocket <-> TCP to Tor relays, for the Tor client running inside
//          the wallet page. Only Tor relay addresses can be dialed and the
//          bridge only ever sees TLS-encrypted Tor link traffic: it learns
//          the user's IP address (like a Tor guard), nothing else.
//  * optionally serves a built copy of the wallet (with security headers) and
//    a /relays.json that points that copy at this bridge.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { RelayAllowlist } from './relays.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// relays.json is only served when this bridge also hosts the wallet
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version;

// ---------------------------------------------------------------- options --

function parseArgs(argv) {
  const opts = {
    host: process.env.XTW_HOST || '127.0.0.1',
    port: Number(process.env.XTW_PORT || 8787),
    dist: path.join(HERE, '..', 'dist'),
    public: false,
    allowOrigins: [],
    allowHosts: [],
    connectSrc: [],
    relayCheck: true,
    quiet: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === '--host') opts.host = next();
    else if (a === '--port') opts.port = Number(next());
    else if (a === '--dist') opts.dist = path.resolve(next());
    else if (a === '--public') opts.public = true;
    else if (a === '--allow-origin') opts.allowOrigins.push(next());
    else if (a === '--allow-host') opts.allowHosts.push(next().toLowerCase());
    else if (a === '--connect-src') opts.connectSrc.push(next());
    else if (a === '--no-relay-check') opts.relayCheck = false;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node server/index.mjs [options]

  --host <ip>            listen address (default 127.0.0.1)
  --port <n>             listen port (default 8787)
  --dist <dir>           built wallet to serve as well (default ./dist, if present)
  --public               public mode (e.g. behind a TLS reverse proxy): accept bridge
                         clients from any web origin (restrict with --allow-origin)
  --allow-origin <url>   web origin allowed to use the bridge (repeatable, or "*")
  --allow-host <host>    extra Host header value accepted (e.g. a LAN name you serve on)
  --connect-src <src>    extra CSP connect-src source (e.g. wss://bridge.example)
  --no-relay-check       do not restrict the bridge to known Tor relays (testing only)`);
      process.exit(0);
    } else throw new Error(`unknown option ${a}`);
  }
  return opts;
}

const opts = parseArgs(process.argv);
const log = opts.quiet ? { info() {}, warn() {}, error: console.error } : console;

// ------------------------------------------------------------- utilities --

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const h = hostHeader.toLowerCase();
  if (opts.public) return true;
  const ports = [`:${opts.port}`];
  const base = ['127.0.0.1', 'localhost', '[::1]'];
  if (!['0.0.0.0', '::', '127.0.0.1', 'localhost', '::1'].includes(opts.host)) base.push(opts.host.includes(':') ? `[${opts.host}]` : opts.host);
  if (base.some((b) => ports.some((p) => h === b + p))) return true;
  return opts.allowHosts.includes(h) || opts.allowHosts.includes(h.replace(/:\d+$/, ''));
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  return !!origin && (origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`);
}

function originAllowedForBridge(req) {
  const origin = req.headers.origin;
  if (opts.allowOrigins.includes('*')) return true;
  // A public bridge serves any page unless restricted with --allow-origin;
  // a local one only its own page, so random websites can't use it.
  if (opts.public && !opts.allowOrigins.length) return true;
  if (!origin) return opts.public; // non-browser clients
  if (sameOrigin(req)) return true;
  return opts.allowOrigins.includes(origin);
}

function securityHeaders(req) {
  const host = req.headers.host || `${opts.host}:${opts.port}`;
  const connect = ["'self'", `ws://${host}`, `wss://${host}`, ...opts.connectSrc].join(' ');
  return {
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "worker-src 'self'",
      `connect-src ${connect} data:`,
      "img-src 'self' data: blob:",
      "style-src 'self'",
      "font-src 'self'",
      "manifest-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()',
  };
}

function send(res, req, status, body, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, { ...securityHeaders(req), 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}

// ------------------------------------------------------- static web app --

function serveStatic(req, res) {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return send(res, req, 400, 'bad request');
  }
  let file = path.normalize(path.join(opts.dist, urlPath));
  const rel = path.relative(opts.dist, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return send(res, req, 403, 'forbidden');
  if (urlPath.endsWith('/')) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    if (path.extname(urlPath)) return send(res, req, 404, 'not found');
    file = path.join(opts.dist, 'index.html'); // SPA fallback
    if (!fs.existsSync(file)) return send(res, req, 503, 'web app not built: run `npm run build`');
  }
  const ext = path.extname(file).toLowerCase();
  const immutable = file.includes(`${path.sep}assets${path.sep}`);
  res.writeHead(200, {
    ...securityHeaders(req),
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

// ----------------------------------------------------------- Tor bridge --

const relays = new RelayAllowlist({ log, disabled: !opts.relayCheck });
const MAX_TUNNELS_PER_IP = 96;
const tunnelsByIp = new Map();
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });

function handleBridge(ws, req, target) {
  const ip = req.socket.remoteAddress;
  tunnelsByIp.set(ip, (tunnelsByIp.get(ip) || 0) + 1);
  const i = target.lastIndexOf(':');
  const host = target.slice(0, i).replace(/^\[|\]$/g, '');
  const port = Number(target.slice(i + 1));
  const sock = net.connect({ host, port });
  let connected = false;
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    tunnelsByIp.set(ip, Math.max(0, (tunnelsByIp.get(ip) || 1) - 1));
    sock.destroy();
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000);
  };
  sock.setNoDelay(true);
  sock.setTimeout(20_000, () => {
    if (!connected) {
      if (ws.readyState === ws.OPEN) ws.send('ERR connect timeout');
      finish();
    }
  });
  sock.once('connect', () => {
    connected = true;
    sock.setTimeout(0);
    sock.setKeepAlive(true, 60_000);
    if (ws.readyState === ws.OPEN) ws.send('OK');
  });
  sock.on('data', (chunk) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(chunk, { binary: true });
    if (ws.bufferedAmount > 4 * 1024 * 1024) {
      sock.pause();
      const wait = setInterval(() => {
        if (ws.readyState !== ws.OPEN || ws.bufferedAmount < 1024 * 1024) {
          clearInterval(wait);
          sock.resume();
        }
      }, 20);
    }
  });
  sock.on('end', () => {
    if (ws.readyState === ws.OPEN) ws.send('FIN');
  });
  sock.on('close', finish);
  sock.on('error', (e) => {
    if (!connected && ws.readyState === ws.OPEN) ws.send(`ERR ${e.code || 'connect failed'}`);
    finish();
  });
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      if (String(data) === 'FIN') sock.end();
      return;
    }
    if (!connected) return finish(); // protocol violation: data before OK
    if (!sock.write(data)) {
      ws.pause();
      sock.once('drain', () => ws.resume());
    }
  });
  ws.on('close', finish);
  ws.on('error', finish);
}

// --------------------------------------------------------------- server --

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/relays.json') {
    // tell the wallet to use this server's bridge first
    return send(res, req, 200, JSON.stringify({ relays: ['{ws}://{host}/tor'], bridge: { version: VERSION, relays: relays.addrs.size, source: relays.source } }), 'application/json; charset=utf-8');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, req, 405, 'method not allowed');
  if (opts.public && !fs.existsSync(path.join(opts.dist, 'index.html'))) return send(res, req, 200, 'Tor bridge for monero-web');
  if (!hostAllowed(req.headers.host)) return send(res, req, 403, 'forbidden (unexpected Host header; see --allow-host)');
  return serveStatic(req, res);
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const reject = (code, msg) => {
    socket.write(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  };
  if (url.pathname !== '/tor') return reject(404, 'Not Found');
  if (!opts.public && !hostAllowed(req.headers.host)) return reject(403, 'Forbidden');
  if (!originAllowedForBridge(req)) return reject(403, 'Forbidden');
  if ((tunnelsByIp.get(req.socket.remoteAddress) || 0) >= MAX_TUNNELS_PER_IP) return reject(429, 'Too Many Requests');
  const target = url.searchParams.get('target') || '';
  const why = relays.check(target);
  if (why) return reject(403, 'Forbidden');
  wss.handleUpgrade(req, socket, head, (ws) => handleBridge(ws, req, target));
});

async function main() {
  relays.start().catch((e) => log.warn(`[relays] ${e.message}`));
  server.listen(opts.port, opts.host, () => {
    const shown = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
    log.info(`monero-web bridge ${VERSION} listening on http://${shown}:${opts.port}`);
    log.info(`  Tor relay bridge: ws://${shown}:${opts.port}/tor${opts.public ? ' (public: any web origin)' : ' (this origin only)'}`);
  });
}

main();
