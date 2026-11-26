# Cake Wallet Web

**Open it: <https://portbuster1337.github.io/cake-web/>** (also on Codeberg: <https://portbuster.codeberg.page/cake-web/>) · source: <https://github.com/portbuster1337/cake-web>

A web client for [Cake Wallet](https://github.com/cake-tech/cake_wallet) that runs **entirely in
your browser** and sends **every network request through Tor**. It follows the official app
(version 6.5.3, new UI) screen by screen: the same flows, strings (all 30 languages), icons,
themes, wallet types, seeds and derivations, so a wallet made here restores in Cake Wallet and
the other way round.

- **Purely client side.** A static site (Codeberg Pages); there is no server of its own. Keys,
  seeds, signing, scanning and swap quotes all happen in the page.
- **Tor for everything.** [Arti](https://gitlab.torproject.org/tpo/core/arti), the Tor Project's
  Rust client, compiled to WebAssembly ([tor-js](https://github.com/ethereum/tor-js)), runs in the
  page. `src/net/router.ts` is the only place requests are made, and it refuses to send anything
  around Tor. Each wallet gets its own circuits, and so does each server it talks to.
- **Encrypted at rest.** The PIN unwraps a random data key (PBKDF2-SHA256 → AES-256-GCM) that
  encrypts settings, wallets, seeds, history and contacts in IndexedDB.

## What works

Monero, Bitcoin, Litecoin, Bitcoin Cash, Dogecoin, Ethereum, Polygon, Base, Arbitrum, BNB Smart
Chain, Robinhood Chain, Solana, Tron and Nano wallets — create, restore, send, receive, tokens,
accounts, coin control, fee bumping, message signing, NFTs — plus Swap, Buy/Sell, Cake Pay gift
cards, dEuro Savings, backups in Cake's format and the rest of Cake's settings and dashboard. See
[PARITY.md](PARITY.md) for the feature-by-feature status against the official app, including what
is missing (hardware wallets, WalletConnect, Lightning, MWEB, Zcash, Decred).

Services that the official app reaches with Cake Labs' own API keys are used keyless wherever the
service allows it (SwapTrade, XOSwap, NEAR Intents and Jupiter swaps, DFX.swiss, Cake Pay, NFTs); the
others turn on once you add your own key under Settings → Connection and sync → API keys. The
client takes no fee of its own.

## Build

```bash
npm install
npm run build          # static site in dist/
npm run preview        # http://127.0.0.1:8787
npm test               # unit tests (node --test)
node test/e2e/swap-flow.mjs   # end-to-end runs in headless Chrome, over Tor (see test/e2e/*)
npm run typecheck
scripts/publish-pages.sh   # build and publish to Codeberg Pages
```

## License

MIT. Icons, fonts, strings and texts in `public/cake` and `public/locales` come from Cake Wallet
(MIT, © Cake Labs LLC).
