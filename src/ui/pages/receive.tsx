// Receive (lib/new-ui/pages/receive_page.dart + receive_page widgets, addresses_page.dart).

import { useEffect, useState } from 'preact/hooks';
import { t } from '../../core/i18n.ts';
import { AddressText, Button, Field, Icon, Img, ListTextField, MIcon, ModernButton, TopBar, asset, copyText } from '../components/core.tsx';
import { showBlurDialog, showLongPressMenu, useLongPress } from '../components/longPress.tsx';
import { assetsOf, pickAsset } from './send.tsx';
import { networkIcon } from './tokens.tsx';
import { showSheet } from '../components/overlays.tsx';
import { QrCode, qrBadge } from '../components/qr.tsx';
import { registerRoute, Routes } from '../routes.ts';
import { nav } from '../nav.ts';
import { currentWallet } from '../../app/app.ts';
import { settings, updateSettings } from '../../app/settings.ts';
import { receiveUri } from '../../core/paymentUri.ts';
import { isEvm, WALLET_TYPE_NAME } from '../../coins/types.ts';
import { formatFixed, tryParseFixed } from '../../core/amount.ts';
import { apiString, fetchPrice, fiatValue, formatFiatAmount, prices } from '../../app/prices.ts';
import { signal } from '@preact/signals';
import { chooseFiat } from './settings/pages.tsx';
import type { WalletAddressEntry, WalletBase } from '../../core/wallet.ts';
import { cardStyleKey, designFromStyle, MiniCard, storedCardStyle } from './dashboard/cards.tsx';

function chunkFor(w: WalletBase): number {
  return w.type === 'monero' || w.type === 'wownero' || w.type === 'zano' ? 6 : 4;
}

