// Token management for EVM / Solana / Tron wallets: Home screen settings
// (lib/src/screens/dashboard/home_settings_page.dart), Add / Edit token
// (edit_token_page.dart), Favorite token modal (favorite_token_modal.dart)
// and the new-UI Asset details sheet (assets_history/asset_details_modal.dart).

import { isUsdt0Token } from '../../integrations/usdt0.ts';
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../core/i18n.ts';
import { Button, Check, Field, Icon, Img, MIcon, ModernButton, Page, Row, Section, Switch, ToggleRow, TopBar } from '../components/core.tsx';
import { confirmAlert, showAlert, showSheet } from '../components/overlays.tsx';
import { registerRoute, Routes } from '../routes.ts';
import { nav } from '../nav.ts';
import { currentWallet } from '../../app/app.ts';
import { settings, updateSettings } from '../../app/settings.ts';
import { fiatValue, formatFiatAmount, prices, watchPrice } from '../../app/prices.ts';
import { formatFixed } from '../../core/amount.ts';
import { WALLET_TYPE_NAME } from '../../coins/types.ts';
import { isTokenWallet, normalizeHomoglyphs, type TokenAsset, type TokenWallet, type WalletToken } from '../../coins/tokens.ts';
import { pickOption } from './newWallet.tsx';
import type { WalletBase } from '../../core/wallet.ts';

const SORT_LABELS = () => [t('fiat_balance'), t('gross_balance'), t('alphabetical')];

