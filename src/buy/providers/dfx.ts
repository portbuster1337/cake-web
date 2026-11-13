// DFX.swiss (lib/buy/dfx/dfx_buy_provider.dart): buy and sell with EUR or CHF;
// no API key. Opening it signs DFX's ownership message with the wallet and
// logs in (POST /v1/auth) for a session link to app.dfx.swiss.

import { exFetch, tryJson } from '../../exchange/net.ts';
import { dartDouble } from '../../exchange/amounts.ts';
import { t } from '../../core/i18n.ts';
import { WALLET_TYPE_NAME } from '../../coins/types.ts';
import type { WalletBase } from '../../core/wallet.ts';
import { pairCurrency } from '../pairs.ts';
import { BuyProviderError, type BuyProvider, type FetchQuoteArgs, type PaymentMethod, type PaymentType, type Quote } from '../types.ts';

const API = 'https://api.dfx.swiss';
const WALLET_NAME = 'CakeWallet';
/** _supportedCrypto; the ETH- and POL-tagged ones are excluded again (_notSupportedCrypto) */
const SUPPORTED = new Set(['xmr', 'btc', 'eth', 'maticpoly', 'sol', 'zano', 'trx']);
const TIMEOUT_MS = 30_000;

/** normalizePaymentMethod / _getPaymentTypeByString */
const toDfx = (p: PaymentType): string | null => (p === 'bankTransfer' ? 'Bank' : p === 'creditCard' ? 'Card' : p === 'sepa' ? 'Instant' : null);
const fromDfx = (s: string | null | undefined): PaymentType => (s === 'Bank' ? 'bankTransfer' : s === 'Card' ? 'creditCard' : s === 'Instant' ? 'sepa' : 'unknown');

