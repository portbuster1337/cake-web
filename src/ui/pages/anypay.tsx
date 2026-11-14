// AnyPay's pages and flow (lib/new-ui/widgets/anypay/*): a payment request for another network
// offers one of that network's wallets or a swap; a bare EVM address asks for its network; EVM
// sends can change the recipient's network.

import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { t } from '../../core/i18n.ts';
import { Button, Icon, Img, MIcon, Spinner, TopBar } from '../components/core.tsx';
import { showAlert, showSheet } from '../components/overlays.tsx';
import { registerRoute, Routes } from '../routes.ts';
import { nav } from '../nav.ts';
import { openWallet, walletInfos } from '../../app/app.ts';
import { chainById, chainOf, EVM_CHAINS } from '../../coins/evm/chains.ts';
import { isEvm, WALLET_TYPE_NAME, type WalletType } from '../../coins/types.ts';
import { isTokenWallet } from '../../coins/tokens.ts';
import type { WalletBase, WalletInfo } from '../../core/wallet.ts';
import { iconFor } from './dashboard/wallets.tsx';
import { boundToChain, defaultTokenLookup, evaluate, isAliasInput, swapIntent, type AnyPayRequest, type AnyPayToken, type Decision, type Snapshot, type TokenLookup } from '../../app/anypay.ts';

const SYMBOLS: Partial<Record<WalletType, string>> = { monero: 'xmr', bitcoin: 'btc', litecoin: 'ltc', ethereum: 'eth', base: 'base', arbitrum: 'arb', bsc: 'bnb', bitcoinCash: 'bch', polygon: 'pol', robinhood: 'rob', solana: 'sol', tron: 'trx', zano: 'zano', decred: 'dcr', dogecoin: 'doge', zcash: 'zec', nano: 'xno' };

/** symbolIconPathForWalletType */
export const symbolIcon = (type: WalletType): string => (SYMBOLS[type] ? `assets/new-ui/card_icons/symbol_icons/${SYMBOLS[type]}-symbol.svg` : '');

/** a network icon, tinted when it is a monochrome symbol (isMonochromeSymbolIcon) */
export function NetworkIcon({ src, size }: { src: string; size: number }) {
  if (!src) return null;
  return src.includes('/symbol_icons/') ? <Icon src={src} size={size} color="var(--primary)" /> : <Img src={src} size={size} />;
}

/** networkDisplayName */
export const networkName = (type: WalletType, chainId?: number): string => (isEvm(type) ? chainById(chainId ?? chainOf(type).chainId)?.name ?? WALLET_TYPE_NAME[type] : WALLET_TYPE_NAME[type]);

const chainIdOf = (w: WalletBase): number | null => (isEvm(w.type) ? (w as { chainId?: number }).chainId ?? chainOf(w.type).chainId : null);

/** a token of the wallet's own list, else of the network's default list */
function lookupFor(w: WalletBase): TokenLookup {
  return (type, address) => {
    if (type === w.type && isTokenWallet(w)) {
      const own = w.tokens.find((x) => x.address.toLowerCase() === address.toLowerCase());
      if (own) return { walletType: type, address: own.address, symbol: own.symbol, name: own.name, decimals: own.decimals, icon: own.icon };
    }
    return defaultTokenLookup(type, address);
  };
}

/** what the send form is given (an absent amount or note keeps the form's) */
export interface AnyPayFill {
  address: string;
  amount?: string;
  note?: string;
  /** the asset to select (a currency key, or a token's key) */
  asset?: string;
}

/** applyAnyPayCurrency: the token's asset key in the wallet (added, or turned on, when the wallet lacks it) */
async function tokenAsset(w: WalletBase, token: AnyPayToken): Promise<string | undefined> {
  if (!isTokenWallet(w)) return undefined;
  const a = token.address.toLowerCase();
  const have = w.tokens.find((x) => x.address.toLowerCase() === a);
  if (!have) await w.addToken({ address: token.address, name: token.name, symbol: token.symbol, decimals: token.decimals, icon: token.icon, enabled: true, isPotentialScam: false });
  else if (!have.enabled) await w.setTokenEnabled(have.address, true);
  return w.assetList().find((x) => x.address?.toLowerCase() === a)?.key;
}