export function TokenIcon({ icon, symbol, size }: { icon?: string; symbol: string; size: number }) {
  if (icon) return <Img src={icon} size={size} round />;
  return <span style={{ width: `${size}px`, height: `${size}px`, borderRadius: '50%', background: 'var(--primary)', color: 'var(--on-primary)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: `${Math.round(size * 0.45)}px`, flex: 'none' }}>{symbol.slice(0, 2)}</span>;
}

export function networkIcon(w: WalletBase): string {
  return w.type === 'robinhood' ? 'assets/new-ui/crypto_full_icons/robinhood.svg' : `assets/new-ui/network_icons/${w.type.toLowerCase()}.svg`;
}

/** fiat value of an asset; potential-scam tokens are worth nothing (balance_view_model.dart) */
export function assetFiat(a: TokenAsset): number {
  if (a.isPotentialScam) return 0;
  return fiatValue(Number(formatFixed(a.balance, a.decimals)), a.api) ?? 0;
}

/** BalanceViewModel.formattedBalances order */
export function sortedAssets(w: WalletBase & TokenWallet): TokenAsset[] {
  void prices.value;
  const by = settings.value.sortBalanceBy;
  return [...w.assetList()].sort((a, b) => {
    if (a.isNative !== b.isNative) return a.isNative ? -1 : 1;
    const ab = a.balance > 0n;
    const bb = b.balance > 0n;
    if (!a.isNative && !b.isNative && ab !== bb) return ab ? -1 : 1;
    if (by === 0) return assetFiat(b) - assetFiat(a);
    if (by === 1) return Number(formatFixed(b.balance, b.decimals)) - Number(formatFixed(a.balance, a.decimals));
    return a.symbol.toUpperCase().localeCompare(b.symbol.toUpperCase());
  });
}

/** keep the prices of the wallet's (non-scam) assets fresh */
export function useAssetPrices(w: WalletBase | null): void {
  const list = w && isTokenWallet(w) ? w.assetList().filter((a) => !a.isPotentialScam).map((a) => a.api) : [];
  const key = list.join(',');
  useEffect(() => {
    for (const api of list) watchPrice(api);
  }, [key]);
}

// --------------------------------------------------------- home settings --

function HomeSettingsPage() {
  const w = currentWallet.value;
  const [q, setQ] = useState('');
  if (!w || !isTokenWallet(w)) return null;
  const s = settings.value;
  const combined = s.showCombinedBalance[w.id] ?? true;
  const fav = s.favoriteToken[w.id] ?? null;
  const favAsset = w.assetList().find((a) => (fav ? a.address === fav : a.isNative));
  const order = new Map(sortedAssets(w).map((a, i) => [a.address ?? '', i]));
  const ql = q.trim().toLowerCase();
  const list = w.tokens
    .filter((x) => !ql || x.name.toLowerCase().includes(ql) || x.symbol.toLowerCase().includes(ql) || x.address.toLowerCase() === ql)
    .sort((a, b) => (a.enabled !== b.enabled ? (a.enabled ? -1 : 1) : a.enabled ? (order.get(a.address) ?? 0) - (order.get(b.address) ?? 0) : a.name.localeCompare(b.name)));
  return (
    <Page title={t('home_screen_settings')} legacy id="home_settings_page" bodyClass="">
      <div style={{ padding: '12px' }}>
        <Section>
          <Row label={t('sort_by')} trailingText={SORT_LABELS()[s.sortBalanceBy]} id="home_settings_sort" onClick={async () => {
            const v = await pickOption(t('sort_by'), SORT_LABELS().map((l, i) => ({ id: String(i), label: l })), String(s.sortBalanceBy));
            if (v !== undefined) updateSettings({ sortBalanceBy: Number(v) as 0 | 1 | 2 });
          }} />
          <ToggleRow label={t('show_combined_balance')} value={combined} id="home_settings_combined" onChange={(v) => updateSettings((x) => ({ showCombinedBalance: { ...x.showCombinedBalance, [w.id]: v } }))} />
          {!combined && (
            <Row label={t('favorite_token')} trailingText={favAsset?.symbol ?? w.currency.title} arrow onClick={async () => {
              const r = await pickFavorite(w);
              if (r !== undefined) updateSettings((x) => ({ favoriteToken: { ...x.favoriteToken, [w.id]: r } }));
            }} />
          )}
        </Section>
      </div>
      <div style={{ height: '1px', background: 'var(--outline-variant)' }} />
      <div class="rowx gap8" style={{ padding: '20px 16px 0' }}>
        <div class="search grow">
          <MIcon name="search" size={20} color="var(--on-surface-variant)" />
          <input placeholder={t('search_add_token')} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} id="home_settings_search" />
        </div>
        <ModernButton icon="add" size={46} iconSize={22} label={t('add_token')} id="home_settings_add_token" onClick={() => nav.push(Routes.editToken, w.validateTokenAddress(q.trim()) ? { contractAddress: q.trim() } : {})} />
      </div>
      <div class="col" style={{ padding: '0 16px 32px' }}>
        {list.map((x) => (
          <div class="row tap" style={{ marginTop: '16px', borderRadius: '16px', background: 'var(--surface-container)' }} onClick={() => nav.push(Routes.editToken, { token: x })} id={`token_${x.symbol}`}>
            <TokenIcon icon={x.isPotentialScam ? undefined : x.icon} symbol={x.symbol} size={28} />
            <span class="lbl">{`${x.name} (${x.symbol.toUpperCase()})`}</span>
            <span onClick={(e) => e.stopPropagation()}>
              <Switch value={x.enabled} onChange={(v) => void w.setTokenEnabled(x.address, v)} id={`token_switch_${x.symbol}`} />
            </span>
          </div>
        ))}
      </div>
    </Page>
  );
}

/** resolves the favorite token's address, or null for the native coin */
function pickFavorite(w: WalletBase & TokenWallet): Promise<string | null | undefined> {
  return showSheet<string | null>((close) => (
    <div class="col" style={{ maxHeight: '80vh' }}>
      <TopBar title={t('favorite_token')} onClose={() => close(undefined)} />
      <div class="muted center" style={{ padding: '0 24px' }}>{t('favorite_token_desc')}</div>
      <div class="page-body" style={{ padding: '12px' }}>
        <Section>
          {w.assetList().map((a) => <Row label={`${a.name} (${a.symbol})`} image={a.icon} onClick={() => close(a.address ?? null)} />)}
        </Section>
      </div>
    </div>
  ));
}

// ------------------------------------------------------------ edit token --

function EditTokenPage({ args }: { args?: { token?: WalletToken; contractAddress?: string } }) {
  const w = currentWallet.value;
  const ex = args?.token;
  const editing = !!ex;
  const [address, setAddress] = useState(ex?.address ?? args?.contractAddress ?? '');
  const [name, setName] = useState(ex?.name ?? '');
  const [symbol, setSymbol] = useState(ex?.symbol.toUpperCase() ?? '');
  const [decimals, setDecimals] = useState(ex ? String(ex.decimals) : '');
  const [icon, setIcon] = useState(ex?.icon ?? '');
  const [disclaimer, setDisclaimer] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errs, setErrs] = useState<Record<string, string | null>>({});
  // _checkIfTokenIsVerifiedOnJupiter: remembered per address, so an edited address loses it
  const [jupiter, setJupiter] = useState<string | null>(null);
  useEffect(() => {
    const a = address.trim();
    if (!w || !isTokenWallet(w) || !w.isVerifiedToken || !a || !w.validateTokenAddress(a)) return;
    let alive = true;
    const id = setTimeout(() => void w.isVerifiedToken!(a).then((ok) => alive && ok && setJupiter(a)), 400);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [address]);
  useEffect(() => {
    if (!editing && args?.contractAddress) {
      setDisclaimer(true);
      void fill(args.contractAddress);
    }
  }, []);
  if (!w || !isTokenWallet(w)) return null;
  const jupiterVerified = !!address.trim() && jupiter === address.trim();
  const verified = (!!address && w.isDefaultToken(address)) || jupiterVerified;
  async function fill(a: string) {
    if (!w || !isTokenWallet(w) || !a.trim() || !w.validateTokenAddress(a.trim())) return;
    const info = await w.tokenInfo(a.trim()).catch(() => null);
    if (!info) return;
    setName((v) => v || info.name);
    setSymbol((v) => v || info.symbol);
    setDecimals((v) => v || String(info.decimals));
    if (info.icon) setIcon((v) => v || info.icon!);
  }
  const onAddress = (v: string) => {
    setAddress(v);
    if (v.trim() && v.trim() !== ex?.address) setDisclaimer(true);
  };
  const validate = (): boolean => {
    const e: Record<string, string | null> = {};
    e.address = !address.trim() ? t('field_required') : w.validateTokenAddress(address.trim()) ? null : t('error_text_address');
    e.name = name.trim() ? null : t('field_required');
    e.symbol = symbol.trim() ? null : t('field_required');
    e.decimals = !decimals.trim() ? t('field_required') : !/^\d+$/.test(decimals.trim()) ? t('invalid_input') : Number(decimals) === 0 ? t('decimals_cannot_be_zero') : null;
    setErrs(e);
    return !Object.values(e).some(Boolean);
  };
  const save = async () => {
    if (!validate() || (disclaimer && !checked)) return;
    const a = address.trim();
    if (!editing && w.tokens.some((x) => x.address.toLowerCase() === a.toLowerCase())) {
      await showAlert({ title: t('warning'), content: t('token_already_exists') });
      return;
    }
    setBusy(true);
    try {
      const trusted = w.isDefaultToken(a) || jupiter === a;
      const risky = !trusted && (await w.checkContractRisk(a));
      const sym = normalizeHomoglyphs(symbol.trim().toUpperCase());
      const scam = risky || (!trusted && (sym === w.currency.title.toUpperCase() || w.isSuspiciousToken({ name: name.trim(), symbol: symbol.trim(), address: a })));
      if (risky && !(await confirmAlert(t('warning'), t('contract_warning'), t('continue_text'), t('cancel')))) return;
      await w.addToken({ address: a, name: name.trim(), symbol: symbol.trim().toUpperCase(), decimals: Number(decimals), enabled: ex?.enabled ?? true, icon: icon.trim() || undefined, isPotentialScam: scam, groups: ex?.groups, mint: ex?.mint });
      nav.pop();
    } catch (e) {
      await showAlert({ title: t('warning'), content: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page
      title={editing ? t('edit_token') : t('add_token')}
      legacy
      id="edit_token_page"
      footer={
        <>
          {disclaimer && <label class="rowx gap12" style={{ cursor: 'pointer', alignItems: 'flex-start' }}><Check on={checked} onChange={setChecked} /><span style={{ fontSize: '14px' }}>{t('add_token_disclaimer_check')}</span></label>}
          <div class="rowx gap12">
            <Button secondary={!editing} danger={editing} id="edit_token_delete" onClick={async () => {
              if (ex) await w.deleteToken(ex.address);
              nav.pop();
            }}>{editing ? t('delete') : t('cancel')}</Button>
            <Button loading={busy} disabled={disclaimer && !checked} id="edit_token_save" onClick={() => void save()}>{t('save')}</Button>
          </div>
        </>
      }
    >
      <div class="col" style={{ alignItems: 'center', gap: '16px', paddingTop: '12px' }}>
        <div class="warning-box rowx gap12" style={{ alignSelf: 'stretch', fontWeight: 500 }}><Icon src="warning.svg" size={22} color="var(--warning-outline)" />{t('add_token_warning')}</div>
        <div style={{ position: 'relative', marginTop: '24px' }}>
          {icon ? <Img src={icon} size={75} round /> : <span style={{ display: 'block', width: '75px', height: '75px', borderRadius: '50%', border: '2px dashed var(--surface-container-highest)' }} />}
          {verified && icon && <span style={{ position: 'absolute', right: 0, bottom: 0, width: '24px', height: '24px', borderRadius: '50%', background: 'var(--primary)', border: '2px solid var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--on-primary)' }}><MIcon name="check" size={16} /></span>}
        </div>
        {jupiterVerified && <div style={{ fontWeight: 500, color: 'var(--primary)' }} id="edit_token_jupiter">{t('token_verified_on_jupiter')}</div>}
        <div style={{ alignSelf: 'stretch' }} onFocusOut={() => void fill(address)}>
          <Field value={address} onInput={onAddress} placeholder={t('contract_address')} error={errs.address} mono id="edit_token_address" suffix={<button type="button" class="ficon" aria-label={t('paste')} onClick={async () => { try { const v = (await navigator.clipboard.readText()).trim(); onAddress(v); setDisclaimer(true); void fill(v); } catch { /* clipboard blocked */ } }}><img src="./cake/images/paste_ios.png" alt="" style={{ width: '18px' }} /></button>} />
        </div>
        {editing ? <div class="warning-box" style={{ alignSelf: 'stretch', fontWeight: 500 }}>{t('tokens_strong_warning')}</div> : <div style={{ alignSelf: 'stretch', fontWeight: 500 }}>{t('tokens_strong_warning')}</div>}
        <div style={{ height: '1px', alignSelf: 'stretch', background: 'var(--surface-container-highest)', margin: '8px 0' }} />
        <div class="col gap8" style={{ alignSelf: 'stretch' }}>
          <Field value={name} onInput={setName} placeholder={t('token_name')} error={errs.name} id="edit_token_name" />
          <Field value={symbol} onInput={setSymbol} placeholder={t('token_symbol')} error={errs.symbol} id="edit_token_symbol" />
          <Field value={decimals} onInput={(v) => setDecimals(v.replace(/[^0-9]/g, ''))} placeholder={t('token_decimal')} error={errs.decimals} inputMode="numeric" id="edit_token_decimals" />
        </div>
      </div>
    </Page>
  );
}

// --------------------------------------------------------- asset details --

export function openAssetDetails(w: WalletBase, a: TokenAsset) {
  return showSheet((close) => <AssetDetails w={w} a={a} close={close} />);
}

function AssetDetails({ w, a, close }: { w: WalletBase; a: TokenAsset; close: () => void }) {
  void prices.value;
  const s = settings.value;
  const hidden = s.balanceDisplayMode === 'hiddenBalance';
  const f = assetFiat(a);
  const go = (route: string, args: unknown) => {
    close();
    nav.push(route, args);
  };
  return (
    <div class="col" style={{ alignItems: 'center', gap: '24px', padding: '0 18px 32px' }} id="asset_details">
      <TopBar onClose={close} />
      <TokenIcon icon={a.icon} symbol={a.symbol} size={75} />
      <div class="rowx gap8"><span style={{ fontSize: '20px', fontWeight: 500 }}>{a.name}</span><span class="pill sm" style={{ cursor: 'default', color: 'var(--on-surface-variant)' }}>{a.symbol}</span></div>
      <div class="rowx" style={{ gap: '4px', color: 'var(--on-surface-variant)', fontSize: '16px' }}><Img src={networkIcon(w)} size={16} />{WALLET_TYPE_NAME[w.type]}</div>
      <div style={{ height: '1px', width: '80%', background: 'var(--surface-container-high)' }} />
      <div style={{ fontSize: '28px' }}>{hidden ? '●●●●●●' : formatFixed(a.balance, a.decimals, { fractionDigits: Math.min(a.decimals, 8) })} <span class="muted">{a.symbol}</span></div>
      {s.fiatApiMode !== 'disabled' && <div class="muted" style={{ fontSize: '20px' }}>{hidden ? '●●●●●' : `${s.fiatCurrency} ${formatFiatAmount(f)}`}</div>}
      <div class="rowx" style={{ gap: '20px', justifyContent: 'center' }}>
        <ModernButton svg="send.svg" size={60} iconSize={32} caption={t('send')} id="asset_send" onClick={() => go(Routes.send, { asset: a.key })} />
        {s.exchangeStatus !== 'disabled' && <ModernButton svg="exchange.svg" size={60} iconSize={32} caption={t('swap')} onClick={() => go(Routes.exchange, { from: a.key })} />}
        {/* DashboardViewModel.showBridge: USDT0 on an EVM chain */}
        {isUsdt0Token((w as { chainId?: number }).chainId ?? 0, a.address) && <ModernButton svg="bridge.svg" size={60} iconSize={32} caption="Bridge" id="asset_bridge" onClick={() => go(Routes.bridgeAmountPage, { asset: a })} />}
        <ModernButton svg="receive.svg" size={60} iconSize={32} caption={t('receive')} id="asset_receive" onClick={() => go(Routes.receive, { asset: a.key })} />
      </div>
    </div>
  );
}

registerRoute(Routes.homeSettings, HomeSettingsPage);
registerRoute(Routes.editToken, EditTokenPage);
