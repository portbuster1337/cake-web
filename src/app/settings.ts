// Settings (SettingsStore in Cake: lib/store/settings_store.dart). Persisted
// encrypted in the vault; the few values needed before the PIN is entered
// (language, theme, PIN length) are mirrored in plain localStorage/kv.

import { signal, effect } from '@preact/signals';
import { vault } from '../core/vault.ts';
import type { WalletType } from '../coins/types.ts';

export type FiatApiMode = 'enabled' | 'torOnly' | 'disabled';
export type ExchangeApiMode = 'enabled' | 'torOnly' | 'disabled';
export type BalanceDisplayMode = 'availableBalance' | 'hiddenBalance' | 'fullBalance';
export type SyncStatusDisplayMode = 'eta' | 'blocksRemaining';

export interface Settings {
  fiatCurrency: string;
  languageCode: string;
  themeRaw: number | null;
  balanceDisplayMode: BalanceDisplayMode;
  hiddenBalanceToggles: number;
  shouldSaveRecipientAddress: boolean;
  fiatApiMode: FiatApiMode;
  exchangeStatus: ExchangeApiMode;
  disableTradeOption: boolean;
  disableBulletin: boolean;
  disableAutomaticExchangeStatusUpdates: boolean;
  shouldShowMarketPlaceInDashboard: boolean;
  showAddressBookPopupEnabled: boolean;
  displayAmountsInSatoshi: boolean;
  /** 0 = sats (LN), 1 = BTC, 2 = sats */
  bitcoinAmountDisplay: 0 | 1 | 2;
  useBlinkProtection: boolean;
  lookupsLnurl: boolean;
  lookupsZcashNames: boolean;
  lookupsZcashMe: boolean;
  customElectrumFeeRate: number;
  enableDuressPin: boolean;
  sortBalanceBy: 0 | 1 | 2;
  walletListOrderType: 0 | 1 | 2 | 3;
  walletListAscending: boolean;
  contactListOrderType: 0 | 1 | 2 | 3;
  contactListAscending: boolean;
  backupPassword: string;
  showCombinedBalance: Record<string, boolean>;
  favoriteToken: Record<string, string | null>;
  syncStatusDisplayMode: SyncStatusDisplayMode;
  /** auto-generate subaddresses / addresses */
  autoGenerateSubaddressStatus: 'initialized' | 'enabled' | 'disabled';
  /** PinCodeRequiredDuration in minutes (0 = always) */
  pinTimeOutDuration: number;
  pinLength: 4 | 6;
  allowBiometricalAuthentication: boolean;
  /** Cake 2FA */
  useTOTP2FA: boolean;
  totpSecretKey: string;
  shouldRequireTOTP2FAForAccessingWallet: boolean;
  shouldRequireTOTP2FAForSendsToContact: boolean;
  shouldRequireTOTP2FAForSendsToNonContact: boolean;
  shouldRequireTOTP2FAForSendsToInternalWallets: boolean;
  shouldRequireTOTP2FAForExchangesToInternalWallets: boolean;
  shouldRequireTOTP2FAForExchangesToExternalWallets: boolean;
  shouldRequireTOTP2FAForAddingContacts: boolean;
  shouldRequireTOTP2FAForCreatingNewWallets: boolean;
  shouldRequireTOTP2FAForAllSecurityAndBackupSettings: boolean;
  selectedCake2FAPreset: string;
  /** fee priority per wallet type */
  priority: Partial<Record<WalletType, string>>;
  /** seed types for new wallets */
  moneroSeedType: string;
  bitcoinSeedType: string;
  nanoSeedType: string;
  /** domain lookups */
  lookupsTwitter: boolean;
  lookupsMastodon: boolean;
  lookupsYatService: boolean;
  lookupsUnstoppableDomains: boolean;
  lookupsOpenAlias: boolean;
  lookupsENS: boolean;
  lookupsWellKnown: boolean;
  lookupsZanoAlias: boolean;
  lookupsBip353: boolean;
  lookupsNostr: boolean;
  lookupsThorChain: boolean;
  lookupsFio: boolean;
  /** EVM/Solana/Tron history sources */
  useEtherscan: boolean;
  usePolygonScan: boolean;
  useBaseScan: boolean;
  useArbiScan: boolean;
  useBscScan: boolean;
  useTronGrid: boolean;
  useMempoolFeeAPI: boolean;
  /** silent payments / mweb */
  silentPaymentsCardDisplay: boolean;
  silentPaymentsAlwaysScan: boolean;
  mwebCardDisplay: boolean;
  mwebEnabled: boolean;
  mwebAlwaysScan: boolean;
  /** default buy/sell providers per wallet type */
  defaultBuyProviders: Partial<Record<WalletType, string>>;
  defaultSellProviders: Partial<Record<WalletType, string>>;
  /** exchange provider enable states */
  exchangeProvidersSelection: Record<string, boolean>;
  trocadorProviderStates: Record<string, boolean>;
  decentralizedOnly: boolean;
  /** user-supplied API keys for providers that need one */
  apiKeys: Record<string, string>;
  /** home screen tokens display */
  showTokensTab: boolean;
  isAppSecure: boolean;
  preventScreenshots: boolean;
  showPayjoinCard: boolean;
  usePayjoin: boolean;
  /** Tor */
  torRelays: string[];
  localNodes: string[];
  /** seed backup reminders dismissed per wallet */
  seedBackedUp: Record<string, boolean>;
  dismissedPromos: Record<string, boolean>;
  currentWalletId: string | null;
  walletListOrder: string[];
  /** wallet ids grouped by user */
  walletGroupNames: Record<string, string>;
  /** card designs per wallet/account */
  cardDesigns: Record<string, { gradient?: string; icon?: string; design?: string }>;
}

