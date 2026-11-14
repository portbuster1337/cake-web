// NewHomePage (lib/new-ui/pages/home_page.dart).

import { accountAmount, accountLayout, openAccountsEducation, readyToManage } from './accounts.tsx';
import { NftListing } from './nfts.tsx';
import { isNftWallet } from '../../../nft/nfts.ts';
import { openBuySellSelector } from '../buy/buy.tsx';
import { buildCsv, csvFileName, type CsvItem } from '../../../app/csv.ts';
import { useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import { t } from '../../../core/i18n.ts';
import { Icon, Img, MIcon, ModernButton, TopBar, Spinner } from '../../components/core.tsx';
import { showSheet, toast } from '../../components/overlays.tsx';
import { currentWallet, walletLoading, walletError, torStatus } from '../../../app/app.ts';
import { settings, updateSettings } from '../../../app/settings.ts';
import { isSynced, syncStatusTitle, type WalletBase } from '../../../core/wallet.ts';
import { formatFixed } from '../../../core/amount.ts';
import { apiString, fiatValue, formatFiatAmount, prices, watchPrice } from '../../../app/prices.ts';
import { assetUrl, WALLET_TYPE_NAME } from '../../../coins/types.ts';
import { BalanceCard, CardChip, cardStyleKey, designFromStyle, storedCardStyle } from './cards.tsx';
import { HistoryList, historyItems, getTxNotes, txAsset, orderFilter, ordersForWallet, tradesForWallet, tradeFilter, tradeFilterCount, displayAllTrades, toggleAllTrades, resetTradeFilter, TRADE_FILTER_PROVIDERS, type HistoryItem } from './history.tsx';
import { nav } from '../../nav.ts';
import { Routes } from '../../routes.ts';
import { useEffect } from 'preact/hooks';
import { isTokenWallet } from '../../../coins/tokens.ts';
import { assetFiat, openAssetDetails, sortedAssets, TokenIcon, useAssetPrices } from '../tokens.tsx';

const SYNC_HEAVY = new Set(['monero', 'wownero', 'decred', 'zcash', 'zano']);
/** BalanceViewModel._hasAdditionalBalanceForWalletType: wallets with the "confirming" balance row */
const ADDITIONAL_BALANCE = new Set(['monero', 'wownero', 'zano', 'decred', 'zcash']);

/** SyncBar.failStatuses / progressStatuses (by exact status) */
const FAIL_STATUSES = new Set(['failed', 'lostConnection', 'timedOut', 'unsupported']);
const PROGRESS_STATUSES = new Set(['syncing', 'notConnected', 'synchronizing', 'attempting', 'startingScan', 'syncedTip', 'processing', 'connecting', 'connected']);

/** SyncStatus.progress() */
function statusProgress(s: WalletBase['syncStatus']['value']): number {
  if (s.kind === 'syncing') return s.progress;
  if (s.kind === 'processing') return 0.99;
  return s.kind === 'synced' || s.kind === 'syncedTip' ? 1 : 0;
}

/** ChainIcon: the coin's icon; for wallets that sync blocks, the progress ring around it (green while "Synced" shows) */
function ChainIcon({ w, heavy, showSynced }: { w: WalletBase; heavy: boolean; showSynced: boolean }) {
  const p = statusProgress(w.syncStatus.value);
  const done = !showSynced && (!heavy || p >= 1);
  const r = 17;
  const c = 2 * Math.PI * r;
  return (
    <div style={{ position: 'relative', width: '36px', height: '36px', flex: 'none' }} id="chain_icon">
      <svg width="36" height="36" style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)', opacity: done ? 0 : 1, transition: 'opacity 100ms' }} aria-hidden="true">
        <circle cx="18" cy="18" r={r} fill="none" stroke={showSynced ? '#12A439' : '#FFB84E'} stroke-width="2" stroke-dasharray={`${p * c} ${c}`} />
      </svg>
      <Icon src={(w.currency.flatIconPath ?? '').replace('assets/new-ui/', '') || 'balance_card_icons/bitcoin.svg'} size={36} color={done ? 'color-mix(in srgb, var(--primary) 20%, transparent)' : 'var(--primary)'} style={{ transform: done ? undefined : 'scale(0.8)', transition: 'transform 150ms' }} />
    </div>
  );
}