/**
 * _applyIntent / _applyPaymentRequest: the token, else the network's coin (whose amount is cleared when the request
 * names none), then the address, the amount and the note the request has
 */
async function fillFor(w: WalletBase, r: AnyPayRequest, token?: AnyPayToken, fallbackCurrency?: string, amountOverride?: string): Promise<AnyPayFill> {
  let asset: string | undefined;
  if (token) asset = await tokenAsset(w, token).catch(() => undefined);
  else if (fallbackCurrency && fallbackCurrency === w.currency.key) asset = w.currency.key;
  const amount = amountOverride ?? r.pr.amount;
  return { address: r.pr.address, amount: amount || (!token && fallbackCurrency && !r.pr.amount ? '' : undefined), note: r.pr.note || undefined, asset };
}

const fail = (message: string) => showAlert({ title: t('error'), content: message, right: t('ok') }).then(() => null);

/**
 * AnyPayFlow.handleEvaluation: the send form's fields for this request, or null — an alias (not AnyPay's), a choice
 * declined, an error shown, or a swap opened. A request taken by another wallet opens that wallet's send page.
 */
export async function runAnyPay(w: WalletBase, r: AnyPayRequest, fallbackCurrency?: string): Promise<AnyPayFill | null> {
  if (isAliasInput(r)) return null;
  const snapshot: Snapshot = { type: w.type, currentChainId: chainIdOf(w), wallets: walletInfos.value };
  const d = evaluate(r, snapshot, lookupFor(w));
  switch (d.kind) {
    case 'current':
      return fillFor(w, r, d.token, fallbackCurrency ?? d.fallbackCurrency, d.amountOverride);
    case 'evmChoice': {
      const chainId = await pickEvmNetwork();
      if (chainId === undefined) return null;
      return runAnyPay(w, boundToChain(r, chainId), chainById(chainId)?.currency);
    }
    case 'crossChain':
      return crossChain(w, r, d, fallbackCurrency);
    case 'unsupportedNetwork':
      return fail(t('unsupported_network_requested', { chainId: String(d.chainId) }));
    case 'unsupportedToken':
      return fail(t('unsupported_token_requested'));
    case 'empty':
      return null;
  }
}

/** the swap page, delivering what the request asks for to its address (_openSwap) */
function openSwap(r: AnyPayRequest, d: Extract<Decision, { kind: 'crossChain' }>): void {
  if (r.pr.contract && !d.token) {
    void fail(t('unsupported_token_requested'));
    return;
  }
  nav.push(Routes.exchange, { fromSend: swapIntent(r, d.targetWalletType, d.targetChainId, d.token) });
}

/** _handleCrossChain */
async function crossChain(w: WalletBase, r: AnyPayRequest, d: Extract<Decision, { kind: 'crossChain' }>, fallbackCurrency?: string): Promise<AnyPayFill | null> {
  const evmTarget = isEvm(d.targetWalletType);
  const dest = networkName(d.targetWalletType, d.targetChainId);
  const destIcon = symbolIcon(d.targetWalletType);
  if (!d.canSwap && !d.wallets.length) return fail(t('swap_unavailable_needs_network_wallet', { network: dest }));
  const cur = networkName(w.type, chainIdOf(w) ?? undefined);
  const curIcon = symbolIcon(w.type);
  if (!d.wallets.length) {
    await nav.pushForResult(Routes.anyPayDecision, {
      title: evmTarget ? t('swap_from_network', { network: cur }) : t('network_address_detected', { network: dest }),
      description: t('swap_from_network_description', { targetNetwork: dest, currentNetwork: cur }),
      destinationIcon: destIcon,
      currentIcon: curIcon,
      primaryText: evmTarget ? t('continue_to_swap') : t('swap_from_network', { network: cur }),
      primaryIcon: evmTarget ? undefined : 'swap_arrows.svg',
      onPrimary: () => openSwap(r, d),
      secondaryText: t('cancel'),
    });
    return null;
  }
  const picked = await nav.pushForResult<string>(Routes.anyPayDecision, {
    title: evmTarget ? t('send_to_network', { network: dest }) : t('network_address_detected', { network: dest }),
    description: d.canSwap ? t('send_to_network_description', { network: dest, currentNetwork: cur }) : t('swap_unavailable_switch_to_network', { network: dest }),
    destinationIcon: destIcon,
    primaryText: t('switch_to_x_wallet', { network: dest }),
    primaryIcon: 'wallet_filled.svg',
    // _pickDestinationWallet: the only wallet, or one picked
    onPrimary: async () => {
      const id = d.wallets.length > 1 ? await nav.pushForResult<string>(Routes.anyPaySwitchWallet, { networkName: dest, targetIcon: destIcon, wallets: d.wallets }) : d.wallets[0].id;
      if (id) nav.pop(id);
    },
    secondaryText: d.canSwap ? t('swap_from_network', { network: cur }) : t('cancel'),
    secondaryIcon: d.canSwap ? 'swap_arrows.svg' : undefined,
    onSecondary: d.canSwap ? () => openSwap(r, d) : undefined,
  });
  if (!picked) return null;
  return switchWallet(picked, r, d, fallbackCurrency);
}