export const DEFAULT_SETTINGS: Settings = {
  fiatCurrency: 'USD',
  languageCode: 'en',
  themeRaw: null,
  balanceDisplayMode: 'availableBalance',
  hiddenBalanceToggles: 0,
  shouldSaveRecipientAddress: true,
  fiatApiMode: 'enabled',
  exchangeStatus: 'enabled',
  disableTradeOption: false,
  disableBulletin: false,
  disableAutomaticExchangeStatusUpdates: false,
  shouldShowMarketPlaceInDashboard: true,
  showAddressBookPopupEnabled: true,
  displayAmountsInSatoshi: false,
  bitcoinAmountDisplay: 0,
  useBlinkProtection: true,
  lookupsLnurl: true,
  lookupsZcashNames: true,
  lookupsZcashMe: true,
  customElectrumFeeRate: 1,
  enableDuressPin: false,
  sortBalanceBy: 0,
  walletListOrderType: 0,
  walletListAscending: true,
  contactListOrderType: 0,
  contactListAscending: true,
  backupPassword: '',
  showCombinedBalance: {},
  favoriteToken: {},
  syncStatusDisplayMode: 'blocksRemaining',
  autoGenerateSubaddressStatus: 'initialized',
  pinTimeOutDuration: 10,
  pinLength: 4,
  allowBiometricalAuthentication: false,
  useTOTP2FA: false,
  totpSecretKey: '',
  shouldRequireTOTP2FAForAccessingWallet: false,
  shouldRequireTOTP2FAForSendsToContact: false,
  shouldRequireTOTP2FAForSendsToNonContact: false,
  shouldRequireTOTP2FAForSendsToInternalWallets: false,
  shouldRequireTOTP2FAForExchangesToInternalWallets: false,
  shouldRequireTOTP2FAForExchangesToExternalWallets: false,
  shouldRequireTOTP2FAForAddingContacts: false,
  shouldRequireTOTP2FAForCreatingNewWallets: false,
  shouldRequireTOTP2FAForAllSecurityAndBackupSettings: false,
  selectedCake2FAPreset: 'normal',
  priority: {},
  moneroSeedType: 'polyseed',
  bitcoinSeedType: 'bip39',
  nanoSeedType: 'bip39',
  lookupsTwitter: true,
  lookupsMastodon: true,
  lookupsYatService: true,
  lookupsUnstoppableDomains: true,
  lookupsOpenAlias: true,
  lookupsENS: true,
  lookupsWellKnown: true,
  lookupsZanoAlias: true,
  lookupsBip353: true,
  lookupsNostr: true,
  lookupsThorChain: true,
  lookupsFio: true,
  useEtherscan: true,
  usePolygonScan: true,
  useBaseScan: true,
  useArbiScan: true,
  useBscScan: true,
  useTronGrid: true,
  useMempoolFeeAPI: true,
  silentPaymentsCardDisplay: true,
  silentPaymentsAlwaysScan: false,
  mwebCardDisplay: true,
  mwebEnabled: false,
  mwebAlwaysScan: false,
  defaultBuyProviders: {},
  defaultSellProviders: {},
  exchangeProvidersSelection: {},
  trocadorProviderStates: {},
  decentralizedOnly: false,
  apiKeys: {},
  showTokensTab: true,
  isAppSecure: false,
  preventScreenshots: false,
  showPayjoinCard: true,
  usePayjoin: false,
  torRelays: [],
  localNodes: [],
  seedBackedUp: {},
  dismissedPromos: {},
  currentWalletId: null,
  walletListOrder: [],
  walletGroupNames: {},
  cardDesigns: {},
};

export const settings = signal<Settings>({ ...DEFAULT_SETTINGS });

let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

export async function loadSettings(): Promise<void> {
  const s = await vault.get<Partial<Settings>>('settings');
  settings.value = { ...DEFAULT_SETTINGS, ...(s ?? {}) };
  loaded = true;
}

export function updateSettings(patch: Partial<Settings> | ((s: Settings) => Partial<Settings>)): void {
  const p = typeof patch === 'function' ? patch(settings.value) : patch;
  settings.value = { ...settings.value, ...p };
}

/** Persist (debounced) whenever settings change while unlocked. */
effect(() => {
  const s = settings.value;
  if (!loaded || !vault.unlocked) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (vault.unlocked) void vault.put('settings', s);
  }, 150);
  try {
    localStorage.setItem('cw-lang', s.languageCode);
  } catch { /* storage disabled */ }
});

export function resetSettingsLoaded(): void {
  loaded = false;
}
