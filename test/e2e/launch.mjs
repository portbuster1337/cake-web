// Shared browser launcher for the E2E scripts: headless Chrome or Firefox.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

export const BROWSERS = {
  chrome: process.env.CHROME || '/tmp/opencode/chrome-headless-shell-linux64/chrome-headless-shell',
  firefox: process.env.FIREFOX || '/tmp/opencode/browsers/firefox/linux-stable_160.0/firefox/firefox',
};

/**
 * @param {object} o
 * @param {boolean} [o.insecureCerts] accept the self-signed cert of the local GitHub Pages emulator
 * @param {object} [o.firefoxPrefs] extra Firefox prefs (e.g. to emulate Tor Browser)
 */
export async function launch({ browser = 'chrome', profile, width = 1100, height = 900, insecureCerts = false, firefoxPrefs = {} } = {}) {
  const firefox = browser === 'firefox';
  const b = await puppeteer.launch({
    browser: firefox ? 'firefox' : 'chrome',
    executablePath: BROWSERS[browser],
    headless: true,
    userDataDir: profile,
    // long waits (wallet syncs) are single CDP calls: the 180 s default would cut them off
    protocolTimeout: 3_600_000,
    acceptInsecureCerts: insecureCerts,
    args: firefox ? [] : ['--no-sandbox', `--window-size=${width},${height}`, ...(insecureCerts ? ['--ignore-certificate-errors'] : [])],
    defaultViewport: { width, height },
    extraPrefsFirefox: firefox ? { 'media.peerconnection.enabled': true, 'media.navigator.permission.disabled': true, ...firefoxPrefs } : undefined,
  });
  // a throwaway profile under /tmp/opencode goes with the browser (KEEP_PROFILE=1 keeps it)
  if (profile?.startsWith('/tmp/opencode/cw-') && !process.env.KEEP_PROFILE) {
    const close = b.close.bind(b);
    b.close = async () => {
      await close();
      fs.rmSync(profile, { recursive: true, force: true });
    };
  }
  return b;
}

/**
 * Record which origins the page talks to. HTTP requests are seen in every
 * browser; WebSocket handshakes too (they start as HTTP GETs).
 */
export function trackRequests(page) {
  const origins = new Map();
  page.on('request', (r) => {
    let u;
    try {
      u = new URL(r.url());
    } catch {
      return;
    }
    if (u.protocol === 'data:' || u.protocol === 'blob:') return;
    origins.set(u.origin, (origins.get(u.origin) || 0) + 1);
  });
  return origins;
}