/** _switchWallet: "Loading your wallet", then that wallet's send page with the request */
async function switchWallet(id: string, r: AnyPayRequest, d: Extract<Decision, { kind: 'crossChain' }>, fallbackCurrency?: string): Promise<null> {
  let close = () => {};
  void showSheet<void>((c) => {
    close = () => c();
    return (
      <div class="col" style={{ alignItems: 'center', gap: '16px', padding: '32px 24px 40px', background: 'var(--surface)', borderRadius: '24px 24px 0 0' }} id="anypay_loading_wallet">
        <Spinner large />
        <div style={{ fontSize: '16px', fontWeight: 500 }}>{t('loading_your_wallet')}</div>
      </div>
    );
  }, { dismissible: false });
  let next: WalletBase;
  try {
    next = await openWallet(id);
  } catch {
    close();
    return fail(t('network_switch_failed'));
  }
  close();
  const fill = await fillFor(next, r, d.token, fallbackCurrency ?? r.detection.currency ?? undefined, d.amountOverride);
  nav.replace(Routes.send, fill);
  return null;
}

// ------------------------------------------------------------- the pages --

const title20 = { fontSize: '20px', fontWeight: 500, letterSpacing: '-0.1px', textAlign: 'center' as const };
const muted = { color: 'var(--on-surface-variant)', letterSpacing: '-0.07px', textAlign: 'center' as const };

interface DecisionArgs {
  title: string;
  description: string;
  destinationIcon: string;
  currentIcon?: string;
  primaryText: string;
  primaryIcon?: string;
  onPrimary: () => unknown;
  secondaryText: string;
  secondaryIcon?: string;
  onSecondary?: () => unknown;
}

/** NetworkDecisionPage: the networks, the question, and the two ways */
function NetworkDecisionPage({ args }: { args: DecisionArgs }) {
  const header: ComponentChildren = args.currentIcon ? (
    <div class="rowx" style={{ gap: '12px', justifyContent: 'center' }}>
      <NetworkIcon src={args.currentIcon} size={50} />
      <MIcon name="arrow_forward" size={28} color="var(--primary)" />
      <NetworkIcon src={args.destinationIcon} size={50} />
    </div>
  ) : (
    <NetworkIcon src={args.destinationIcon} size={75} />
  );
  const btn = (text: string, icon: string | undefined, onClick: () => unknown, primary: boolean, id: string) => (
    <Button secondary={!primary} id={id} onClick={() => void onClick()}>
      {icon && <Icon src={icon} size={24} color={primary ? 'var(--on-primary)' : 'var(--primary)'} />}
      {text}
    </Button>
  );
  return (
    <div class="page solid" id="anypay_decision_page">
      <TopBar onBack={() => nav.pop()} />
      <div class="col" style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: '0 24px', gap: '0' }}>
        {header}
        <div style={{ ...title20, marginTop: '24px' }} id="anypay_decision_title">{args.title}</div>
        <div style={{ ...muted, marginTop: '16px' }} id="anypay_decision_description">{args.description}</div>
      </div>
      <div class="col" style={{ gap: '12px', padding: '0 16px 16px' }}>
        {btn(args.primaryText, args.primaryIcon, args.onPrimary, true, 'anypay_decision_primary')}
        {btn(args.secondaryText, args.secondaryIcon, args.onSecondary ?? (() => nav.pop()), false, 'anypay_decision_secondary')}
      </div>
    </div>
  );
}

