import './polyfills.ts';
import { render } from 'preact';
import { App } from './ui/app.tsx';
import { boot } from './app/app.ts';
import './ui/theme/styles.css';
import './ui/pages/index.ts';
import './coins/registry.ts';

// Static hosts can't send frame-ancestors/X-Frame-Options, so refuse to run
// inside another site's frame (clickjacking).
if (window.top !== window.self) {
  document.body.textContent = 'For your safety Cake Wallet does not run inside a frame. Open it directly.';
  throw new Error('framed');
}

render(<App />, document.getElementById('app')!);
void boot();

// Handy for debugging from the console and for the end-to-end tests.
import * as appApi from './app/app.ts';
import { settings as settingsSignal } from './app/settings.ts';
import { nav as navApi } from './ui/nav.ts';
import * as tradesApi from './exchange/trades.ts';
import * as cakePayApi from './cakepay/service.ts';
(globalThis as any).__cw = { app: appApi, settings: settingsSignal, nav: navApi, trades: tradesApi, cakepay: cakePayApi };