/** SyncBar: the full bar (wallets that sync blocks, failures, "Synced") or the compact one (Tor, a spinner, a check) */
function SyncBar({ w, heavy, showSynced }: { w: WalletBase; heavy: boolean; showSynced: boolean }) {
  const s = w.syncStatus.value;
  const tor = torStatus.value.state === 'ready';
  const fail = FAIL_STATUSES.has(s.kind);
  const progress = PROGRESS_STATUSES.has(s.kind);
  const showingSynced = showSynced && s.kind === 'synced';
  const full = s.kind === 'synced' ? heavy && showingSynced : heavy || fail;
  if (!full) {
    return (
      <span class="rowx" style={{ gap: '6px', flex: 'none' }} id="sync_bar_compact" role="status" aria-label={[tor ? t('tor_connection') : '', !heavy && progress ? t('synchronizing') : '', !heavy && showingSynced ? t('sync_synced') : ''].filter(Boolean).join(', ') || undefined}>
        {tor && <Img src="tor.svg" size={20} />}
        {!heavy && progress && <span class="spinner" style={{ width: '16px', height: '16px', color: 'var(--on-surface-variant)' }} />}
        {!heavy && showingSynced && <MIcon name="check" size={18} color="var(--sync-green)" />}
      </span>
    );
  }
  const icon = s.kind === 'synced' ? <MIcon name="check" size={12} color="var(--sync-green)" /> : s.kind === 'lostConnection' ? <Icon src="offline.svg" size={16} color="var(--error)" /> : fail ? <Icon src="warning.svg" size={16} color="var(--error)" /> : tor ? <Icon src="tor_sync.svg" size={16} color="var(--tor-purple)" /> : null;
  return (
    <button
      type="button"
      id="sync_bar"
      onClick={() => nav.push(Routes.manageNodes)}
      style={{ width: '100%', height: '36px', borderRadius: '9999px', padding: '0 12px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', fontSize: '12px', fontWeight: 400, cursor: 'pointer', border: progress || showingSynced ? '1px solid var(--surface-container-high)' : 0, background: fail ? 'color-mix(in srgb, var(--error-container) 25%, transparent)' : 'none', color: fail ? 'var(--error)' : s.kind === 'synced' ? 'var(--sync-green)' : 'var(--on-surface-variant)', minWidth: 0 }}
    >
      {icon}
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{syncStatusTitle(s, settings.value.syncStatusDisplayMode) || t('synchronizing')}</span>
    </button>
  );
}