/** SwitchNetworkWalletPage: the network's wallets */
function SwitchNetworkWalletPage({ args }: { args: { networkName: string; targetIcon: string; wallets: WalletInfo[] } }) {
  return (
    <div class="page solid" id="anypay_switch_wallet_page">
      <TopBar onBack={() => nav.pop()} />
      <div class="col" style={{ alignItems: 'center', paddingTop: '124px', gap: '24px' }}>
        <div class="rowx" style={{ gap: '8px' }}>
          <MIcon name="arrow_forward" size={32} color="var(--primary)" />
          <NetworkIcon src={args.targetIcon} size={50} />
        </div>
        <div style={title20}>{t('switch_to_x_wallet', { network: args.networkName })}</div>
        <div style={muted}>{t('select_compatible_wallet')}</div>
      </div>
      <div class="page-body col" style={{ padding: '24px 16px', gap: '12px' }}>
        {args.wallets.map((wi) => (
          <button type="button" class="rowx" id={`anypay_wallet_${wi.id}`} onClick={() => nav.pop(wi.id)} style={{ width: '100%', minHeight: '56px', gap: '12px', padding: '0 16px', borderRadius: '18px', border: 0, background: 'var(--surface-container)', color: 'var(--on-surface)', cursor: 'pointer', textAlign: 'start' }}>
            <Img src={iconFor(wi.type)} size={28} />
            <span class="grow" style={{ fontSize: '16px', fontWeight: 500 }}>{wi.name}</span>
            <MIcon name="chevronRight" size={16} color="var(--on-surface-variant)" />
          </button>
        ))}
      </div>
    </div>
  );
}

interface NetworkItem {
  chainId: number;
  name: string;
  /** the network's coin icon */
  icon: string;
  /** its symbol (rows) */
  symbol: string;
}

const evmNetworks = (): NetworkItem[] => Object.values(EVM_CHAINS).map((c) => ({ chainId: c.chainId, name: c.name, icon: iconFor(c.type) ?? '', symbol: symbolIcon(c.type) }));

/** NetworkListCard / RecipientNetworkListRow */
function NetworkList({ items, onPick, subtitle }: { items: NetworkItem[]; onPick: (id: number) => void; subtitle?: string }) {
  return (
    <div style={{ background: 'var(--surface-container)', borderRadius: '20px', overflow: 'hidden' }}>
      {items.map((n, i) => (
        <button type="button" class="rowx" id={`anypay_network_${n.chainId}`} onClick={() => onPick(n.chainId)} style={{ width: '100%', minHeight: '56px', gap: '12px', padding: '0 16px', border: 0, borderTop: i ? '1px solid var(--surface-container-high)' : 0, background: 'none', color: 'var(--on-surface)', cursor: 'pointer', textAlign: 'start' }}>
          <NetworkIcon src={n.symbol} size={24} />
          <span class="col grow">
            <span>{n.name}</span>
            {subtitle && <span style={{ fontSize: '12px', color: 'var(--on-surface-variant)', letterSpacing: '-0.06px' }}>{subtitle}</span>}
          </span>
          <MIcon name="chevronRight" size={16} color="var(--on-surface-variant)" />
        </button>
      ))}
    </div>
  );
}

