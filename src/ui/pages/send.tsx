// Send (lib/new-ui/pages/send_page.dart + send_page widgets).

import { useEffect, useMemo, useState } from 'preact/hooks';
import { t } from '../../core/i18n.ts';
import { AddressText, Button, Icon, Img, MIcon, ModernButton, TopBar, Spinner } from '../components/core.tsx';
import { showAlert, showSheet, toast } from '../components/overlays.tsx';
import { requireAuth } from '../components/auth.tsx';
import { registerRoute, Routes } from '../routes.ts';
import { nav } from '../nav.ts';
import { currentWallet } from '../../app/app.ts';
import { settings } from '../../app/settings.ts';
import { contacts } from '../../app/contacts.ts';
import { formatFixed, tryParseFixed } from '../../core/amount.ts';
import { apiString, fiatValue, formatFiatAmount, prices } from '../../app/prices.ts';
import { isSynced, type PendingTransaction, type WalletBase } from '../../core/wallet.ts';
import { parsePaymentRequest } from '../../core/paymentUri.ts';
import { isEvm, WALLET_TYPE_NAME } from '../../coins/types.ts';
import { resolveAddress, type ResolvedAddress } from '../../app/resolver.ts';
import { openTxDetails } from './dashboard/history.tsx';

interface Recipient {
  address: string;
  resolved?: ResolvedAddress;
  amount: string;
  fiatMode: boolean;
  sendAll: boolean;
  asset?: string;
  note: string;
}

const emptyRecipient = (asset?: string): Recipient => ({ address: '', amount: '', fiatMode: false, sendAll: false, asset, note: '' });

export interface AssetInfo {
  key: string;
  symbol: string;
  decimals: number;
  balance: bigint;
  api: string;
  icon?: string;
}

export function assetsOf(w: WalletBase): AssetInfo[] {
  const list: AssetInfo[] = [{ key: w.currency.key, symbol: w.currency.title, decimals: w.currency.decimals, balance: w.balances.value[w.currency.key]?.available ?? 0n, api: apiString(w.currency), icon: w.currency.iconPath ?? undefined }];
  const extra: any[] = (w as any).assetList?.() ?? [];
  for (const a of extra) if (a.key !== w.currency.key) list.push({ key: a.key, symbol: a.symbol, decimals: a.decimals, balance: a.balance, api: a.api, icon: a.icon });
  return list;
}

function SendPage({ args }: { args?: { address?: string; amount?: string; asset?: string; note?: string } }) {
  const w = currentWallet.value;
  if (!w) return null;
  return <SendForm w={w} args={args} />;
}