/** TopBar (lib/new-ui/widgets/coins_page/top_bar_widget/top_bar.dart): "Synced" for 3 seconds; the bar takes the name's place while syncing */
function HomeTopBar({ w }: { w: WalletBase }) {
  const s = w.syncStatus.value;
  const heavy = SYNC_HEAVY.has(w.type);
  const [showSynced, setShowSynced] = useState(false);
  useEffect(() => {
    if (s.kind !== 'synced') {
      setShowSynced(false);
      return;
    }
    setShowSynced(true);
    const id = setTimeout(() => setShowSynced(false), 3000);
    return () => clearTimeout(id);
  }, [s.kind, w.id]);
  const replacesName = s.kind === 'synced' ? showSynced : heavy || PROGRESS_STATUSES.has(s.kind) || FAIL_STATUSES.has(s.kind);
  const tor = torStatus.value.state === 'ready';
  return (
    <div class="rowx gap12" style={{ padding: '10px 18px' }}>
      <ChainIcon w={w} heavy={heavy} showSynced={showSynced} />
      <div class="grow rowx" style={{ height: '36px', minWidth: 0 }}>
        {replacesName ? (
          <SyncBar w={w} heavy={heavy} showSynced={showSynced} />
        ) : (
          <>
            <span class="grow" style={{ fontSize: '16px', fontWeight: 500, color: 'var(--on-surface)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }} id="home_wallet_name">{w.name}</span>
            {tor && (
              <>
                <span style={{ width: '6px', flex: 'none' }} />
                <SyncBar w={w} heavy={heavy} showSynced={showSynced} />
              </>
            )}
          </>
        )}
      </div>
      <ModernButton svg="top-settings.svg" size={36} id="home_page_settings_button_key" label={t('settings_title')} onClick={() => nav.push(Routes.settings)} />
    </div>
  );
}

/** DashboardViewModel.confirmationProgress: the confirmations still awaited (Monero and Zano 10, Wownero 3) */
function confirmationProgress(w: WalletBase): number {
  const needed = w.type === 'monero' || w.type === 'zano' ? 10 : w.type === 'wownero' ? 3 : 0;
  if (!needed) return 1;
  let got = 0;
  let want = 0;
  for (const tx of w.transactions.value) {
    if (tx.confirmations >= needed) continue;
    got += tx.confirmations;
    want += needed;
  }
  return want ? got / want : 1;
}

/** CircularProgressIndicator(strokeWidth: 2, the track primary@50) */
function ProgressRing({ value, size = 20 }: { value: number; size?: number }) {
  const r = (size - 2) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="progressbar" aria-valuenow={Math.round(value * 100)} style={{ flex: 'none', transform: 'rotate(-90deg)' }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--primary)" stroke-opacity={50 / 255} stroke-width="2" />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--primary)" stroke-width="2" stroke-dasharray={`${c * Math.max(0, Math.min(1, value))} ${c}`} />
    </svg>
  );
}

/** the balance's text as MoneyText shows it (8 digits, zeros trimmed, sats for Bitcoin when asked) */
function moneyText(w: WalletBase, amount: bigint): string {
  if (w.type === 'bitcoin' && settings.value.displayAmountsInSatoshi) return `${amount} sats`;
  return `${formatFixed(amount, w.currency.decimals, { fractionDigits: 8 })} ${w.currency.title}`;
}

/** UnconfirmedBalanceWidget: the balance being confirmed, the confirmations' progress; a tap opens Cake's modal */
function UnconfirmedBalance({ w, amount }: { w: WalletBase; amount: bigint }) {
  const cur = w.currency;
  const open = () =>
    showSheet((close) => (
      <div class="col" style={{ gap: '20px', paddingBottom: '16px' }} id="unconfirmed_balance_modal">
        <TopBar title={t('balance_confirmation')} onClose={() => close()} />
        <div class="col" style={{ gap: '20px', padding: '0 16px', alignItems: 'center' }}>
          <span style={{ position: 'relative', width: '100px', height: '100px' }}>
            <Img src={cur.iconPath ?? undefined} size={100} />
            <span style={{ position: 'absolute', right: '-3px', bottom: '-3px', width: '36px', height: '36px', boxSizing: 'border-box', borderRadius: '12px', border: '3px solid var(--surface)', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <MIcon name="lock" size={24} color="#000" />
            </span>
          </span>
          <div style={{ fontSize: '16px', textAlign: 'center', whiteSpace: 'pre-line' }}>{`${formatFixed(amount, cur.decimals)} ${cur.title} ${t('balance_confirmation_desc_1')}\n\n${t('balance_confirmation_desc_2')}\n\n${t('balance_confirmation_desc_3')}`}</div>
          <button type="button" class="btn" style={{ width: '100%' }} onClick={() => close()}>{t('close')}</button>
        </div>
      </div>
    ));
  return (
    <button type="button" class="rowx gap12" id="unconfirmed_balance" onClick={() => void open()} style={{ marginTop: '12px', width: '100%', height: '48px', background: 'var(--surface-container)', borderRadius: '16px', border: 0, padding: '0 12px', color: 'var(--on-surface)', cursor: 'pointer' }}>
      <ProgressRing value={confirmationProgress(w)} />
      <span class="rowx grow" style={{ gap: '4px' }}>
        <span style={{ color: 'var(--primary)' }}>{moneyText(w, amount)}</span>
        <span>{t('confirming')}</span>
      </span>
      <MIcon name="chevronRight" color="var(--on-surface-variant)" />
    </button>
  );
}

function CoinActionButton({ icon, label, onClick, id }: { icon: string; label: string; onClick: () => void; id?: string }) {
  return (
    <button type="button" id={id} onClick={onClick} class="col" style={{ alignItems: 'center', gap: '8px', background: 'none', border: 0, cursor: 'pointer', padding: 0 }}>
      <span style={{ width: 'min(16vw, 72px)', height: 'min(16vw, 72px)', maxWidth: '72px', maxHeight: '72px', minWidth: '58px', minHeight: '58px', borderRadius: '50%', background: 'linear-gradient(to bottom, var(--card-gradient-primary), var(--card-gradient-secondary))', border: '1px solid var(--surface-container-high)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary)' }}>
        <Icon src={icon} size={32} />
      </span>
      <span style={{ fontSize: '12px', color: 'var(--on-surface-variant)' }}>{label}</span>
    </button>
  );
}

export function HomePage() {
  const w = currentWallet.value;
  const s = settings.value;
  if (!w) {
    const loading = walletLoading.value;
    return (
      <div class="page" id="home_page">
        <div class="page-body" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: '16px' }}>
          {loading ? (
            <>
              <Spinner large />
              <div class="muted">{t('wallet_list_loading_wallet', { wallet_name: loading })}</div>
            </>
          ) : (
            <div class="muted center" style={{ padding: '24px' }}>{walletError.value ?? t('wallet_list_empty') ?? ''}</div>
          )}
        </div>
      </div>
    );
  }
  return <WalletHome w={w} />;
}

/** AccountsPromo: Cake's card announcing Bitcoin accounts (the education, then the accounts page), until dismissed */
function AccountsPromo({ w }: { w: WalletBase }) {
  const open = async () => {
    if (!(await readyToManage(w))) return;
    await openAccountsEducation();
    updateSettings((x) => ({ dismissedPromos: { ...x.dismissedPromos, education_accounts: true } }));
    nav.push(Routes.walletAccountsPage);
  };
  return (
    <div class="col" style={{ padding: '0 16px', alignItems: 'center', gap: '12px' }} id="accounts_promo">
      <button type="button" class="rowx" onClick={() => void open()} style={{ width: '100%', minHeight: '64px', gap: '12px', padding: '10px 12px', borderRadius: '18px', border: '1px solid var(--outline-variant)', background: 'var(--surface-container)', color: 'var(--on-surface)', cursor: 'pointer', textAlign: 'start' }}>
        <Img src="assets/new-ui/settings_row_icons/accounts.svg" size={24} />
        <span class="col grow" style={{ gap: '2px', minWidth: 0 }}>
          <span style={{ fontWeight: 500 }}>{t('accounts_home_promo_title', { walletName: WALLET_TYPE_NAME[w.type] })}</span>
          <span class="muted" style={{ fontSize: '12px' }}>{t('accounts_home_promo_description')}</span>
        </span>
        <MIcon name="chevronRight" size={16} color="var(--primary)" />
      </button>
      <button type="button" id="accounts_promo_dismiss" onClick={() => updateSettings((x) => ({ dismissedPromos: { ...x.dismissedPromos, accounts_home: true } }))} style={{ border: 0, background: 'none', padding: '4px 8px', color: 'var(--primary)', fontSize: '12px', fontWeight: 500, cursor: 'pointer' }}>{t('do_not_show_anymore')}</button>
    </div>
  );
}

/**
 * CardsView: the visible accounts' cards stacked, the selected one in front and the others behind it in the deck's
 * order (turning around), each 46 px higher and 4 % smaller; from four cards on 5 px apart, unscaled, and a tap
 * opens the accounts page. A card behind shows its account's balance; tapping it selects that account.
 */
function AccountCardStack({ w, order, amount, asset, fiat, hidden, onLongPress }: { w: WalletBase; order: number[]; amount: string; asset: string; fiat?: string; hidden: boolean; onLongPress: () => void }) {
  const s = settings.value;
  const n = order.length;
  const cur = w.currentAccount.value;
  const selected = order.includes(cur) ? order.indexOf(cur) : n - 1;
  // loadCardDesigns: a selected account that is archived gives way to the front card's
  useEffect(() => {
    if (!order.includes(cur) && accountLayout(w).hidden.includes(cur)) void (w as { setAccount?: (i: number) => Promise<void> }).setAccount?.(order[n - 1]);
  }, [cur, order.join(',')]);
  const compact = n >= 4;
  const overlap = compact ? 5 : 46;
  const scaleStep = compact ? 1 : 0.96;
  const byIndex = new Map(w.accounts.value.map((a) => [a.index, a]));
  const openAccounts = async () => {
    if (await readyToManage(w)) nav.push(Routes.walletAccountsPage);
  };
  return (
    <div style={{ position: 'relative', width: '100%', maxWidth: '380px', paddingTop: `${overlap * (n - 1)}px`, transition: 'padding-top 200ms ease-out' }} id="home_card_stack">
      <div style={{ aspectRatio: '1 / 0.62' }} />
      {order.map((account, visual) => {
        const behind = (selected - visual + n) % n;
        // CardsView draws the selected card and at most five behind it
        if (behind > 5) return null;
        const a = byIndex.get(account);
        const front = behind === 0;
        const design = designFromStyle(storedCardStyle(s.cardDesigns, `${w.id}:${account}`), w.currency.key);
        const tap = compact ? () => void openAccounts() : front ? undefined : () => void (w as { setAccount?: (i: number) => Promise<void> }).setAccount?.(account);
        return (
          <div key={account} id={`home_account_card_${account}`} style={{ position: 'absolute', left: 0, right: 0, top: `${overlap * (n - 1) - behind * overlap}px`, transform: `scale(${scaleStep ** behind})`, zIndex: 10 - behind, transition: 'top 200ms ease-out, transform 200ms ease-out', cursor: tap ? 'pointer' : undefined }}>
            <BalanceCard
              design={design}
              label={a?.label ?? ''}
              amount={front ? amount : ''}
              asset={front ? asset : ''}
              fiat={front ? fiat : undefined}
              hidden={hidden}
              selected={front}
              id={front ? 'balance_card' : `balance_card_${account}`}
              accountBalance={accountAmount(w, a?.balance ?? 0n).amount}
              onClick={tap}
              onLongPress={front ? onLongPress : undefined}
              onMenu={front ? () => nav.push(Routes.cardCustomizer, { account }) : undefined}
              chips={front && !s.disableTradeOption ? <CardChip label={t('buy')} combo={design.combo} onClick={() => void openBuySellSelector()} /> : undefined}
            />
          </div>
        );
      })}
    </div>
  );
}

function WalletHome({ w }: { w: WalletBase }) {
  const s = settings.value;
  const cur = w.currency;
  const api = apiString(cur);
  useEffect(() => watchPrice(api), [api]);
  useAssetPrices(w);
  void prices.value;
  const bal = w.balances.value[cur.key] ?? { available: 0n, full: 0n, pending: 0n };
  const hidden = s.balanceDisplayMode === 'hiddenBalance';
  const sats = w.type === 'bitcoin' && s.displayAmountsInSatoshi;
  const shown = s.balanceDisplayMode === 'fullBalance' ? bal.full : bal.available;
  // token wallets: the combined fiat balance (default), or the favorite token (cards_view.dart, balance_view_model.dart)
  const tokenW = isTokenWallet(w) ? w : null;
  const assets = tokenW ? tokenW.assetList() : [];
  const combined = !!tokenW && assets.length > 1 && (s.showCombinedBalance[w.id] ?? true);
  const fav = tokenW && !combined ? assets.find((a) => a.address && a.address === s.favoriteToken[w.id]) : undefined;
  let amountStr: string;
  let assetStr: string;
  let fiatStr: string | undefined;
  if (combined) {
    amountStr = assets.reduce((sum, a) => sum + assetFiat(a), 0).toFixed(2);
    assetStr = s.fiatCurrency;
    fiatStr = ' ';
  } else if (fav) {
    amountStr = formatFixed(fav.balance, fav.decimals, { fractionDigits: Math.min(fav.decimals, 8) });
    assetStr = fav.symbol.toUpperCase();
    fiatStr = s.fiatApiMode === 'disabled' ? undefined : `${s.fiatCurrency} ${formatFiatAmount(assetFiat(fav))}`;
  } else {
    amountStr = sats ? shown.toString() : formatFixed(shown, cur.decimals, { fractionDigits: Math.min(cur.decimals, 8) });
    assetStr = sats ? 'sats' : cur.title.toUpperCase();
    const fiat = fiatValue(Number(formatFixed(shown, cur.decimals)), api);
    fiatStr = s.fiatApiMode === 'disabled' ? undefined : `${s.fiatCurrency} ${formatFiatAmount(fiat ?? 0)}`;
  }
  const design = designFromStyle(storedCardStyle(s.cardDesigns, cardStyleKey(w)), cur.key);
  // CardsView: with accounts on, the visible accounts' cards (one card otherwise)
  const stack = w.isMultiAccountsEnabled && !combined && !fav ? accountLayout(w).visible : [];
  const txs = w.transactions.value;
  const pending = ADDITIONAL_BALANCE.has(w.type) ? bal.pending ?? 0n : 0n;
  // shouldShowSeedBackupReminder: a new recovery phrase not backed up yet, and some balance (any asset)
  const reminderFlag = (w.info as { showSeedBackupReminder?: boolean; isRecovery?: boolean }).showSeedBackupReminder ?? !(w.info as { isRecovery?: boolean }).isRecovery;
  const hasBalance = Object.values(w.balances.value).some((b) => b.available > 0n || b.full > 0n || (b.pending ?? 0n) > 0n);
  const showReminder = reminderFlag && !s.seedBackedUp[w.id] && !!w.seed && hasBalance;
  const toggleHidden = () => {
    updateSettings((x) => ({ balanceDisplayMode: x.balanceDisplayMode === 'hiddenBalance' ? 'availableBalance' : 'hiddenBalance', hiddenBalanceToggles: x.hiddenBalanceToggles + 1 }));
  };
  return (
    <div class="page" id="home_page">
      <div class="page-body" style={{ paddingBottom: '120px' }}>
        <div class="col" style={{ gap: '24px' }}>
          <HomeTopBar w={w} />
          <div class="col" style={{ alignItems: 'center', padding: '0 6%' }}>
            {stack.length > 1 ? (
              <AccountCardStack w={w} order={stack} amount={amountStr} asset={assetStr} fiat={fiatStr} hidden={hidden} onLongPress={toggleHidden} />
            ) : (
              <BalanceCard
                design={design}
                label={combined ? t('wallet_balance') : (w.isMultiAccountsEnabled ? w.accounts.value.find((a) => a.index === w.currentAccount.value)?.label : undefined) ?? t('balance')}
                labelDim={combined}
                amount={amountStr}
                asset={assetStr}
                fiat={fiatStr}
                hidden={hidden}
                onLongPress={toggleHidden}
                onMenu={() => nav.push(Routes.cardCustomizer, w.isMultiAccountsEnabled ? { account: w.currentAccount.value } : undefined)}
                chips={!s.disableTradeOption ? <CardChip label={t('buy')} combo={design.combo} onClick={() => void openBuySellSelector()} /> : undefined}
              />
            )}
            {hidden && s.hiddenBalanceToggles < 10 && <div class="muted" style={{ marginTop: '12px' }}>{t('long_press_show_balance')}</div>}
            {pending > 0n && !hidden && <UnconfirmedBalance w={w} amount={pending} />}
            {showReminder && (
              <button type="button" class="rowx gap12" onClick={() => nav.push(Routes.seedBackupReminderPage, { walletId: w.id })} id="seed_backup_reminder_card" style={{ marginTop: '24px', width: '100%', background: 'var(--surface-container)', borderRadius: '20px', border: 0, padding: '12px', color: 'var(--on-surface)', cursor: 'pointer', textAlign: 'start' }}>
                <Icon src="key.svg" size={24} color="var(--primary)" />
                <span class="grow col" style={{ gap: '4px' }}>
                  <span style={{ fontWeight: 500 }}>{t('back_up_recovery_phrase')}</span>
                  <span class="muted" style={{ fontSize: '12px' }}>{t('back_up_recovery_phrase_description')}</span>
                </span>
                <MIcon name="chevronRight" size={16} color="var(--on-surface-variant)" />
              </button>
            )}
          </div>
          {/* AccountsPromo: Bitcoin wallets that can have accounts */}
          {w.type === 'bitcoin' && w.hasAccountsSupport && !s.dismissedPromos.accounts_home && <AccountsPromo w={w} />}
          <div class="rowx" style={{ justifyContent: 'center', gap: '5%', padding: '0 18px' }}>
            <CoinActionButton icon="send.svg" label={t('send')} id="home_send" onClick={() => nav.push(Routes.send)} />
            <CoinActionButton icon="receive.svg" label={t('receive')} id="home_receive" onClick={() => nav.push(Routes.receive)} />
            {s.exchangeStatus !== 'disabled' && <CoinActionButton icon="exchange.svg" label={t('swap')} id="home_swap" onClick={() => nav.push(Routes.exchange)} />}
            <CoinActionButton icon="scan.svg" label={t('scan')} id="home_scan" onClick={() => nav.push('/scan', { mode: 'home' })} />
          </div>
        </div>
        <AssetsHistory w={w} hidden={hidden} txs={txs} />
      </div>
    </div>
  );
}

type HomeTab = 'assets' | 'history' | 'nfts';

/** AssetsHistorySection: Assets (wallets with tokens), History, NFTs (isNFTACtivatedChain); one tab shows the History bar */
function AssetsHistory({ w, txs, hidden }: { w: WalletBase; txs: ReturnType<WalletBase['transactions']['peek']>; hidden: boolean }) {
  const hasAssets = w.hasTokens;
  const tabs: HomeTab[] = [...(hasAssets ? (['assets'] as const) : []), 'history', ...(isNftWallet(w) ? (['nfts'] as const) : [])];
  // reloadTabs: a different number of tabs starts again at the first
  const [sel, setSel] = useState<{ n: number; tab: HomeTab }>({ n: tabs.length, tab: tabs[0] });
  const tab = sel.n === tabs.length && tabs.includes(sel.tab) ? sel.tab : tabs[0];
  const setTab = (next: HomeTab) => setSel({ n: tabs.length, tab: next });
  // DashboardViewModel.itemsShort: the first 3 items, swaps included
  const short = historyItems(w, txs).slice(0, 3);
  const syncing = !isSynced(w.syncStatus.value);
  const label: Record<HomeTab, string> = { assets: t('assets'), history: t('history'), nfts: t('nfts') };
  const multi = tabs.length > 1;
  return (
    <div style={{ padding: '20px 16px 0' }}>
      {multi ? (
        <div class="rowx" style={{ justifyContent: 'space-between', padding: '0 2px 18px 0', minHeight: '40px' }}>
          <div class="tabs-line">
            {tabs.map((k) => <button type="button" class={tab === k ? 'on' : ''} id={`home_tab_${k}`} onClick={() => setTab(k)}>{label[k]}</button>)}
          </div>
          {tab === 'assets' ? (
            <button type="button" class="pill" style={{ height: '40px' }} id="assets_tokens" onClick={() => nav.push(Routes.homeSettings)}>
              {t('tokens')} <Icon src="options_slider.svg" size={16} color="var(--primary)" />
            </button>
          ) : tab === 'history' ? (
            <button type="button" class="pill" style={{ height: '40px' }} onClick={() => openHistoryModal(w)} id="history_all">
              {t('all_pascal_case')} <Icon src="arrow_right.svg" w={7} h={12} color="var(--primary)" />
            </button>
          ) : (
            <span style={{ height: '40px' }} />
          )}
        </div>
      ) : (
        <button type="button" class="rowx" onClick={() => openHistoryModal(w)} id="history_top_bar" style={{ width: '100%', border: 0, cursor: 'pointer', color: 'var(--on-surface)', background: 'var(--surface-container)', borderRadius: short.length ? '18px 18px 0 0' : '18px', padding: '14px 12px', justifyContent: 'space-between', borderBottom: short.length ? '1px solid color-mix(in srgb, var(--outline-variant) 69%, transparent)' : 0 }}>
          <span>{t('history')}</span>
          <Icon src="arrow_right.svg" w={7} h={12} color="var(--on-surface-variant)" />
        </button>
      )}
      {tab === 'assets' ? (
        <AssetsList w={w} hidden={hidden} />
      ) : tab === 'nfts' ? (
        <NftListing w={w} />
      ) : short.length ? (
        <div style={multi ? undefined : { marginTop: '-1px' }}>
          <HistoryListJoined w={w} txs={short} hidden={hidden} joined={!multi} />
        </div>
      ) : (
        !syncing && <div class="muted center" style={{ paddingTop: '24px' }} id="no_transactions">{t('transactions_will_appear_here')}</div>
      )}
    </div>
  );
}

function HistoryListJoined({ w, txs, hidden, joined }: { w: WalletBase; txs: HistoryItem[]; hidden: boolean; joined: boolean }) {
  return (
    <div class="col" style={joined ? { borderRadius: '0 0 22px 22px', overflow: 'hidden' } : undefined}>
      <HistoryList w={w} txs={[]} items={txs} hidden={hidden} />
    </div>
  );
}

function AssetsList({ w, hidden }: { w: WalletBase; hidden: boolean }) {
  if (!isTokenWallet(w)) return null;
  const list = sortedAssets(w);
  const fiatOn = settings.value.fiatApiMode !== 'disabled';
  return (
    <div class="col" style={{ padding: '0 2px 64px' }} id="assets_list">
      {list.map((a, i) => (
        <button type="button" class="rowx" id={`asset_${a.symbol}`} onClick={() => void openAssetDetails(w, a)} style={{ minHeight: '72px', width: '100%', gap: '12px', padding: '0 12px', border: 0, cursor: 'pointer', color: 'var(--on-surface)', textAlign: 'start', background: 'var(--surface-container)', borderTopLeftRadius: i === 0 ? '18px' : 0, borderTopRightRadius: i === 0 ? '18px' : 0, borderBottomLeftRadius: i === list.length - 1 ? '18px' : 0, borderBottomRightRadius: i === list.length - 1 ? '18px' : 0, borderTop: i ? '1px solid var(--surface-container-high)' : 0 }}>
          <TokenIcon icon={a.icon} symbol={a.symbol} size={36} />
          <span class="grow col" style={{ gap: '4px', minWidth: 0 }}>
            <span style={{ fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.name}</span>
            <span class="muted">{hidden ? '●●●●●●' : `${formatFixed(a.balance, a.decimals, { fractionDigits: Math.min(a.decimals, 8) })} ${a.symbol.slice(0, 6)}`}</span>
          </span>
          {fiatOn && <span>{hidden ? '●●●●●' : `${settings.value.fiatCurrency} ${formatFiatAmount(assetFiat(a))}`}</span>}
        </button>
      ))}
    </div>
  );
}

export function openHistoryModal(w: WalletBase) {
  return showSheet((close) => <HistoryModal w={w} close={close} />, { full: true });
}

const historyFilter = signal({ send: true, receive: true });

function HistoryFilters({ close }: { close: () => void }) {
  const [providers, setProviders] = useState(false);
  const f = historyFilter.value;
  const set = (p: Partial<typeof f>) => (historyFilter.value = { ...historyFilter.value, ...p });
  const count = tradeFilterCount();
  const swapOn = count > 0;
  const check = (on: boolean) => <span class={`check${on ? ' on' : ''}`}>{on && <MIcon name="check" size={18} />}</span>;
  if (providers) {
    // HistorySwapProvidersPage
    const tf = tradeFilter.value;
    return (
      <div style={{ padding: '0 18px 24px' }} id="history_swap_providers">
        <TopBar title={t('filter_swap_providers')} onBack={() => setProviders(false)} />
        <div class="rowx" style={{ justifyContent: 'space-between', padding: '0 4px 12px' }}>
          <span class="muted">{t('swap_providers')}</span>
          <button type="button" class="link-btn" style={{ width: 'auto', minHeight: 0 }} onClick={toggleAllTrades}>{displayAllTrades() ? t('unselect_all') : t('select_all')}</button>
        </div>
        <div class="list">
          {TRADE_FILTER_PROVIDERS.map((p) => (
            <div class="row tap" onClick={() => (tradeFilter.value = { ...tradeFilter.value, [p.raw]: !tf[p.raw] })}><span class="lbl">{p.title}</span>{check(!!tf[p.raw])}</div>
          ))}
        </div>
      </div>
    );
  }
  const allTypes = f.send && f.receive && displayAllTrades() && orderFilter.value;
  return (
    <div style={{ padding: '0 18px 24px' }}>
      <TopBar title={t('filters')} onBack={close} />
      <div class="rowx" style={{ justifyContent: 'space-between', padding: '0 4px 12px' }}>
        <span class="muted">{t('type')}</span>
        <button type="button" class="link-btn" style={{ width: 'auto', minHeight: 0 }} onClick={() => {
          const on = !allTypes;
          set({ send: on, receive: on });
          if (displayAllTrades() !== on) toggleAllTrades();
          orderFilter.value = on;
        }}>{allTypes ? t('unselect_all') : t('select_all')}</button>
      </div>
      <div class="list">
        <div class="row tap" onClick={() => set({ send: !f.send })}><span class="lbl">{t('send')}</span>{check(f.send)}</div>
        <div class="row tap" onClick={() => set({ receive: !f.receive })}><span class="lbl">{t('receive')}</span>{check(f.receive)}</div>
        <div class="row tap" id="history_filter_swap" onClick={() => setProviders(true)}>
          <span class="lbl">
            <span>{t('swap')}</span>
            <span class="sub" style={{ color: displayAllTrades() ? undefined : count === 0 ? '#FFB84E' : 'var(--primary)' }}>{displayAllTrades() ? t('manage_providers') : count === 0 ? t('no_providers_selected') : `${count} ${t('providers')}`}</span>
          </span>
          <span onClick={(e) => { e.stopPropagation(); toggleAllTrades(); }}>{check(swapOn)}</span>
          <Icon src="arrow_forward.svg" w={8} h={14} color="var(--on-surface-variant)" />
        </div>
        <div class="row tap" id="history_filter_cake_pay" onClick={() => (orderFilter.value = !orderFilter.value)}><span class="lbl">Cake Pay</span>{check(orderFilter.value)}</div>
      </div>
      <div style={{ height: '18px' }} />
      <button type="button" class="btn secondary" onClick={() => { historyFilter.value = { send: true, receive: true }; resetTradeFilter(); orderFilter.value = true; close(); }}>{t('reset_filters')}</button>
    </div>
  );
}

function HistoryModal({ w, close }: { w: WalletBase; close: () => void }) {
  useEffect(() => () => {
    historyFilter.value = { send: true, receive: true };
    resetTradeFilter();
    orderFilter.value = true;
  }, []);
  const filter = historyFilter.value;
  const txs = w.transactions.value.filter((x) => (x.direction === 'incoming' ? filter.receive : filter.send));
  // CsvExportService.exportToCsv: the list as filtered, transactions and swaps
  const exportCsv = async () => {
    const items = historyItems(w, txs);
    if (!items.length) {
      toast(t('csv_nothing_to_export'));
      return;
    }
    const notes = await getTxNotes(w.id);
    const rows: CsvItem[] = items.map((it) => {
      if (it.kind !== 'tx') return it;
      const a = txAsset(w, it.tx);
      return { kind: 'tx', tx: it.tx, amount: formatFixed(it.tx.amount, a.decimals), symbol: a.symbol, note: notes[it.tx.id] ?? '' };
    });
    const a = document.createElement('a');
    const url = URL.createObjectURL(new Blob([buildCsv(w, rows)], { type: 'text/csv' }));
    a.href = url;
    a.download = csvFileName();
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  return (
    <div class="col" style={{ height: '100%', background: 'var(--surface)' }} id="history_modal">
      <TopBar title={t('history')} onClose={close} trailing={<ModernButton svg="tx_export.svg" size={36} label={t('export_csv')} onClick={exportCsv} />} />
      <div class="page-body" style={{ padding: '0 16px 144px' }}>
        {txs.length || tradesForWallet(w).length || ordersForWallet(w).length ? <HistoryList w={w} txs={txs} grouped hidden={settings.value.balanceDisplayMode === 'hiddenBalance'} /> : <div class="muted center" style={{ paddingTop: '24px' }}>{t('transactions_will_appear_here')}</div>}
      </div>
      <div style={{ position: 'absolute', left: '12px', right: '12px', bottom: '24px' }}>
        <button
          type="button"
          class="rowx gap8"
          style={{ width: '100%', height: '56px', borderRadius: '18px', background: 'var(--surface-container)', border: '1px solid var(--primary)', color: 'var(--primary)', justifyContent: 'center', fontWeight: 500, cursor: 'pointer' }}
          id="history_filters_button"
          onClick={() => showSheet((c2) => <HistoryFilters close={() => c2()} />)}
        >
          <Icon src="filter_options.svg" size={20} />
          {t('filters')}
        </button>
      </div>
    </div>
  );
}