/** _toDouble: numbers and numeric strings */
function toDouble(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

export function createDfx(w: WalletBase): BuyProvider {
  /** blockchain: "Bitcoin", "Zano", else walletTypeToString */
  const blockchain = w.type === 'bitcoin' ? 'Bitcoin' : w.type === 'zano' ? 'Zano' : WALLET_TYPE_NAME[w.type];
  const json = { accept: 'application/json' };
  // the fiat and asset lists, once per buy session (Cake asks again for every quote)
  let fiats: Promise<any[]> | null = null;
  let assets: Promise<any> | null = null;

  const fiatList = (): Promise<any[]> => {
    fiats ??= exFetch(`${API}/v1/fiat`, { headers: json, scope: 'buy', timeoutMs: TIMEOUT_MS, purpose: 'DFX fiat' }).then((r) => (r.status === 200 ? tryJson<any[]>(r) ?? [] : Promise.reject(new Error(`HTTP ${r.status}`))));
    return fiats.catch((e) => {
      fiats = null;
      throw e;
    });
  };

  /** fetchFiatCredentials */
  const fiatCredentials = async (fiat: string): Promise<any> => {
    try {
      return (await fiatList()).find((x) => x?.name === fiat) ?? {};
    } catch {
      return {};
    }
  };

  /** fetchAssetCredential: the asset named like the currency on the wallet's chain, else its first asset */
  const assetCredential = async (name: string): Promise<any> => {
    try {
      assets ??= exFetch(`${API}/v1/asset?${new URLSearchParams({ blockchains: blockchain })}`, { headers: json, scope: 'buy', timeoutMs: TIMEOUT_MS, purpose: 'DFX assets' }).then((r) => (r.status === 200 ? tryJson<any>(r) : Promise.reject(new Error(`HTTP ${r.status}`))));
      const d = await assets.catch((e) => {
        assets = null;
        throw e;
      });
      if (Array.isArray(d) && d.length) return d.find((i) => String(i?.dexName ?? '').toLowerCase() === name.toLowerCase()) ?? d[0];
      return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
    } catch {
      return {};
    }
  };

  /** getSignature: EVM/Solana/Tron sign the message; Monero and the Bitcoin-style wallets sign with the address */
  const signature = async (message: string, address: string): Promise<string> => {
    switch (w.type) {
      case 'ethereum': case 'polygon': case 'base': case 'arbitrum': case 'bsc': case 'robinhood': case 'solana': case 'tron':
        return w.signMessage(message);
      case 'monero': case 'litecoin': case 'bitcoin': case 'bitcoinCash': case 'zano':
        return w.signMessage(message, address);
      default:
        throw new BuyProviderError(`WalletType is not available for DFX ${w.type}`);
    }
  };

  /** auth: sign up / sign in with the address; the session token */
  const auth = async (address: string): Promise<string> => {
    const message = `By_signing_this_message,_you_confirm_that_you_are_the_sole_owner_of_the_provided_Blockchain_address._Your_ID:_${address}`;
    const sig = await signature(message, address);
    const r = await exFetch(`${API}/v1/auth`, { body: { wallet: WALLET_NAME, address, signature: sig }, scope: 'buy', retries: 0, purpose: 'DFX login' });
    const j = tryJson<any>(r) ?? {};
    if (r.status === 201) return String(j.accessToken);
    if (r.status === 403) throw new BuyProviderError(String(j.message ?? 'Service unavailable in your country'));
    const msg = String(j.message ?? '');
    throw new BuyProviderError(`Failed to sign up. ${/address must match|signature must match/.test(msg) ? 'The wallet type must match the selected currency' : msg || `Unknown error: ${r.status}`}`);
  };

  const provider: BuyProvider = {
    title: 'DFX.swiss',
    description: 'dfx_option_description',
    icon: 'assets/images/dfx_dark.png',
    lightIcon: 'assets/images/dfx_light.png',
    isAggregator: false,

    supports(c, fiat) {
      const b = pairCurrency(c);
      return !!b && SUPPORTED.has(b.key) && b.tag !== 'ETH' && b.tag !== 'POL' && (fiat === 'EUR' || fiat === 'CHF');
    },

    /** getAvailablePaymentTypes: buy — the fiat's methods with limits; sell — Bank, Card, Instant when the asset is sellable */
    async paymentTypes(fiat, crypto, isBuy) {
      const out: PaymentMethod[] = [];
      if (isBuy) {
        const f = await fiatCredentials(fiat);
        for (const [k, v] of Object.entries<any>(f.limits ?? {})) {
          const min = toDouble(v?.minVolume);
          const max = toDouble(v?.maxVolume);
          if (min !== null && max !== null && min > 0 && max > 0) out.push({ type: fromDfx(k), customTitle: k, customIconPath: 'assets/new-ui/buy_payment_methods/debit_card.svg' });
        }
      } else {
        const a = await assetCredential(crypto.title);
        if (a.sellable === true) for (const t of ['bankTransfer', 'creditCard', 'sepa'] as PaymentType[]) out.push({ type: t, customTitle: toDfx(t)!, customIconPath: 'assets/new-ui/buy_payment_methods/debit_card.svg' });
      }
      return out;
    },

    /** fetchQuote: PUT /v1/{buy|sell}/quote; Cake reads the rate and limits and ignores isValid/error */
    async fetchQuote(a: FetchQuoteArgs): Promise<Quote[] | null> {
      if (a.isBuy && a.fiat !== 'EUR' && a.fiat !== 'CHF') return null;
      const pm = a.paymentType && a.paymentType !== 'all' ? toDfx(a.paymentType) ?? a.paymentType : 'Bank';
      const f = await fiatCredentials(a.fiat);
      if (f.id == null) return null;
      const asset = await assetCredential(a.crypto.title);
      if (asset.id == null) return null;
      try {
        const r = await exFetch(`${API}/v1/${a.isBuy ? 'buy' : 'sell'}/quote`, { method: 'PUT', scope: 'buy', headers: json, body: { currency: { id: f.id }, asset: { id: asset.id }, amount: a.amount, targetAmount: 0, paymentMethod: pm, discountCode: '' }, timeoutMs: TIMEOUT_MS, purpose: 'DFX quote' });
        if (r.status !== 200) return null;
        const j = tryJson<any>(r);
        if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
        const rate = toDouble(j.exchangeRate) ?? 0;
        return [{
          rate: a.isBuy ? rate : 1 / rate,
          feeAmount: toDouble(j.feeAmount) ?? 0,
          networkFee: toDouble(j.fees?.network) ?? 0,
          transactionFee: toDouble(j.fees?.rate) ?? 0,
          // DFX sends no payout: 0, as in Cake (DFX sorts last when buying)
          payout: toDouble(j.payout) ?? 0,
          paymentType: fromDfx(j.paymentMethod),
          recommendations: ['lowKyc'],
          provider,
          isBuyAction: a.isBuy,
          limits: { min: toDouble(j.minVolume) ?? 0, max: toDouble(j.maxVolume) ?? Infinity },
          fiat: a.fiat,
          crypto: a.crypto,
        }];
      } catch {
        return null;
      }
    },

    async launchUrl({ quote, amount, isBuy, cryptoCurrencyAddress }) {
      const token = await auth(cryptoCurrencyAddress);
      const q = new URLSearchParams({ session: token, lang: 'en', 'asset-out': isBuy ? quote.crypto.title : quote.fiat, blockchain, 'asset-in': isBuy ? quote.fiat : quote.crypto.title, 'amount-in': dartDouble(amount) });
      return `https://app.dfx.swiss/${isBuy ? 'buy' : 'sell'}?${q}`;
    },

    launchError(message) {
      return { title: 'DFX.swiss', content: `${t('buy_provider_unavailable')}: ${message}` };
    },
  };
  return provider;
}