function ReceivePage({ args }: { args?: { asset?: string } }) {
  const w = currentWallet.value;
  const [amount, setAmount] = useState('');
  const [assetKey, setAssetKey] = useState<string | undefined>(args?.asset);
  const [large, setLarge] = useState(false);
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);
  if (!w) return null;
  const address = w.receiveAddress.value;
  const opts = w.receiveOptions();
  const opt = opts.find((o) => o.id === w.receiveOption);
  const entry = w.addresses.value.find((a) => a.address === address);
  // token wallets: the selected token (tokenCurrency in wallet_address_list_view_model.dart)
  const assets = assetsOf(w);
  const token = assetKey && assetKey !== w.currency.key ? assets.find((a) => a.key === assetKey) : undefined;
  const uri = receiveUri({ type: w.type, address, amount, chainId: (w as any).chainId, token: token?.key, tokenDecimals: token?.decimals });
  const symbol = token?.symbol ?? w.currency.title;
  const dismissed = settings.value.dismissedPromos[`receive_info:${w.type}`];
  const multichain = isEvm(w.type) || w.type === 'solana' || w.type === 'tron' || w.type === 'zano';
  const info = multichain ? `${t('infobox_multichain')} ${WALLET_TYPE_NAME[w.type]}` : w.rotatesAddresses ? t('infobox_auto_address') : null;
  const fiat = amount ? fiatValue(Number(amount.replace(',', '.')), token?.api ?? apiString(w.currency)) : null;
  const shownTokens = assets.slice(1).filter((a) => a.icon).slice(0, 4);
  return (
    <div class="page solid" id="receive_page">
      <TopBar
        title={large ? '' : t('receive')}
        onClose={() => nav.pop()}
        trailing={
          large ? (
            <ModernButton icon="share" size={36} label={t('share_address')} onClick={() => (navigator.share ? navigator.share({ text: uri }).catch(() => {}) : copyText(uri))} />
          ) : w.rotatesAddresses ? (
            <ModernButton
              icon="refresh"
              size={36}
              id="receive_new_address"
              label={t('rotate_address')}
              disabled={rotating}
              onClick={async () => {
                setRotating(true);
                try {
                  await w.newAddress();
                } finally {
                  setRotating(false);
                }
              }}
            />
          ) : undefined
        }
      />
      <div class="page-body" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-evenly', gap: '16px', padding: '0 0 24px' }}>
        {large && <img src={`./cake/new-ui/cakewallet-wordmark${document.documentElement.dataset.theme === 'light' ? '-light' : ''}.svg`} alt="Cake Wallet" style={{ height: '45px' }} />}
        {amount && !large && (
          <div class="rowx gap4">
            <span style={{ background: 'var(--surface-container)', borderRadius: '12px', padding: '8px', color: 'var(--primary)', fontWeight: 500, fontSize: '16px' }}>{amount} {symbol}</span>
            {fiat !== null && <span class="muted" style={{ padding: '8px', fontWeight: 500, fontSize: '16px' }}>{formatFiatAmount(fiat)} {settings.value.fiatCurrency}</span>}
          </div>
        )}
        <div onClick={() => setLarge(!large)} style={{ cursor: 'pointer', transform: large ? 'scale(1.35)' : undefined, transition: 'transform 500ms cubic-bezier(.2,.9,.25,1)', margin: large ? '60px 0' : 0 }} title={large ? t('qr_close_fullscreen') : t('qr_fullscreen')}>
          <QrCode data={uri} size={230} logo={token?.icon ? asset(token.icon) : qrBadge(w.type)} id="receive_qr" />
        </div>
        {token && (
          <div class="rowx gap8" id="receive_token">
            <span style={{ fontSize: '18px', fontWeight: 600, color: 'var(--primary)' }}>{token.symbol}</span>
            <span class="rowx" style={{ gap: '4px', background: 'var(--surface-container)', borderRadius: '999px', padding: '4px 8px 4px 4px', color: 'var(--primary)', fontSize: '12px', fontWeight: 500 }}><Img src={networkIcon(w)} size={16} />{WALLET_TYPE_NAME[w.type]}</span>
          </div>
        )}
        {!large && opts.length > 1 && opt && (
          <button type="button" class="rowx gap12" id="receive_address_type" onClick={() => void pickAddressType(w)} style={{ background: 'none', border: 0, color: 'var(--primary)', fontSize: '16px', cursor: 'pointer' }}>
            <Icon src={opt.icon} size={24} />
            <span>{opt.title}</span>
            <span style={{ width: '24px', height: '24px', borderRadius: '50%', background: 'var(--surface-container)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <MIcon name="chevronDown" size={20} />
            </span>
          </button>
        )}
        <div class="mono center" style={{ padding: '0 50px', fontSize: '15px', fontWeight: 500 }} id="receive_address">
          <AddressText address={address} chunk={chunkFor(w)} />
        </div>
        {!large && entry?.label && (
          <button type="button" class="pill" style={{ height: '36px' }} onClick={() => void editLabel(w, entry)}>
            <Icon src="label.svg" size={24} color="var(--on-surface-variant)" />
            <span style={{ fontSize: '12px', color: 'var(--on-surface-variant)' }}>{entry.label}</span>
          </button>
        )}
        {!large && (
          <div class="rowx" style={{ gap: '16px', padding: '0 32px', justifyContent: 'center' }}>
            <ModernButton
              svg="copy.svg"
              size={60}
              iconSize={32}
              id="receive_copy"
              caption={copied ? t('copied') : t('copy')}
              bg={copied ? 'var(--surface-container-highest)' : 'var(--primary)'}
              color={copied ? 'var(--primary)' : 'var(--surface-container)'}
              onClick={async () => {
                await copyText(amount ? uri : address);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            />
            <ModernButton svg="set-amount.svg" size={60} iconSize={32} caption={t('set_amount')} id="receive_set_amount" onClick={async () => {
              const v = await setAmountModal(w, amount, assetKey);
              if (v !== undefined) {
                setAmount(v.amount);
                setAssetKey(v.asset);
              }
            }} />
            {w.hasAddressList && !entry?.label && entry && <ModernButton svg="add-label.svg" size={60} iconSize={32} caption={t('label')} onClick={() => void editLabel(w, entry)} />}
            {w.hasAddressList && <ModernButton svg="addr-book.svg" size={60} iconSize={32} caption={t('addresses')} id="receive_addresses" onClick={() => nav.push(Routes.receiveAddresses)} />}
          </div>
        )}
        {!large && info && !dismissed && (
          <div style={{ padding: '0 25px', width: '100%' }}>
            <div class="rowx" style={{ gap: '10px', background: 'var(--surface-container)', borderRadius: '16px', padding: '16px', alignItems: 'flex-start' }}>
              <Icon src="info.svg" size={16} color="var(--on-surface-variant)" />
              <div class="col grow" style={{ gap: '10px' }}>
                <span style={{ fontSize: '12px', fontWeight: 300, color: 'var(--on-surface-variant)' }}>{info}</span>
                {multichain && shownTokens.length > 0 && (
                  <div class="rowx" style={{ gap: '8px' }}>
                    <Img src={networkIcon(w)} size={20} />
                    <span style={{ width: '1px', height: '28px', background: 'var(--surface-container-high)' }} />
                    <span class="rowx">
                      {shownTokens.map((a, i) => <span style={{ marginLeft: i ? '-8px' : 0, borderRadius: '50%', border: '1.5px solid var(--surface-container)', display: 'inline-flex' }}><Img src={a.icon} size={24} round /></span>)}
                      <span style={{ marginLeft: '-8px', width: '24px', height: '24px', borderRadius: '50%', background: 'rgba(255,255,255,.25)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><MIcon name="add" size={16} color="rgba(255,255,255,.5)" /></span>
                    </span>
                  </div>
                )}
                <button type="button" style={{ alignSelf: 'flex-end', background: 'none', border: 0, color: 'var(--primary)', fontSize: '12px', fontWeight: 300, cursor: 'pointer' }} onClick={() => updateSettings((s) => ({ dismissedPromos: { ...s.dismissedPromos, [`receive_info:${w.type}`]: true } }))}>
                  {t('dismiss')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function pickAddressType(w: WalletBase) {
  return showSheet((close) => {
    const opts = w.receiveOptions();
    const common = opts.filter((o) => o.common);
    const more = opts.filter((o) => !o.common);
    const Row = ({ o }: { o: (typeof opts)[0] }) => (
      <button type="button" class="rowx" id={`address_type_${o.id}`} onClick={() => { w.setReceiveOption(o.id); close(); }} style={{ minHeight: '64px', width: '100%', padding: '0 10px', gap: '10px', border: 0, background: w.receiveOption === o.id ? 'var(--surface-container-highest)' : 'none', color: 'var(--on-surface)', cursor: 'pointer', textAlign: 'start' }}>
        <Icon src={o.icon} size={24} color="var(--on-surface-variant)" />
        <span class="grow col" style={{ padding: '10px' }}>
          <span style={{ fontSize: '16px', fontWeight: 500 }}>{o.title}</span>
          <span class="muted">{o.description}</span>
        </span>
        {w.receiveOption === o.id && <span style={{ width: '20px', height: '20px', borderRadius: '50%', background: 'var(--primary)', color: 'var(--surface)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><MIcon name="check" size={14} /></span>}
      </button>
    );
    return (
      <div style={{ padding: '0 0 24px' }}>
        <TopBar title={t('address_type')} onClose={() => close()} />
        <div style={{ padding: '0 24px' }} class="col gap12">
          <div style={{ background: 'var(--surface-container)', borderRadius: '20px', overflow: 'hidden' }}>{common.map((o) => <Row o={o} />)}</div>
          {more.length > 0 && (
            <div style={{ background: 'var(--surface-container)', borderRadius: '20px', overflow: 'hidden' }}>
              <div style={{ height: '48px', display: 'flex', alignItems: 'center', padding: '0 16px', color: 'var(--primary)' }}>{t('more_options')}</div>
              {more.map((o) => <Row o={o} />)}
            </div>
          )}
        </div>
      </div>
    );
  });
}

function setAmountModal(w: WalletBase, initial: string, assetKey?: string): Promise<{ amount: string; asset?: string } | undefined> {
  return showSheet<{ amount: string; asset?: string }>((close) => <AmountModal w={w} initial={initial} assetKey={assetKey} close={close} />);
}

/** WalletAddressListViewModel.selectedCurrency: the coin, or a fiat currency the amount is typed in (kept while the app runs) */
const receiveAmountCurrency = signal<string>('crypto');

/** _convertAmountToCrypto: the fiat amount at the price (of that fiat), to min(decimals, 8) digits; none without a price */
async function fiatToCrypto(w: WalletBase, amount: string, fiat: string, a: { api: string; decimals: number }): Promise<string> {
  const rate = fiat === settings.peek().fiatCurrency ? prices.peek()[a.api] ?? 0 : await fetchPrice(apiString(w.currency), fiat);
  const v = Number.parseFloat(amount.replace(',', '.'));
  if (!(rate > 0) || !Number.isFinite(v)) return '';
  return (v / rate).toFixed(Math.min(a.decimals, 8));
}

function AmountModal({ w, initial, assetKey, close }: { w: WalletBase; initial: string; assetKey?: string; close: (v?: { amount: string; asset?: string }) => void }) {
  const [key, setKey] = useState(assetKey ?? w.currency.key);
  const assets = assetsOf(w);
  const sel = assets.find((a) => a.key === key) ?? assets[0];
  const cur = receiveAmountCurrency.value;
  const fiat = cur !== 'crypto' ? cur : null;
  // initState: a fiat choice shows the amount in that fiat
  const [v, setV] = useState(() => {
    if (!fiat || !initial) return initial;
    const rate = fiat === settings.peek().fiatCurrency ? prices.peek()[sel.api] ?? 0 : 0;
    return rate ? (Number(initial) * rate).toFixed(2) : '';
  });
  const bad = v && (fiat ? !/^\d*[.,]?\d{0,2}$/.test(v) : tryParseFixed(v, sel.decimals) === null);
  /** _presentFiatCurrencyPicker: a fiat currency, or the coin */
  const pickCurrency = async () => {
    const r = await chooseFiat(fiat ?? settings.peek().fiatCurrency, { title: w.currency.title, name: w.currency.fullName ?? w.currency.title, icon: w.currency.iconPath ?? undefined, selected: !fiat });
    if (!r) return;
    receiveAmountCurrency.value = r;
    setV('');
  };
  return (
    <div style={{ padding: '0 0 24px' }}>
      <TopBar title={t('set_amount')} onClose={() => close()} />
      <div class="col gap12" style={{ padding: '0 18px' }}>
        {assets.length > 1 && (
          <>
            <div>{t('token')}</div>
            <button type="button" class="rowx" id="receive_token_select" onClick={async () => { const k = await pickAsset(w, assets, sel.key); if (k) setKey(k); }} style={{ height: '60px', background: 'var(--surface-container)', borderRadius: '16px', border: 0, padding: '0 16px', gap: '8px', color: 'var(--on-surface)', cursor: 'pointer' }}>
              <Img src={sel.icon} size={32} round />
              <span class="grow" style={{ textAlign: 'start' }}>{sel.symbol.toUpperCase()}</span>
              <Icon src="dropdown_arrow.svg" w={12} h={7} color="var(--primary)" />
            </button>
          </>
        )}
        <div>{t('amount')}</div>
        <Field value={v} onInput={setV} placeholder={fiat ? '0.00' : '0.00000000'} inputMode="decimal" error={bad ? t('error_text_amount') : null} suffix={
          <button type="button" class="rowx" id="receive_amount_currency" aria-label={t('select_fiat_currency_title')} onClick={() => void pickCurrency()} style={{ gap: '4px', height: '44px', padding: '0 12px', borderRadius: '14px', border: 0, background: 'var(--surface-container-highest)', color: 'var(--on-surface)', cursor: 'pointer' }}>
            <span>{fiat ?? sel.symbol}</span>
            <MIcon name="chevronDown" size={20} color="var(--primary)" />
          </button>
        } id="receive_amount_input" autoFocus />
        <Button disabled={!!bad} id="receive_amount_continue" onClick={async () => {
          const amount = fiat && v ? await fiatToCrypto(w, v, fiat, sel) : v.replace(',', '.');
          close({ amount, asset: sel.key === w.currency.key ? undefined : sel.key });
        }}>{t('continue_text')}</Button>
      </div>
    </div>
  );
}

function editLabel(w: WalletBase, a: WalletAddressEntry) {
  return showSheet((close) => <LabelModal w={w} a={a} close={close} />);
}

function LabelModal({ w, a, close }: { w: WalletBase; a: WalletAddressEntry; close: () => void }) {
  const [label, setLabel] = useState(a.label);
  return (
    <div style={{ padding: '0 0 24px' }}>
      <TopBar title={t('label_address')} onClose={close} />
      <div class="col gap24" style={{ padding: '0 18px' }}>
        <div class="muted center" style={{ fontSize: '12px' }}>{t('address_label_explainer')}</div>
        <Field value={label} onInput={setLabel} placeholder={t('label')} id="address_label_input" />
        <div class="rowx gap8 scroll-x">
          {['donation', 'savings', 'business', 'mining', 'salary'].map((k) => (
            <button type="button" class="pill" style={{ height: '36px', background: 'var(--surface-container-high)', color: 'var(--primary)' }} onClick={() => setLabel(t(k))}>{t(k)}</button>
          ))}
        </div>
        <Button onClick={async () => { await w.setAddressLabel(a.address, label.trim()); close(); }}>{t('continue_text')}</Button>
      </div>
    </div>
  );
}

/** NewAddressesPage; `picker` (pickerWalletAddress, popOnSelection): a tap returns the address */
function AddressesPage({ args }: { args?: { hidden?: boolean; picker?: boolean } }) {
  const w = currentWallet.value;
  const [q, setQ] = useState('');
  if (!w) return null;
  const showHidden = !!args?.hidden;
  const picker = !!args?.picker;
  const type = w.receiveOption;
  const list = w.addresses.value
    .filter((a) => !a.isChange && (type ? a.type === type || !a.type : true) && (a.account ?? 0) === w.currentAccount.value)
    .filter((a) => (showHidden ? a.isHidden : !a.isHidden))
    .filter((a) => !q || a.address.includes(q) || a.label.toLowerCase().includes(q.toLowerCase()));
  const sel = w.receiveAddress.value;
  return (
    <div class="page solid" id="addresses_page">
      <TopBar title={showHidden ? t('hidden_addresses') : t('addresses')} onBack={() => nav.pop()} />
      <div class="page-body" style={{ padding: '0 16px 100px' }}>
        {!showHidden && (
          <>
            {w.isMultiAccountsEnabled && <AccountPreviewHeader w={w} />}
            <div class="muted" style={{ fontSize: '10px', textAlign: 'center', marginBottom: '16px' }}>{t('long_press_edit_address')}</div>
            {!picker && (
              <button type="button" class="rowx" id="show_hidden_addresses" onClick={() => nav.push(Routes.receiveAddresses, { hidden: true })} style={{ width: '100%', height: '48px', background: 'var(--surface-container)', borderRadius: '16px 16px 0 0', border: 0, padding: '0 16px', justifyContent: 'space-between', color: 'var(--on-surface)', cursor: 'pointer', borderBottom: '1px solid var(--surface-container-high)' }}>
                <span>{t('show_hidden_addresses')}</span>
                <Img src="dropdown_arrow.svg" w={12} h={7} style={{ transform: 'rotate(90deg)' }} />
              </button>
            )}
          </>
        )}
        {list.map((a, i) => (
          <AddressRow key={a.address} w={w} a={a} selected={a.address === sel} first={(showHidden || picker) && i === 0} last={i === list.length - 1} onSelect={() => (picker ? nav.pop(a.address) : w.selectReceiveAddress(a.address))} />
        ))}
      </div>
      <div style={{ position: 'absolute', left: '30px', right: '30px', bottom: '18px' }}>
        <div class="search" style={{ borderRadius: '999px', background: 'color-mix(in srgb, var(--surface-container-high) 50%, transparent)', backdropFilter: 'blur(10px)', border: '1px solid var(--surface-container-highest)' }}>
          <MIcon name="search" size={20} color="var(--on-surface-variant)" />
          <input placeholder={t('search')} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} style={{ fontWeight: 600 }} />
        </div>
      </div>
    </div>
  );
}

/** AccountPreviewHeader: the selected account's card, its name, the wallet's name and the available balance */
function AccountPreviewHeader({ w }: { w: WalletBase }) {
  const s = settings.value;
  const design = designFromStyle(storedCardStyle(s.cardDesigns, cardStyleKey(w)), w.currency.key);
  const label = w.accounts.value.find((a) => a.index === w.currentAccount.value)?.label ?? '';
  const available = w.balances.value[w.currency.key]?.available ?? 0n;
  const sats = w.type === 'bitcoin' && s.displayAmountsInSatoshi;
  return (
    <div class="rowx" id="account_preview_header" style={{ height: '64px', width: '90%', margin: '0 auto 16px', padding: '12px', borderRadius: '16px', background: 'var(--surface-container)', justifyContent: 'space-between', boxSizing: 'border-box' }}>
      <span class="rowx" style={{ gap: '10px', minWidth: 0 }}>
        <MiniCard design={design} />
        <span class="col" style={{ minWidth: 0 }}>
          <span style={{ fontSize: '12px', color: 'var(--primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
          <span style={{ fontSize: '12px', color: 'var(--on-surface-variant)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{w.info.name}</span>
        </span>
      </span>
      <span class="rowx" style={{ gap: '12px', flex: 'none' }}>
        <span style={{ width: '1px', height: '40px', background: 'var(--surface-container-high)' }} />
        <span>{s.balanceDisplayMode === 'hiddenBalance' ? '●●●●●●' : sats ? available.toString() : formatFixed(available, w.currency.decimals, { fractionDigits: Math.min(w.currency.decimals, 8) })}</span>
      </span>
    </div>
  );
}

/** AddressRow's face: the label and the address on a line, the transactions and the balance (Monero: received) */
function AddressRowFace({ w, a, selected, first, last, handlers }: { w: WalletBase; a: WalletAddressEntry; selected: boolean; first: boolean; last: boolean; handlers?: Record<string, unknown> }) {
  const sats = w.type === 'bitcoin' && settings.value.displayAmountsInSatoshi;
  // MoneroSubaddressList: (received / 1e12).toStringAsFixed(6); Electrum wallets: the balance's display string
  const amount = a.received !== undefined ? (Number(a.received) / 1e12).toFixed(6) : sats ? (a.balance ?? 0n).toString() : formatFixed(a.balance ?? 0n, w.currency.decimals, { fractionDigits: 8 });
  return (
    <div
      class="col lp-target"
      id={handlers ? `address_row_${a.index}` : undefined}
      {...handlers}
      style={{ background: selected ? 'var(--surface-container-highest)' : 'var(--surface-container)', transition: 'background 150ms', padding: '12px', gap: '6px', cursor: 'pointer', borderTopLeftRadius: first ? '16px' : 0, borderTopRightRadius: first ? '16px' : 0, borderBottomLeftRadius: last ? '16px' : 0, borderBottomRightRadius: last ? '16px' : 0, borderTop: first ? 0 : '1px solid var(--surface-container-high)' }}
    >
      <div class="rowx" style={{ justifyContent: 'space-between', gap: '8px' }}>
        <div class="col" style={{ gap: '6px', minWidth: 0, flex: 1 }}>
          <div class="rowx" style={{ gap: '4px', minWidth: 0 }}>
            {a.label && <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--on-surface)', flex: 'none' }}>{a.label}</span>}
            <span class="mono" style={{ fontSize: '12px', minWidth: 0, color: a.label ? 'var(--on-surface-variant)' : 'var(--on-surface)' }}>
              <AddressText address={a.address} truncate={!!a.label} />
            </span>
          </div>
          <div class="rowx" style={{ justifyContent: 'space-between', fontSize: '12px', color: 'var(--on-surface-variant)' }}>
            <span>{t('transactions')}: {a.txCount ?? 0}</span>
            <span>{a.received !== undefined ? t('received') : t('balance')}: {amount}</span>
          </div>
        </div>
        {selected && <Img src="checkmark.svg" size={25} />}
      </div>
    </div>
  );
}

/** AddressLabelInputPopup: the label's field over the blurred screen, saved with Enter */
function editAddressLabel(w: WalletBase, a: WalletAddressEntry) {
  return showBlurDialog<string>((close) => <AddressLabelInput initial={a.label} onSave={async (label) => { await w.setAddressLabel(a.address, label); close(label); }} />);
}

function AddressLabelInput({ initial, onSave }: { initial: string; onSave: (label: string) => void }) {
  const [label, setLabel] = useState(initial);
  return (
    <div style={{ padding: '16px', width: '100%', boxSizing: 'border-box' }} id="address_label_popup">
      <ListTextField label={t('label')} value={label} onInput={setLabel} onEnter={(v) => onSave(v)} autoFocus id="address_label_popup_input" />
    </div>
  );
}

/** AddressInfoPopup: the index and the derivation path */
function showAddressInfo(w: WalletBase, a: WalletAddressEntry) {
  const path = (w as any).tree?.displayPath?.({ type: a.type, account: a.account ?? 0, change: !!a.isChange, legacy: false }, a.index) ?? '';
  return showBlurDialog(() => (
    <div class="col" id="address_info_popup" style={{ background: 'var(--surface-container-high)', borderRadius: '18px', padding: '8px', gap: '16px', alignItems: 'center', textAlign: 'center', maxWidth: 'calc(100% - 32px)', overflowWrap: 'anywhere' }}>
      <span>{`Index: ${a.index}`}</span>
      <span>{`Derivation Path: ${path}`}</span>
    </div>
  ));
}

/** AddressRow: a tap selects (or picks) it; a long press, Cake's menu (set label, hide, info) */
function AddressRow({ w, a, selected, first, last, onSelect }: { w: WalletBase; a: WalletAddressEntry; selected: boolean; first: boolean; last: boolean; onSelect: () => void }) {
  const lp = useLongPress((el) => {
    void showLongPressMenu(el, {
      child: () => <AddressRowFace w={w} a={a} selected={selected} first={first} last={last} />,
      items: [
        { label: t('set_label'), icon: 'address_set_label.svg', id: 'address_menu_label', onSelected: (close) => { close(); void editAddressLabel(w, a); } },
        { label: a.isHidden ? t('unhide_address') : t('hide_address'), icon: 'address_hide.svg', id: 'address_menu_hide', color: 'var(--error)', onSelected: (close) => { close(); void w.setAddressHidden(a.address, !a.isHidden); } },
        { label: t('info'), icon: 'assets/images/info_icon.svg', id: 'address_menu_info', onSelected: (close) => { close(); void showAddressInfo(w, a); } },
      ],
    });
  });
  return <AddressRowFace w={w} a={a} selected={selected} first={first} last={last} handlers={{ ...lp, onClick: onSelect }} />;
}

registerRoute(Routes.receive, ReceivePage);
registerRoute(Routes.newReceivePage, ReceivePage);
registerRoute(Routes.receiveAddresses, AddressesPage);
registerRoute(Routes.pickerWalletAddress, () => <AddressesPage args={{ picker: true }} />);
