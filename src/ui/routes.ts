// Route registry: route name (Cake's Routes.*) -> page component.

import type { FunctionComponent } from 'preact';

export const Routes = {
  welcome: '/welcome',
  welcomeWallet: '/welcome_create_restore_wallet',
  newWallet: '/new_wallet',
  setupPin: '/setup_pin_code',
  newWalletFromWelcome: '/new_wallet_from_welcome',
  seed: '/seed',
  restoreOptions: '/restore_options',
  restoreWalletFromSeedKeys: '/restore_wallet_from_seeds_keys',
  restoreWalletFromHardwareWallet: '/restore/hardware_wallet',
  restoreWalletTypeFromQR: '/restore_wallet_from_qr_code',
  restoreWalletChooseDerivation: '/restore_wallet_choose_derivation',
  connectHardwareWallet: '/restore/hardware_wallet/devices',
  dashboard: '/dashboard',
  send: '/send',
  transactionDetails: '/transaction_info',
  bumpFeePage: '/bump_fee_page',
  receive: '/receive',
  newSubaddress: '/new_subaddress',
  walletEdit: '/walletEdit',
  disclaimer: '/disclaimer',
  readDisclaimer: '/read_disclaimer',
  changeRep: '/change_representative',
  walletList: '/view_model.wallet_list',
  auth: '/auth',
  newNode: '/new_node_list',
  newPowNode: '/new_pow_node_list',
  login: '/login',
  splash: '/splash',
  nanoAccountCreation: '/nano_account_new',
  addressBook: '/address_book',
  pickerAddressBook: '/picker_address_book',
  pickerWalletAddress: '/picker_wallet_address',
  addressBookAddContact: '/address_book_add_contact',
  showKeys: '/show_keys',
  showKeysDisclaimer: '/show_keys_disclaimer',
  exchangeConfirm: '/exchange_confirm',
  tradeHistory: '/trade_history',
  tradeDetails: '/trade_details',
  swapOptions: '/swap_options',
  swapProvidersPage: '/swap_providers',
  swapProviderSelector: '/swap_provider_selector',
  swapProviderPicker: '/swap_provider_picker',
  trocadorProviders: '/trocador_providers',
  exchangeTrade: '/exchange_trade',
  exchange: '/exchange',
  settings: '/settings',
  unlock: '/auth_not_closable',
  rescan: '/rescan',
  faq: '/faq',
  newWalletType: '/new_wallet_type',
  restoreWalletType: '/restore_wallet_type',
  restoreWallet: '/restore_wallet',
  preSeedPage: '/pre_seed_page',
  transactionSuccessPage: '/transaction_success_info_page',
  backup: '/backup',
  editBackupPassword: '/edit_backup_passowrd',
  restoreFromBackup: '/restore_from_backup',
  support: '/support',
  supportLiveChat: '/support/live_chat',
  supportOtherLinks: '/support/other',
  orderDetails: '/order_details',
  buySellPage: '/buy_sell_page',
  buySellProviders: '/buy_sell_providers',
  buySellPaymentMethods: '/buy_sell_payment_methods',
  buySellConfirmation: '/buy_sell_confirmation',
  buySellRedirecting: '/buy_sell_redirecting',
  unspentCoinsList: '/unspent_coins_list',
  unspentCoinsDetails: '/unspent_coins_details',
  addressPage: '/address_page',
  newReceivePage: '/new_receive_page',
  fullscreenQR: '/fullscreen_qr',
  cakePayWelcomePage: '/cake_pay_welcome_page',
  cakePayCardsPage: '/cake_pay_cards_page',
  cakePayBuyCardPage: '/cake_pay_buy_card_page',
  cakePayAccountPage: '/cake_pay_account_page',
  cakePayVerifyOtpPage: '/cake_pay_verify_otp_page',
  webViewPage: '/web_view_page',
  silentPaymentsSettings: '/silent_payments_settings',
  mwebSettings: '/mweb_settings',
  connectionSync: '/connection_sync_page',
  securityBackupPage: '/security_and_backup_page',
  securityBackupDuressPin: '/security_and_backup_duress_pin',
  setupDuressPin: '/setup_duress_pin',
  privacyPage: '/privacy_page',
  trocadorProvidersPage: '/trocador_providers_page',
  domainLookupsPage: '/domain_lookups_page',
  displaySettingsPage: '/display_settings_page',
  otherSettingsPage: '/other_settings_page',
  advancedPrivacySettings: '/advanced_privacy_settings',
  sweepingWalletPage: '/sweeping_wallet_page',
  walletPasswordUnlock: '/wallet_password_unlock',
  anonPayDetailsPage: '/anon_pay_details_page',
  transactionsPage: '/transactions_page',
  setup_2faPage: '/setup_2fa_page',
  setup_2faQRPage: '/setup_2fa_qr_page',
  totpAuthCodePage: '/totp_auth_code_page',
  modify2FAPage: '/modify_2fa_page',
  setup2faInfoPage: '/setup_2fa_info_page',
  homeSettings: '/home_settings',
  editToken: '/edit_token',
  walletAccountsPage: '/wallet_accounts_page',
  cardCustomizer: '/card_customizer',
  manageNodes: '/manage_nodes',
  managePowNodes: '/manage_pow_nodes',
  walletConnectConnectionsListing: '/wallet-connect-connections-listing',
  nftDetailsPage: '/nft_details_page',
  importNFTPage: '/import_nft_page',
  startTor: '/start_tor',
  receiveAddresses: '/receive_addresses',
  devNetworkRequests: '/dev/network_requests',
  signPage: '/sign_page',
  walletGroupsDisplayPage: '/wallet_groups_display_page',
  walletGroupDescription: '/wallet_group_description',
  walletGroupExistingSeedDescriptionPage: '/wallet_group_existing_seed_description_page',
  walletSeedVerificationPage: '/wallet_seed_verification_page',
  exchangeTradeExternalSendPage: '/exchange_trade_external_send_page',
  dEuroSavings: '/integration/dEuro/savings',
  aboutPage: '/about_page',
  torSettings: '/tor_settings',
  apiKeysPage: '/api_keys',
} as const;

export type RouteName = (typeof Routes)[keyof typeof Routes];

const registry = new Map<string, FunctionComponent<{ args?: any }>>();

export function registerRoute(name: string, c: FunctionComponent<any>): void {
  registry.set(name, c);
}

export function routeComponent(name: string): FunctionComponent<{ args?: any }> | undefined {
  return registry.get(name);
}

/** pages that stay mounted under the pages pushed over them (their state lives in the component) */
const keepAlive = new Set<string>();

export function registerKeepAlive(name: string): void {
  keepAlive.add(name);
}

export function isKeepAlive(name: string): boolean {
  return keepAlive.has(name);
}

export function registeredRoutes(): string[] {
  return [...registry.keys()];
}
