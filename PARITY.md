# Parity with Cake Wallet

What this web client does compared with the official app (Cake Wallet 6.5.3, new UI). "Same" means it
follows Cake's code: the same screens, strings, defaults, requests and, where they are visible, the same
quirks. Everything that goes over the network goes through Tor (`src/net/router.ts`); the only things
that leave the app are links the user opens (explorers, a provider's checkout page), and the app says
so before opening them.

Services that need an API key: the official app ships Cake Labs' keys; a public web page cannot keep
one secret, so this client ships none. Those services stay off until the user adds their own key
(Settings → Connection and sync → API keys). Keyless alternatives are used by default wherever they
exist.

## Wallets

| Wallet | Status | Notes |
| --- | --- | --- |
| Monero | ✅ | Polyseed, 25-word legacy and BIP-39 seeds, keys; accounts and subaddresses, hidden addresses, sign/verify, rescan. monero-ts (WASM) with the node over Tor. |
| Bitcoin | ✅ | BIP-39 and Electrum seeds, all of Cake's address types and derivations, accounts, coin control, RBF bump fee, sign/verify, silent payments **sending** (BIP-352). |
| Litecoin | ✅ | No MWEB (it needs Cake's MWEB daemon). |
| Bitcoin Cash, Dogecoin | ✅ | Dogecoin through Bitcore (other indexers refuse Tor exits). |
| Ethereum, Polygon, Base, Arbitrum, BNB Smart Chain, Robinhood Chain | ✅ | Tokens (Cake's default lists, add/remove, spam heuristics), EIP-1559 fees, ENS. |
| Solana | ✅ | SPL tokens, Jupiter swaps signed by the wallet. |
| Tron | ✅ | TRC-20 tokens, energy/bandwidth fees. |
| Nano | ✅ | Representatives, receive/send with proof-of-work computed in the page. |
| Zcash, Decred | ⏳ | Listed as in Cake; "Coming soon" here (no engine yet). |
| Zano, Wownero, Haven, Banano | — | Not offered (Haven is deprecated in Cake; the others need native daemons). |
| Watch-only | ✅ | Monero (address + view key) and Bitcoin/Litecoin (xpub/zpub), as in Cake. |
| Hardware wallets | ❌ | Ledger, Trezor, Coldcard… need USB/Bluetooth/QR device links; the manufacturer page explains this. |

## App

| Area | Status | Notes |
| --- | --- | --- |
| Onboarding, PIN (4/6 digits), lockout, auto-lock, Terms of Use | ✅ | |
| Duress PIN | ✅ | Wipes every wallet and secret, then starts over. |
| Cake 2FA (TOTP) | ✅ | Including the per-action conditions. |
| Biometrics, screenshot blocking | — | Not available to a web page. |
| Dashboard: balance cards, card customizer, assets, history, charts, contacts, apps | ✅ | |
| History filters, CSV export | ✅ | Transactions, swaps and Cake Pay orders; Cake's 17-column CSV. |
| Address book, domain lookups | ✅ | OpenAlias, ENS, Unstoppable, Yat, BIP-353, FIO, Nostr, Mastodon, ThorChain, .well-known (all over Tor). |
| Backups | ✅ | Cake's v3 backup files, both ways (with trades and orders). Version 1 backups are not read. |
| Settings: display, privacy, security, connection and sync (nodes, Tor), other | ✅ | Node lists are Cake's; "Tor only" nodes as in Cake. |
| Languages and themes | ✅ | All 30 languages, Cake's themes. |

## Swap

Cake's exchange view model: limits over the selected providers, the best rate every 10 s, fixed and
floating rates, send-all, forced provider, the provider whitelist, decentralized-only, trades with
status updates every 5 minutes.

| Provider | Status | Notes |
| --- | --- | --- |
| SwapTrade, XOSwap, NEAR Intents, Jupiter | ✅ keyless | Orders verified over Tor. NEAR Intents without Cake's JWT adds 1Click's own fee. |
| ChangeNOW, Trocador (onion API), Chainflip, WhyNot | 🔑 | With the user's API key. |
| Swaps.XYZ | ❌ | Needs EVM call-data routing not built yet. |
| SideShift, SimpleSwap, Exolix, StealthEx, THORChain | — | Not active in Cake 6.5.3 either. |

This client takes no markup or affiliate fee of its own.

## Buy / Sell

| Provider | Status | Notes |
| --- | --- | --- |
| DFX.swiss | ✅ keyless | EUR/CHF, buy and sell; signs in with the wallet's signature over Tor. |
| Onramper, MoonPay, Kryptonim | 🔑 | With the user's keys (Onramper and MoonPay also need the user's signing key for checkout links — Cake signs them on its own server). |
| Robinhood | ❌ | Needs Cake's application id and its exchange helper. |

The provider's checkout page opens in the browser from a button, outside the app's Tor connection.

## Integrations

| Feature | Status | Notes |
| --- | --- | --- |
| Cake Pay | ✅ keyless | Marketplace, e-mail login, card purchase paid from Bitcoin, Litecoin or Monero wallets, orders and their status. |
| dEuro Savings | ✅ | Approve, deposit, withdraw, collect and reinvest through the Ethereum wallet. |
| Silent payments | ◐ | Sending to sp1 addresses; receiving needs a BIP-352 tweak server (Cake runs its own). |
| WalletConnect, NFTs | ❌ | The WalletConnect relay is a WebSocket, which cannot go through Tor here yet. |
| Lightning, MWEB, Payjoin | ❌ | Need Cake's native services. |
| AnonPay invoices, exchange templates | ❌ | |

✅ done · 🔑 needs the user's API key · ◐ partly · ⏳ planned · ❌ not available · — not applicable