/** StackedNetworkIcons: 50 px circles, 34 px apart */
function StackedIcons({ icons }: { icons: string[] }) {
  const size = 50;
  const step = 34;
  return (
    <div style={{ position: 'relative', height: `${size}px`, width: `${size + (icons.length - 1) * step}px`, alignSelf: 'center' }}>
      {icons.map((src, i) => (
        <span style={{ position: 'absolute', left: `${i * step}px`, width: `${size}px`, height: `${size}px`, padding: '2px', borderRadius: '50%', background: 'var(--surface-container)', border: '2px solid var(--surface)', boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Img src={src} size={size - 8} />
        </span>
      ))}
    </div>
  );
}

/** EvmAddressDetectedSheet: the network of a bare EVM address */
export function pickEvmNetwork(): Promise<number | undefined> {
  const items = evmNetworks();
  return showSheet<number>((close) => (
    <div class="col" style={{ background: 'var(--surface)', borderRadius: '24px 24px 0 0', paddingBottom: '16px' }} id="anypay_evm_sheet">
      <TopBar trailing={<button type="button" class="ficon" aria-label={t('close')} onClick={() => close()}><MIcon name="close" size={24} /></button>} />
      <div style={{ height: '32px' }} />
      <StackedIcons icons={items.map((n) => n.icon)} />
      <div style={{ ...title20, marginTop: '24px' }}>{t('evm_address_detected')}</div>
      <div style={{ ...muted, margin: '24px 32px 0' }}>{t('select_recipient_network_for_tx')}</div>
      <div style={{ padding: '64px 16px 0' }}>
        <NetworkList items={items} onPick={(id) => close(id)} />
      </div>
    </div>
  ));
}

/** SelectRecipientNetworkSheet: the current network, then the other compatible ones */
export function pickRecipientNetwork(currentChainId: number): Promise<number | undefined> {
  const items = evmNetworks();
  const current = items.filter((n) => n.chainId === currentChainId);
  const others = items.filter((n) => n.chainId !== currentChainId);
  return showSheet<number>((close) => (
    <div class="col" style={{ background: 'var(--surface)', borderRadius: '24px 24px 0 0', paddingBottom: '16px', maxHeight: '90vh' }} id="anypay_recipient_network_sheet">
      <TopBar trailing={<button type="button" class="ficon" aria-label={t('close')} onClick={() => close()}><MIcon name="close" size={24} /></button>} />
      <div style={{ height: '32px' }} />
      <div style={{ alignSelf: 'center' }}><Icon src="network_cube.svg" size={75} color="var(--on-surface-variant)" /></div>
      <div style={{ ...title20, marginTop: '24px' }}>{t('select_recipient_network')}</div>
      <div style={{ ...muted, margin: '24px 32px 0' }}>{t('select_recipient_network_description')}</div>
      <div class="col" style={{ padding: '32px 16px 0', overflowY: 'auto' }}>
        {current.length > 0 && <NetworkList items={current} onPick={(id) => close(id)} subtitle={t('current_network')} />}
        <div style={{ ...muted, textAlign: 'start', fontSize: '12px', margin: '24px 4px 12px' }}>{t('compatible_networks')}</div>
        <NetworkList items={others} onPick={(id) => close(id)} />
      </div>
    </div>
  ));
}

/** RecipientNetworkSelector: "on <network> ⌄" under an EVM recipient */
export function RecipientNetworkSelector({ w, onPick }: { w: WalletBase; onPick: (chainId: number) => void }) {
  const [busy, setBusy] = useState(false);
  const chainId = chainIdOf(w) ?? 1;
  return (
    <button type="button" class="rowx" id="anypay_recipient_network" disabled={busy} aria-label={`${t('network_prefix_on')} ${networkName(w.type, chainId)}`} onClick={async () => {
      setBusy(true);
      try {
        const id = await pickRecipientNetwork(chainId);
        if (id !== undefined && id !== chainId) onPick(id);
      } finally {
        setBusy(false);
      }
    }} style={{ alignSelf: 'flex-start', gap: '0', padding: '0 4px', border: 0, background: 'none', cursor: 'pointer', color: 'var(--on-surface)' }}>
      <span style={{ color: 'var(--on-surface-variant)', letterSpacing: '-0.07px' }}>{t('network_prefix_on')}</span>
      <span style={{ width: '12px' }} />
      <NetworkIcon src={symbolIcon(w.type)} size={16} />
      <span style={{ width: '8px' }} />
      <span style={{ color: 'var(--primary)', letterSpacing: '-0.07px' }}>{networkName(w.type, chainId)}</span>
      <span style={{ width: '8px' }} />
      <span style={{ width: '28px', height: '28px', borderRadius: '50%', background: 'var(--surface-container)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <MIcon name="chevronDown" size={18} color="var(--on-surface-variant)" />
      </span>
    </button>
  );
}

registerRoute(Routes.anyPayDecision, NetworkDecisionPage);
registerRoute(Routes.anyPaySwitchWallet, SwitchNetworkWalletPage);