function SendForm({ w, args }: { w: WalletBase; args?: { address?: string; amount?: string; asset?: string; note?: string } }) {
  const [recipients, setRecipients] = useState<Recipient[]>([{ ...emptyRecipient(args?.asset), address: args?.address ?? '', amount: args?.amount ?? '', note: args?.note ?? '' }]);
  const [idx, setIdx] = useState(0);
  const [priority, setPriority] = useState(() => settings.value.priority[w.type] ?? w.defaultPriority());
  const [customRate, setCustomRate] = useState(1);
  const [fee, setFee] = useState<bigint | null>(null);
  const [selectedUtxos, setSelectedUtxos] = useState<string[] | undefined>(undefined);
  const [errors, setErrors] = useState<{ address?: string; amount?: string }>({});
  const [advOpen, setAdvOpen] = useState(false);
  void prices.value;
  const r = recipients[idx];
  const assets = assetsOf(w);
  const asset = assets.find((a) => a.key === (r.asset ?? w.currency.key)) ?? assets[0];
  const fiatCode = settings.value.fiatCurrency;
  const price = prices.value[asset.api] ?? 0;
  const synced = isSynced(w.syncStatus.value);
  const priorities = w.priorities();
  const multi = w.hasMultipleOutputs;

  const update = (p: Partial<Recipient>) => setRecipients(recipients.map((x, i) => (i === idx ? { ...x, ...p } : x)));

  const cryptoAmount = (rr: Recipient): string => {
    if (!rr.fiatMode) return rr.amount;
    const f = Number(rr.amount.replace(',', '.'));
    return price && f ? (f / price).toFixed(Math.min(asset.decimals, 12)).replace(/\.?0+$/, '') : '';
  };

  useEffect(() => {
    let alive = true;
    const amt = tryParseFixed(cryptoAmount(r) || '0', asset.decimals) ?? 0n;
    w.estimateFee(priority, amt || undefined, asset.key, customRate as any)
      .then((f) => alive && setFee(f))
      .catch(() => alive && setFee(null));
    return () => {
      alive = false;
    };
  }, [priority, r.amount, r.asset, customRate, w.syncStatus.value.kind]);

  const onAddressInput = async (text: string) => {
    if (text.includes(':') || text.includes('=')) {
      const pr = parsePaymentRequest(text);
      update({ address: pr.address, amount: pr.amount || r.amount, note: pr.note || r.note, resolved: undefined });
      return;
    }
    update({ address: text, resolved: undefined });
  };

  const tryResolve = async () => {
    const text = r.address.trim();
    if (!text || w.validateAddress(text, r.asset)) return;
    try {
      const res = await resolveAddress(text, w);
      if (res) {
        update({ resolved: res });
        await showAlert({ title: t('address_detected'), content: t('extracted_address_content', { recipient_name: `${res.name} (${res.source})` }) });
      }
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const validate = (): boolean => {
    const errs: { address?: string; amount?: string } = {};
    for (const rr of recipients) {
      const addr = rr.resolved?.address ?? rr.address.trim();
      if (!addr) errs.address = t('enter_recipient_address');
      else if (!w.validateAddress(addr, rr.asset)) errs.address = t('error_text_address');
      if (!rr.sendAll) {
        const a = tryParseFixed(cryptoAmount(rr), asset.decimals);
        if (a === null || a <= 0n) errs.amount = t('error_text_amount');
      }
    }
    setErrors(errs);
    return !errs.address && !errs.amount;
  };

  const onContinue = async () => {
    if (!validate()) {
      await showAlert({ title: t('error'), content: t('check_receiver_forms') });
      return;
    }
    if (!(await requireAuth())) return;
    const credentials = {
      outputs: recipients.map((rr) => ({
        address: rr.address.trim(),
        extractedAddress: rr.resolved?.address,
        parsedName: rr.resolved?.name,
        amount: rr.sendAll ? 0n : tryParseFixed(cryptoAmount(rr), asset.decimals) ?? 0n,
        sendAll: rr.sendAll,
        asset: rr.asset,
        note: rr.note,
      })),
      priority,
      feeRate: priority === 'custom' ? customRate : undefined,
      selectedUtxos,
    };
    await showSheet((close) => <ConfirmSheet w={w} credentials={credentials} assetSymbol={asset.symbol} decimals={asset.decimals} api={asset.api} close={close} />, { dismissible: false, full: true });
  };

  const balance = asset.balance;
  const converted = (() => {
    const v = Number((r.amount || '0').replace(',', '.'));
    if (!r.fiatMode) return price ? `${formatFiatAmount(v * price)} ${fiatCode}` : '0';
    return price ? `${(v / price).toFixed(8).replace(/\.?0+$/, '') || '0'} ${asset.symbol}` : '0';
  })();
  const feeFiat = fee !== null ? fiatValue(Number(formatFixed(fee, w.currency.decimals)), apiString(w.currency)) : null;
  const prio = priorities.find((p) => p.id === priority);

  return (
    <div class="page solid" id="send_page">
      <TopBar
        title={t('send')}
        onClose={() => nav.pop()}
        trailing={
          <div class="rowx gap8">
            {recipients.length > 1 && <ModernButton svg="remove_recipient.svg" size={36} label={t('remove')} onClick={() => { const n = recipients.filter((_, i) => i !== idx); setRecipients(n); setIdx(Math.max(0, idx - 1)); }} />}
            {multi && <ModernButton icon="add" size={36} id="send_add_recipient" label={t('add_receiver')} onClick={() => { setRecipients([...recipients, emptyRecipient(r.asset)]); setIdx(recipients.length); }} />}
          </div>
        }
      />
      <div class="page-body" style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
        <div class="col" style={{ gap: '24px' }}>
          <div class="col" style={{ gap: '12px' }}>
            <div>{t('address_or_alias')}</div>
            <div style={{ background: 'var(--surface-container)', borderRadius: '18px', display: 'flex', alignItems: 'center', minHeight: '56px', border: errors.address ? '1px solid var(--error)' : '1px solid transparent' }}>
              <textarea
                id="send_address"
                rows={r.address.length > 40 ? 2 : 1}
                value={r.address}
                placeholder={t('search_or_enter')}
                spellcheck={false}
                onInput={(e) => void onAddressInput((e.target as HTMLTextAreaElement).value)}
                onBlur={() => void tryResolve()}
                style={{ flex: 1, minWidth: 0, background: 'none', border: 0, outline: 0, color: 'var(--on-surface)', fontSize: '16px', padding: '16px 12px', resize: 'none', fontFamily: 'inherit' }}
              />
              <div class="rowx" style={{ gap: '12px', paddingRight: '12px' }}>
                <button type="button" class="ficon" aria-label={t('paste')} id="send_paste" onClick={async () => { try { await onAddressInput((await navigator.clipboard.readText()).trim()); } catch { toast(t('paste')); } }}><Icon src="paste.svg" size={22} /></button>
                <button type="button" class="ficon" aria-label={t('scan')} onClick={async () => { const v = await nav.pushForResult<string>('/scan', { mode: 'address' }); if (v) await onAddressInput(v); }}><Icon src="scan.svg" size={22} /></button>
                <button type="button" class="ficon" aria-label={t('address_book')} onClick={async () => { const c = await nav.pushForResult<{ address: string; name: string }>(Routes.pickerAddressBook, { currency: asset.key }); if (c) update({ address: c.address, resolved: undefined }); }}><Icon src="contacts_outlined.svg" size={22} /></button>
              </div>
            </div>
            {r.resolved && <div class="muted" style={{ fontSize: '12px', padding: '0 8px' }}>{r.resolved.name} → <span class="mono">{r.resolved.address}</span></div>}
            {errors.address && <div class="field-error">{errors.address}</div>}
          </div>
          <div class="col" style={{ gap: '12px' }}>
            <div>{t('amount')}</div>
            <div class="rowx" style={{ borderRadius: '18px', background: assets.length > 1 || r.fiatMode ? 'var(--surface-container-highest)' : 'var(--surface-container)', border: errors.amount ? '1px solid var(--error)' : '1px solid transparent', overflow: 'hidden' }}>
              <div class="rowx grow" style={{ background: 'var(--surface-container)', padding: '0 12px', gap: '8px', minHeight: '56px' }}>
                <input id="send_amount" inputMode="decimal" value={r.sendAll ? t('all') : r.amount} placeholder={r.fiatMode ? '0.00' : '0.00'} readOnly={r.sendAll} onFocus={() => r.sendAll && update({ sendAll: false, amount: '' })} onInput={(e) => update({ amount: (e.target as HTMLInputElement).value.replace(',', '.'), sendAll: false })} style={{ flex: 1, minWidth: 0, background: 'none', border: 0, outline: 0, color: 'var(--on-surface)', fontSize: '16px' }} />
              </div>
              <button type="button" class="rowx gap8" style={{ padding: '0 12px', background: 'none', border: 0, color: 'var(--on-surface)', cursor: assets.length > 1 ? 'pointer' : 'default', minHeight: '56px' }} onClick={async () => {
                if (assets.length < 2 || r.fiatMode) return;
                const k = await pickAsset(w, assets, asset.key);
                if (k) update({ asset: k, sendAll: false });
              }}>
                {assets.length > 1 && !r.fiatMode && <Img src={asset.icon} size={24} round />}
                <span>{r.fiatMode ? fiatCode : asset.symbol}</span>
                {assets.length > 1 && !r.fiatMode && <Icon src="chooser.svg" size={12} color="var(--primary)" />}
              </button>
            </div>
            {errors.amount && <div class="field-error">{errors.amount}</div>}
            <div class="rowx" style={{ justifyContent: 'space-between' }}>
              <div class="rowx gap8">
                <ModernButton svg="switch.svg" size={28} iconSize={18} label={t('switch_input_currency')} onClick={() => update({ fiatMode: !r.fiatMode, amount: '', sendAll: false })} />
                <span>{settings.value.fiatApiMode === 'disabled' ? '' : converted}</span>
              </div>
              <div class="rowx gap8">
                <span>{t('max')}.</span>
                <button type="button" class="pill sm" id="send_max" onClick={() => update({ sendAll: true, fiatMode: false, amount: '' })} style={{ color: 'var(--primary)', height: '28px' }}>
                  {formatFixed(balance, asset.decimals, { fractionDigits: 8 })}
                </button>
              </div>
            </div>
          </div>
          {(w.hasFees || w.hasCoinControl) && (
            <div style={{ background: 'var(--surface-container)', borderRadius: '20px', overflow: 'hidden' }}>
              <button type="button" class="rowx" id="send_advanced" onClick={() => setAdvOpen(!advOpen)} style={{ width: '100%', height: '48px', padding: '0 16px', background: 'none', border: 0, color: 'var(--primary)', justifyContent: 'space-between', cursor: 'pointer' }}>
                <span>{t('advanced_settings')}</span>
                <Icon src="dropdown_arrow.svg" w={12} h={7} color="var(--primary)" style={{ transform: advOpen ? undefined : 'rotate(180deg)', transition: 'transform 300ms' }} />
              </button>
              {advOpen && (
                <div style={{ borderTop: '1px solid var(--outline-variant)' }}>
                  {w.hasFees && <button type="button" class={`row${priorities.length ? ' tap' : ''}`} id="send_fees" onClick={async () => {
                    if (!priorities.length) return;
                    const v = await pickFee(w, priority, customRate);
                    if (v) {
                      setPriority(v.priority);
                      if (v.custom) setCustomRate(v.custom);
                    }
                  }}>
                    <span class="lbl">
                      <span>{t('fees')}</span>
                      <span class="sub">{fee !== null ? `~${formatFixed(fee, w.currency.decimals, { fractionDigits: 8 })} ${w.currency.title}${feeFiat !== null ? ` (${formatFiatAmount(feeFiat)} ${fiatCode})` : ''}` : '…'}{prio ? ` · ${prio.label}` : ''}</span>
                    </span>
                    {priorities.length > 0 && <Icon src="arrow_forward.svg" w={8} h={14} color="var(--on-surface-variant)" />}
                  </button>}
                  {w.hasCoinControl && (
                    <button type="button" class="row tap" id="send_coin_control" onClick={async () => {
                      const v = await nav.pushForResult<string[]>(Routes.unspentCoinsList, { canEdit: true, selected: selectedUtxos });
                      if (v) setSelectedUtxos(v.length ? v : undefined);
                    }}>
                      <span class="lbl">
                        <span>{t('coin_control')}</span>
                        {selectedUtxos && <span class="sub">{selectedUtxos.length} {t('selected') === 'selected' ? 'selected' : t('selected')}</span>}
                      </span>
                      <Icon src="arrow_forward.svg" w={8} h={14} color="var(--on-surface-variant)" />
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div class="col" style={{ gap: '12px', padding: '16px 0 24px' }}>
          {!synced && (
            <div class="rowx" style={{ height: '48px', borderRadius: '999px', background: '#8E5800', padding: '0 12px', gap: '10px', color: '#FFB84E' }}>
              <Spinner />
              <span>{t('synchronizing')}...</span>
            </div>
          )}
          {recipients.length > 1 && (
            <div class="rowx" style={{ justifyContent: 'center', gap: '8px' }}>
              {recipients.map((_, i) => (
                <button type="button" onClick={() => setIdx(i)} style={{ width: '36px', height: '36px', borderRadius: '50%', border: 0, fontWeight: 500, cursor: 'pointer', background: i === idx ? 'var(--primary)' : 'var(--surface-container)', color: i === idx ? 'var(--on-primary)' : 'var(--on-surface)' }}>{i + 1}</button>
              ))}
            </div>
          )}
          <Button id="send_page_send_button_key" disabled={!synced} onClick={onContinue}>{t('continue_text')}</Button>
        </div>
      </div>
    </div>
  );
}

export function pickAsset(w: WalletBase, assets: AssetInfo[], selected: string): Promise<string | undefined> {
  return showSheet<string>((close) => (
    <div class="col" style={{ height: '100%', background: 'var(--surface)' }}>
      <TopBar title={t('select_asset')} onClose={() => close()} />
      <div class="page-body" style={{ padding: '8px 16px 24px' }}>
        <div class="muted" style={{ fontSize: '12px', marginBottom: '12px' }}>{t('picker_section_gas_token')}</div>
        <div class="list">{assets.slice(0, 1).map((a) => <AssetRow a={a} sel={a.key === selected} onClick={() => close(a.key)} />)}</div>
        {assets.length > 1 && (
          <>
            <div class="muted" style={{ fontSize: '12px', margin: '24px 0 12px' }}>{t('picker_section_tokens_standard', { standard: w.type === 'solana' ? 'SPL' : w.type === 'tron' ? 'TRC-20' : w.type === 'bsc' ? 'BEP-20' : 'ERC-20' })}</div>
            <div class="list">{assets.slice(1).map((a) => <AssetRow a={a} sel={a.key === selected} onClick={() => close(a.key)} />)}</div>
          </>
        )}
      </div>
    </div>
  ), { full: true, dismissible: false });
}

function AssetRow({ a, sel, onClick }: { a: AssetInfo; sel: boolean; onClick: () => void }) {
  return (
    <button type="button" class="row tap has-icon" onClick={onClick} style={{ minHeight: '56px' }}>
      <Img src={a.icon} size={28} round />
      <span class="lbl"><span>{a.symbol}</span></span>
      <span style={{ fontSize: '12px' }}>{formatFixed(a.balance, a.decimals, { fractionDigits: 6 })} {a.symbol}</span>
      <Icon src="arrow_right.svg" w={7} h={12} color={sel ? 'var(--primary)' : 'var(--on-surface-variant)'} />
    </button>
  );
}

function pickFee(w: WalletBase, current: string, custom: number): Promise<{ priority: string; custom?: number } | undefined> {
  return showSheet((close) => <FeePicker w={w} current={current} custom={custom} close={close} />);
}

/** BTC new-UI picker hints (bitcoin_transaction_priority.dart description/hint) */
const BTC_HINTS: Record<string, [string, string]> = { fast: ['~ 30 min', '4 sat/byte'], medium: ['~ 1 h', '3 sat/byte'], slow: ['~ 24 h', '2 sat/byte'] };

function FeePicker({ w, current, custom, close }: { w: WalletBase; current: string; custom: number; close: (v?: { priority: string; custom?: number }) => void }) {
  const [sel, setSel] = useState(current);
  const [rate, setRate] = useState(custom);
  const [slider, setSlider] = useState(false);
  const opts = w.priorities();
  const ordered = w.type === 'bitcoin' ? ['fast', 'medium', 'slow', 'custom'].map((id) => opts.find((o) => o.id === id)!).filter(Boolean) : opts;
  const max = (w as any).maxCustomFeeRate?.() ?? 100;
  if (slider) {
    return (
      <div style={{ padding: '0 18px 24px' }}>
        <TopBar title={t('custom_fee')} onBack={() => setSlider(false)} />
        <div class="center" style={{ fontSize: '18px', fontWeight: 600, margin: '24px 0' }}><span style={{ color: 'var(--primary)' }}>{rate}</span> sat/byte</div>
        <input type="range" min={1} max={max} value={rate} onInput={(e) => setRate(Number((e.target as HTMLInputElement).value))} style={{ width: '100%', accentColor: 'var(--primary)' }} id="custom_fee_slider" />
        <div style={{ height: '24px' }} />
        <Button onClick={() => close({ priority: 'custom', custom: rate })}>{t('continue_text')}</Button>
      </div>
    );
  }
  return (
    <div style={{ padding: '0 12px 16px' }}>
      <TopBar title={t('set_fees')} onClose={() => close()} />
      <div class="muted center" style={{ marginBottom: '16px' }}>{t('set_fees_desc')}</div>
      <div class="picker-rows">
        {ordered.map((o) => (
          <button type="button" class="picker-row" id={`fee_${o.id}`} onClick={() => (o.isCustom ? (setSel('custom'), setSlider(true)) : setSel(o.id))}>
            <span class="pt">
              <b>{o.label} <span class="muted" style={{ fontWeight: 400 }}>{w.type === 'bitcoin' && BTC_HINTS[o.id] ? BTC_HINTS[o.id][0] : ''}</span></b>
              <span>{o.isCustom ? `${rate} sat/byte` : o.rateLabel ?? (w.type === 'bitcoin' ? BTC_HINTS[o.id]?.[1] : '')}</span>
            </span>
            {o.isCustom && sel !== 'custom' ? <Icon src="arrow_right.svg" w={7} h={12} color="var(--on-surface-variant)" /> : <span class={`check${sel === o.id ? ' on' : ''}`}>{sel === o.id && <MIcon name="check" size={18} />}</span>}
          </button>
        ))}
      </div>
      <div style={{ height: '16px' }} />
      <Button id="fee_continue" onClick={() => close({ priority: sel, custom: sel === 'custom' ? rate : undefined })}>Continue</Button>
    </div>
  );
}

/** ConfirmSwiper (lib/new-ui/widgets/confirm_swiper.dart) */
function ConfirmSwiper({ label, onConfirm }: { label: string; onConfirm: () => void }) {
  const [x, setX] = useState(0);
  const [drag, setDrag] = useState<{ start: number; max: number } | null>(null);
  return (
    <div
      id="send_page_confirm_swiper_key"
      style={{ position: 'relative', height: '56px', borderRadius: '999px', background: 'var(--surface-container-lowest)', overflow: 'hidden', userSelect: 'none', touchAction: 'none' }}
      onPointerMove={(e) => {
        if (!drag) return;
        setX(Math.max(0, Math.min(drag.max, e.clientX - drag.start)));
      }}
      onPointerUp={() => {
        if (drag && x >= drag.max - 20) {
          setX(drag.max);
          onConfirm();
        } else setX(0);
        setDrag(null);
      }}
      onPointerLeave={() => {
        if (drag) {
          setX(0);
          setDrag(null);
        }
      }}
    >
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--primary)', fontSize: '16px', letterSpacing: '0.5px', opacity: drag ? 1 - x / drag.max : 1, pointerEvents: 'none' }}>{label}</div>
      <button
        type="button"
        aria-label={label}
        onPointerDown={(e) => {
          const track = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          setDrag({ start: e.clientX - x, max: track.width - 56 });
        }}
        onKeyDown={(e) => e.key === 'Enter' && onConfirm()}
        style={{ position: 'absolute', left: `${4 + x}px`, top: '4px', width: '48px', height: '48px', borderRadius: '50%', border: 0, background: 'var(--primary)', color: 'var(--on-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'grab' }}
      >
        <MIcon name="arrowUp" size={22} style={{ transform: 'rotate(90deg)' }} />
      </button>
    </div>
  );
}

function ConfirmSheet({ w, credentials, assetSymbol, decimals, api, close }: { w: WalletBase; credentials: any; assetSymbol: string; decimals: number; api: string; close: () => void }) {
  const [state, setState] = useState<'generating' | 'ready' | 'sending' | 'sent' | 'error'>('generating');
  const [pending, setPending] = useState<PendingTransaction | null>(null);
  const [error, setError] = useState('');
  const fiatCode = settings.value.fiatCurrency;
  useEffect(() => {
    w.createTransaction(credentials)
      .then((p) => {
        setPending(p);
        setState('ready');
      })
      .catch((e) => {
        setError((e as Error).message);
        setState('error');
      });
  }, []);
  const amountNum = pending ? Number(formatFixed(pending.amount, decimals)) : 0;
  const fiat = fiatValue(amountNum, api);
  const feeFiat = pending ? fiatValue(Number(formatFixed(pending.fee, w.currency.decimals)), apiString(w.currency)) : null;
  const addresses = credentials.outputs.map((o: any) => o.extractedAddress || o.address);
  const firstAddr = addresses[0];
  const isContact = contacts.value.some((c) => c.address === firstAddr);
  if (state === 'sent') {
    return (
      <div class="col" style={{ height: '100%', background: 'var(--surface)', padding: '12px 24px 24px', gap: '12px' }} id="transaction_sent">
        <div class="center" style={{ fontSize: '24px', fontWeight: 600, marginTop: '24px' }}>{t('transaction_sent_new')}</div>
        <div class="grow" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Img src="assets/new-ui/birthday_cake.svg" size={200} />
        </div>
        <div class="rowx gap8">
          {!isContact && (
            <button type="button" class="grow rowx" style={{ background: 'var(--surface-container)', borderRadius: '16px', padding: '16px', border: 0, gap: '10px', justifyContent: 'center', color: 'var(--primary)', fontWeight: 500, cursor: 'pointer' }} onClick={() => { close(); nav.pop(); nav.push(Routes.addressBookAddContact, { address: firstAddr, currency: credentials.outputs[0].asset ?? w.currency.key }); }}>
              <Icon src="save_contact.svg" size={24} /> {t('save_contact')}
            </button>
          )}
          <button type="button" class="grow rowx" style={{ background: 'var(--surface-container)', borderRadius: '16px', padding: '16px', border: 0, gap: '10px', justifyContent: 'center', color: 'var(--primary)', fontWeight: 500, cursor: 'pointer' }} onClick={() => {
            const tx = w.transactions.value.find((x) => x.id === pending?.id);
            close();
            nav.pop();
            if (tx) void openTxDetails(w, tx);
          }}>
            <Icon src="add_note.svg" size={24} /> {t('add_a_note')}
          </button>
        </div>
        <Button id="send_done" onClick={() => { close(); nav.pop(); }}>{t('done')}</Button>
      </div>
    );
  }
  return (
    <div class="col" style={{ height: '100%', background: 'var(--surface)', borderRadius: '16px 16px 0 0' }} id="send_confirm_sheet">
      <TopBar leading={<div class="rowx gap8"><Img src={w.currency.iconPath ?? undefined} size={28} /><span style={{ fontSize: '20px', fontWeight: 500 }}>{t('send')}</span></div>} trailing={state !== 'sending' ? <ModernButton icon="close" size={36} color="var(--on-surface-variant)" onClick={close} /> : undefined} />
      <div class="page-body" style={{ padding: '0 24px 24px' }}>
        {state === 'generating' ? (
          <div class="col" style={{ alignItems: 'center', justifyContent: 'center', height: '60%', gap: '16px', color: 'var(--on-surface-variant)', fontSize: '16px', fontWeight: 500 }}>
            <Spinner large />
            {t('generating_transaction')}...
          </div>
        ) : (
          <div class="col" style={{ gap: '24px' }}>
            {pending && (
              <div class="col" style={{ alignItems: 'center' }}>
                <div style={{ fontSize: '36px' }} id="confirm_amount">{formatFixed(pending.amount, decimals)} <span class="muted">{assetSymbol}</span></div>
                {fiat !== null && <div class="muted" style={{ fontSize: '20px', fontWeight: 500 }}>{formatFiatAmount(fiat)} {fiatCode}</div>}
              </div>
            )}
            <div class="col" style={{ gap: '12px' }}>
              <div class="muted" style={{ fontSize: '16px', fontWeight: 500 }}>{t('send_to')}</div>
              {addresses.map((a: string, i: number) => (
                <div style={{ background: 'var(--surface-container)', borderRadius: '16px', padding: '12px' }}>
                  {addresses.length > 1 && <span class="muted">{i + 1}: </span>}
                  <AddressText address={a} />
                  {credentials.outputs[i].parsedName && <div class="muted" style={{ fontSize: '12px' }}>{credentials.outputs[i].parsedName}</div>}
                </div>
              ))}
            </div>
            {pending && (
              <div style={{ background: 'var(--surface-container)', borderRadius: '16px' }}>
                <div class="rowx" style={{ padding: '12px', justifyContent: 'space-between' }}>
                  <span>{t('fee')}</span>
                  <span class="col" style={{ alignItems: 'flex-end' }}>
                    <span>{pending.feeFormatted} {w.currency.title}</span>
                    {feeFiat !== null && <span class="muted">{formatFiatAmount(feeFiat)} {fiatCode}</span>}
                  </span>
                </div>
                <div class="rowx" style={{ padding: '12px', justifyContent: 'space-between', borderTop: '1px solid var(--surface-container-high)' }}>
                  <span>{t('network')}</span>
                  <span class="muted">{WALLET_TYPE_NAME[w.type]}{isEvm(w.type) ? '' : ''}</span>
                </div>
                {pending.notice && <div class="muted" id="send_confirm_notice" style={{ padding: '12px', borderTop: '1px solid var(--surface-container-high)' }}>{pending.notice}</div>}
              </div>
            )}
            {state === 'ready' && pending && (
              <ConfirmSwiper
                label={t('swipe_to_send')}
                onConfirm={async () => {
                  setState('sending');
                  try {
                    await pending.commit();
                    setState('sent');
                  } catch (e) {
                    setError((e as Error).message);
                    setState('error');
                  }
                }}
              />
            )}
            {state === 'sending' && <div class="rowx gap8 muted" style={{ justifyContent: 'center' }}><Spinner /> {t('sending')}...</div>}
            {state === 'error' && (
              <div class="col gap12">
                <div style={{ background: 'color-mix(in srgb, var(--error-container) 25%, transparent)', borderRadius: '16px', padding: '12px', color: 'var(--error)' }} id="send_error">
                  <div class="rowx gap8"><Icon src="warning.svg" size={24} color="var(--error)" /><span style={{ fontSize: '16px' }}>{t('transaction_error')}</span></div>
                  <div class="center" style={{ marginTop: '8px' }}>{error}</div>
                </div>
                <Button onClick={close}>{t('close')}</Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

registerRoute(Routes.send, SendPage);
export { useMemo };
