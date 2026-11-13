// Swap (lib/new-ui/pages/swap_page.dart, widgets/swap_page/swap_amount_box.dart,
// swap_limit_popup.dart, swap_address_selection_modal.dart, refund_address_modal.dart,
// send_page/fiat_amount_bar.dart).

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { t } from '../../../core/i18n.ts';
import { Button, Icon, Img, ModernButton, Spinner, TopBar } from '../../components/core.tsx';
import { showAlert, showSheet, toast } from '../../components/overlays.tsx';
import { requireAuth } from '../../components/auth.tsx';
import { registerKeepAlive, registerRoute, Routes } from '../../routes.ts';
import { nav } from '../../nav.ts';
import { currentWallet, openWallet, walletInfos } from '../../../app/app.ts';
import { settings, updateSettings } from '../../../app/settings.ts';
import { contacts } from '../../../app/contacts.ts';
import { resolveAddress } from '../../../app/resolver.ts';
import { parsePaymentRequest } from '../../../core/paymentUri.ts';
import { formatFixed } from '../../../core/amount.ts';
import { isSynced, type WalletBase } from '../../../core/wallet.ts';
import { ALL_CURRENCIES, currencyFromString, isEvm, type WalletType } from '../../../coins/types.ts';
import { iconFor } from '../dashboard/wallets.tsx';
import { EVM_DEFAULT_TOKENS, EVM_TOKEN_TAGS } from '../../../coins/tokens.gen.ts';
import { ExchangeVM } from '../../../exchange/exchange.ts';
import { builtin, builtinOf, chainIconOf, eqCurrency, fromCurrency, fromToken, memoLabelType, symbolOf, walletTypeOf, type SwapCurrency } from '../../../exchange/currency.ts';
import { walletAssetFor } from '../../../exchange/send.ts';
import { pickSwapCurrency, type PickerArgs, type PickerBalance } from './picker.tsx';
import { openSwapConfirm } from './confirm.tsx';
import { middleTruncate } from './util.ts';

const WARN_BG = '#8E5800';
const WARN_FG = '#FFB84E';

/** DecimalInputFormatter: digits and one separator, at most `max` decimals */
function decimalInput(v: string, max: number): string {
  let s = v.replace(/[^0-9.,]/g, '');
  const i = s.search(/[.,]/);
  if (i >= 0) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/[.,]/g, '');
  if (max <= 0) return s.replace(/[.,].*$/, '');
  const m = /^(\d*)([.,])(\d*)$/.exec(s);
  return m ? `${m[1]}${m[2]}${m[3].slice(0, max)}` : s;
}

/** AmountValidator */
function validateAmount(value: string, c: SwapCurrency, min: number | null, max: number | null): string | null {
  if (!value || !/^(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(value)) return t('error_text_amount');
  const frac = value.split(/[.,]/)[1] ?? '';
  if (frac.length > c.decimals) return t('decimal_places_error');
  const n = Number.parseFloat(value.replace(',', '.'));
  if (min !== null && n < min) return t('error_text_input_below_minimum_limit');
  if (max !== null && n > max) return t('error_text_input_above_maximum_limit');
  return null;
}

/** the wallet's assets as swap currencies, with their balances (_depositBalanceByAsset) */
function depositBalances(vm: ExchangeVM): Map<string, PickerBalance> {
  const w = vm.wallet;
  const map = new Map<string, PickerBalance>();
  const list = ((w as any).assetList?.() ?? [{ key: w.currency.key, symbol: w.currency.title, decimals: w.currency.decimals, balance: w.balances.value[w.currency.key]?.available ?? 0n, isNative: true }]) as { key: string; symbol: string; name?: string; decimals: number; balance: bigint; address?: string; isNative: boolean; icon?: string }[];
  const tag = isEvm(w.type) ? EVM_TOKEN_TAGS[w.type] : w.type === 'solana' ? 'SOL' : w.type === 'tron' ? 'TRX' : null;
  for (const a of list) {
    const c = a.isNative ? fromCurrency(w.currency) : vm.currencies.value.find((x) => x.address && x.address.toLowerCase() === a.address?.toLowerCase()) ?? vm.currencies.value.find((x) => !x.address && x.title === a.symbol.toUpperCase() && x.tag === tag) ?? (a.address && tag ? fromToken({ symbol: a.symbol, name: a.name ?? a.symbol, address: a.address, decimals: a.decimals, icon: a.icon }, tag) : null);
    if (!c) continue;
    const amount = formatFixed(a.balance, a.decimals);
    const p = vm.priceOf(c);
    const fiat = p ? Number(amount) * p : null;
    map.set(c.id, { amount: `${amount} ${a.symbol.toUpperCase()}`, fiat: fiat !== null && settings.value.fiatApiMode !== 'disabled' ? `${fiat.toFixed(2)} ${settings.value.fiatCurrency}` : undefined, fiatValue: fiat ?? undefined });
  }
  return map;
}

/** _pickableAssets: the list plus Base/Arbitrum/Polygon default tokens; Bitcoin wallets put BTC Lightning first */
function pickable(vm: ExchangeVM): SwapCurrency[] {
  const list = [...vm.currencies.value];
  const key = (c: SwapCurrency) => `${c.title.toUpperCase()}|${walletTypeOf(c) ?? (c.tag ?? '').toUpperCase()}`;
  const seen = new Set(list.map(key));
  for (const type of ['base', 'arbitrum', 'polygon'] as const) {
    for (const tk of EVM_DEFAULT_TOKENS[type] ?? []) {
      const c = fromToken(tk, EVM_TOKEN_TAGS[type]);
      if (!seen.has(key(c))) {
        seen.add(key(c));
        list.push(c);
      }
    }
  }
  if (vm.wallet.type === 'bitcoin') list.sort((a, b) => (builtinOf(a)?.key === 'btcln' ? -1 : builtinOf(b)?.key === 'btcln' ? 1 : 0));
  return list;
}

// ------------------------------------------------------------- the sheets --

/** RefundAddressModal: the address (possibly '') or undefined when closed */
export function askRefundAddress(c: SwapCurrency, fromWalletSelection: boolean): Promise<string | undefined> {
  return showSheet<string>((close) => <RefundSheet c={c} fromWalletSelection={fromWalletSelection} close={close} />);
}

function RefundSheet({ c, fromWalletSelection, close }: { c: SwapCurrency; fromWalletSelection: boolean; close: (v?: string) => void }) {
  const [v, setV] = useState('');
  return (
    <div class="col" style={{ background: 'var(--surface)', borderRadius: '16px 16px 0 0', paddingBottom: '24px' }} id="refund_address_sheet">
      <TopBar title={t('set_refund_address')} trailing={<ModernButton icon="close" size={36} color="var(--on-surface-variant)" label={t('close')} onClick={() => close()} />} />
      <div class="col" style={{ padding: '0 16px', gap: '24px', alignItems: 'center' }}>
        <Icon src="refund_address.svg" size={48} color="var(--primary)" />
        <div class="center" style={{ color: 'var(--on-surface-variant)', fontSize: '14px', whiteSpace: 'pre-line' }}>{t('return_address_desc') + (fromWalletSelection ? `\n\n${t('return_address_desc_external')}` : '')}</div>
        <div class="col" style={{ gap: '12px', width: '100%' }}>
          <AddressInput value={v} onInput={setV} placeholder={`${c.title} ${t('address')}`} id="refund_address_input" />
          {(fromWalletSelection || v) && <Button id="refund_address_continue" onClick={() => close(v.trim())}>{v ? t('continue_text') : t('skip_set_later')}</Button>}
        </div>
      </div>
    </div>
  );
}

function AddressInput({ value, onInput, placeholder, id }: { value: string; onInput: (v: string) => void; placeholder: string; id: string }) {
  return (
    <div class="field" style={{ borderRadius: '16px' }}>
      <textarea rows={2} value={value} placeholder={placeholder} id={id} class="mono" spellcheck={false} onInput={(e) => onInput((e.target as HTMLTextAreaElement).value)} style={{ resize: 'none' }} />
      <span class="rowx" style={{ gap: '8px' }}>
        <button type="button" class="ficon" aria-label={t('paste')} onClick={async () => { try { onInput((await navigator.clipboard.readText()).trim()); } catch { /* blocked */ } }}><Icon src="paste.svg" size={20} /></button>
        <button type="button" class="ficon" aria-label={t('scan')} onClick={async () => { const s = await nav.pushForResult<string>('/scan', { mode: 'address' }); if (s) onInput(parsePaymentRequest(s).address); }}><Icon src="scan.svg" size={20} /></button>
      </span>
    </div>
  );
}

interface SelectionResult {
  address?: string;
  walletId?: string;
  walletType?: WalletType;
  walletName?: string;
  accountName?: string;
}

/** the wallets of a currency's wallet type (depositWallets / receiveWallets) */
function walletsFor(c: SwapCurrency) {
  const type = walletTypeOf(c) ?? (c.tag ? (currencyFromString(c.tag) ? walletTypeOf(fromCurrency(currencyFromString(c.tag)!)) : undefined) : undefined);
  return type ? walletInfos.value.filter((w) => w.type === type) : [];
}

/** SwapAddressSelectionModal */
function openAddressSelection(vm: ExchangeVM, receiver: boolean): Promise<SelectionResult | undefined> {
  return showSheet<SelectionResult>((close) => <AddressSelection vm={vm} receiver={receiver} close={close} />);
}

function AddressSelection({ vm, receiver, close }: { vm: ExchangeVM; receiver: boolean; close: (r?: SelectionResult) => void }) {
  const c = receiver ? vm.receiveCurrency.value : vm.depositCurrency.value;
  const items = walletsFor(c);
  const [text, setText] = useState('');
  const w = currentWallet.value;
  return (
    <div class="col" style={{ background: 'var(--surface)', borderRadius: '24px 24px 0 0', maxHeight: '60vh' }} id="swap_address_selection">
      <TopBar title={`${receiver ? t('receive_to') : t('send_from')}...`} onClose={() => close()} />
      {!receiver && items.length > 0 && <div style={{ padding: '0 18px 6px', color: 'var(--on-surface-variant)', fontSize: '14px' }}>{t('available_wallets')}</div>}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 18px 12px' }}>
        {items.length === 0 ? (
          <div class="center" style={{ color: 'var(--on-surface-variant)', padding: '16px 0' }}>{`${t('no_wallets_for')} ${c.fullName ?? c.title}.`}</div>
        ) : (
          items.map((it) => {
            const icon = iconFor(it.type);
            const accounts = receiver && it.type === 'monero' && w?.id === it.id ? w.accounts.value.filter((a) => a.label.split(' ').length > 1 && a.address) : [];
            const selected = receiver && vm.receiveAddress.value === it.address;
            return (
              <div style={{ padding: '6px 0' }}>
                <button type="button" id={`swap_wallet_${it.id}`} onClick={() => close({ address: it.address, walletId: it.id, walletType: it.type, walletName: it.name })} class="rowx" style={{ width: '100%', gap: '12px', padding: '14px 16px', borderRadius: '16px', border: selected ? '1px solid var(--primary)' : '1px solid transparent', background: 'var(--surface-container)', color: 'var(--on-surface)', cursor: 'pointer', textAlign: 'start' }}>
                  <Img src={icon} size={28} />
                  <span class="grow" style={{ fontWeight: 500 }}>{it.name}</span>
                  <Icon src="arrow_right.svg" w={7} h={12} color="var(--on-surface-variant)" />
                </button>
                {accounts.length > 0 && (
                  <div class="col" style={{ gap: '4px', padding: '6px 0 0 24px' }}>
                    {accounts.map((a) => (
                      <button type="button" onClick={() => close({ address: a.address!, walletId: it.id, walletType: it.type, walletName: it.name, accountName: a.label })} class="rowx" style={{ gap: '10px', padding: '10px 14px', borderRadius: '12px', border: vm.receiveAddress.value === a.address ? '1px solid var(--primary)' : '1px solid transparent', background: 'var(--surface-container)', color: 'var(--on-surface)', cursor: 'pointer', textAlign: 'start' }}>
                        <span class="grow">{a.label}</span>
                        <span class="muted mono" style={{ fontSize: '12px' }}>{middleTruncate(a.address!, 6, 6)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
      <div style={{ height: '1px', background: 'var(--surface-container-high)' }} />
      {!receiver ? (
        <div style={{ padding: '24px 18px 32px' }}>
          <button type="button" id="swap_send_from_external" onClick={() => close({})} class="rowx" style={{ width: '100%', height: '55px', justifyContent: 'center', gap: '10px', borderRadius: '16px', border: 0, background: 'var(--surface-container)', color: 'var(--primary)', fontSize: '15px', fontWeight: 500, cursor: 'pointer' }}>
            <Icon src="send_from_external.svg" size={24} color="var(--primary)" />
            {t('send_from_external')}
          </button>
        </div>
      ) : (
        <div class="rowx" style={{ padding: '18px 24px', gap: '8px' }}>
          <div class="grow"><AddressInput value={text} onInput={setText} placeholder={`${c.title} ${t('address')}`} id="swap_receiver_address" /></div>
          {text && <ModernButton icon="arrowUp" size={44} bg="var(--primary)" color="var(--on-primary)" label={t('continue_text')} id="swap_receiver_submit" onClick={() => close({ address: text.trim() })} />}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------- the amount box --

/** FiatAmountBar */
function FiatBar({ fiatMode, onSwitch, converted, max, maxActive, onMax }: { fiatMode: boolean; onSwitch: () => void; converted: string; max?: string | null; maxActive: boolean; onMax?: () => void }) {
  const fmt = (s: string) => {
    const n = Number.parseFloat(s);
    return /^[\d.]+$/.test(s) && Number.isFinite(n) ? n.toPrecision(8).replace(/\.?0+$/, '') : s;
  };
  return (
    <div class="rowx" style={{ justifyContent: 'space-between', gap: '8px' }}>
      <span class="rowx" style={{ gap: '8px', minWidth: 0 }}>
        <ModernButton svg="switch.svg" size={28} iconSize={18} bg="var(--surface-container-high)" label={t('switch_input_currency')} onClick={onSwitch} />
        <button type="button" onClick={onSwitch} style={{ border: 0, background: 'none', padding: 0, color: 'var(--on-surface-variant)', cursor: 'pointer', fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} aria-hidden="true" tabIndex={-1}>{converted}</button>
      </span>
      {max && (
        <span class="rowx" style={{ gap: '8px', flex: 'none' }}>
          <span style={{ color: 'var(--on-surface-variant)', fontSize: '14px' }}>{`${t('max')}.`}</span>
          <button type="button" id="swap_max" onClick={onMax} aria-label={t('max')} style={{ border: 0, borderRadius: '999px', padding: '4px 8px', cursor: 'pointer', fontSize: '14px', background: maxActive ? 'var(--surface-container-high)' : 'transparent', color: maxActive ? 'var(--primary)' : 'var(--on-surface-variant)' }}>{fmt(max)}</button>
        </span>
      )}
    </div>
  );
}

function AmountBox({ vm, receiver, error, onEdited }: { vm: ExchangeVM; receiver: boolean; error: string | null; onEdited: () => void }) {
  const cur = receiver ? vm.receiveCurrency.value : vm.depositCurrency.value;
  const vmAmount = receiver ? vm.receiveAmount : vm.depositAmount;
  const sendAll = !receiver && vm.isSendAllEnabled.value;
  const [text, setText] = useState(vmAmount);
  const [fiatMode, setFiatMode] = useState(false);
  const [fiatText, setFiatText] = useState('');
  const focused = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const fiatTimer = useRef<ReturnType<typeof setTimeout>>();
  const all = t('all');
  // VM → field (not while typing; "ALL" while sending everything)
  useEffect(() => {
    if (fiatMode) return;
    if (sendAll) {
      setText(all);
      return;
    }
    if (focused.current && Number.parseFloat(text.replace(',', '.')) === Number.parseFloat(vmAmount)) return;
    if (!focused.current || receiver) setText(vmAmount);
  }, [vmAmount, sendAll, fiatMode]);
  useEffect(() => () => {
    clearTimeout(timer.current);
    clearTimeout(fiatTimer.current);
  }, []);
  const fiatValue = receiver ? vm.receiveAmountFiat : vm.depositAmountFiat;
  useEffect(() => {
    if (fiatMode && !focused.current) setFiatText(fiatValue === '0.00' ? '' : fiatValue.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
  }, [fiatValue, fiatMode]);
  const onAmount = (raw: string) => {
    const v = decimalInput(raw, cur.decimals);
    setText(v);
    onEdited();
    clearTimeout(timer.current);
    if (receiver) {
      if (v === vm.receiveAmount) return;
      timer.current = setTimeout(() => {
        void vm.calculateBestRate();
        void vm.changeReceiveAmount(v);
        vm.enableFixedRateMode();
      }, 500);
      return;
    }
    if (v === vm.depositAmount || v === all) return;
    vm.isSendAllEnabled.value = false;
    const slow = vm.selectedProviders.value.some((p) => p.title === 'Chainflip' || p.title === 'THORChain');
    timer.current = setTimeout(() => {
      void vm.calculateBestRate();
      if (v !== vm.depositAmount && v !== all) void vm.changeDepositAmount(v);
      vm.disableFixedRateMode();
    }, slow ? 1000 : 500);
  };
  const onFiat = (raw: string) => {
    const v = decimalInput(raw, 2);
    setFiatText(v);
    onEdited();
    if (receiver) vm.enableFixedRateMode();
    else {
      vm.disableFixedRateMode();
      vm.isSendAllEnabled.value = false;
    }
    clearTimeout(fiatTimer.current);
    fiatTimer.current = setTimeout(() => {
      if (!Number.isFinite(Number.parseFloat(v))) return;
      if (receiver) vm.setReceiveAmountFromFiat(v);
      else vm.setDepositAmountFromFiat(v);
    }, 200);
  };
  const showFetching = !receiver && vm.isFixedRateMode.value && !!vm.receiveAmount && !vm.depositAmount;
  const chain = chainIconOf(cur);
  const symbol = symbolOf(cur);
  const fiatCode = settings.value.fiatCurrency;
  const converted = fiatMode ? `${(receiver ? vm.roundedReceiveAmount(6) : vm.roundedDepositAmount(6)) || '0'} ${symbol}` : `${(receiver ? vm.roundedReceiveAmountFiat(6) : vm.roundedDepositAmountFiat(6)) || '0'} ${fiatCode}`;
  const hasAll = !receiver && !vm.isSendFromExternal.value && vm.hasAllAmount;
  const maxText = receiver ? null : hasAll ? vm.depositAvailableAmount.value : vm.balanceDisplay;
  const addressEmpty = receiver ? !vm.receiveAddress.value : !vm.depositAddress.value;
  const pickerText = receiver ? (addressEmpty ? t('select_receiver') : t('to')) : t('from');
  const description = receiver ? vm.receiveAddressDisplayName.value ?? middleTruncate(vm.receiveAddress.value, 8, 8) : vm.isSendFromExternal.value ? t('external') : vm.wallet.name;
  const primaryChip = addressEmpty && receiver;
  const memo = receiver ? memoLabelType(cur) : null;

  const presentCurrencyPicker = async () => {
    const all = pickable(vm);
    let args: PickerArgs;
    if (receiver) {
      args = { items: all, selected: cur, recents: true };
    } else {
      const balances = depositBalances(vm);
      const titles = new Set([...balances.keys()].map((id) => vm.currencies.value.find((c) => c.id === id)?.title.toUpperCase() ?? (all.find((c) => c.id === id)?.title.toUpperCase() ?? '')));
      const items = balances.size ? all.filter((c) => titles.has(c.title.toUpperCase())) : all;
      const other: PickerArgs = { items: all, selected: cur, recents: true };
      args = vm.isSendFromExternal.value ? other : { items, selected: cur, filterByNetwork: vm.wallet.type, balanceByAsset: balances, useSingleNetworkLayout: true, recents: true, walletName: vm.wallet.name, otherAssets: other };
    }
    const r = await pickSwapCurrency(args);
    if (!r) return;
    if (receiver) vm.changeReceiveCurrency(r.currency);
    else {
      vm.changeDepositCurrency(r.currency);
      await vm.onDepositCurrencyChanged();
      if (r.fromOtherAssets && walletsFor(r.currency).length) await presentWalletPicker();
    }
  };

  const presentWalletPicker = async () => {
    const r = await openAddressSelection(vm, receiver);
    if (!r) return;
    if (receiver) {
      if (r.address === undefined) return;
      vm.selectedAddressBookWallet = r.walletId && r.walletType ? { id: r.walletId, type: r.walletType } : null;
      vm.receiveAddress.value = r.address;
      if (r.walletName) vm.receiveAddressDisplayName.value = r.accountName ? `${r.walletName} → ${r.accountName}` : r.walletName;
      return;
    }
    if (!r.address) {
      vm.isSendFromExternal.value = true;
      const refund = await askRefundAddress(vm.depositCurrency.value, true);
      vm.depositAddress.value = refund ?? '';
      return;
    }
    // switchToDepositWallet
    if (r.walletId && r.walletId !== vm.wallet.id) {
      try {
        const w = await openWallet(r.walletId);
        vm.setWallet(w);
      } catch (e) {
        toast(t('wallet_list_failed_to_load', { wallet_name: r.walletName ?? '', error: (e as Error).message }));
        return;
      }
    }
    const can = vm.useSameWalletAddress(vm.depositCurrency.value);
    vm.isSendFromExternal.value = !can;
    vm.depositAddress.value = can ? await vm.wallet.addressForExchange() : '';
    if (!can) {
      const refund = await askRefundAddress(vm.depositCurrency.value, true);
      vm.depositAddress.value = refund ?? '';
    }
  };

  const pasteReceiver = async () => {
    let text = '';
    try {
      text = (await navigator.clipboard.readText()).trim();
    } catch {
      return;
    }
    vm.receiveAddress.value = text;
    vm.receiveAddress.value = await parsedAddress(vm, text, vm.receiveCurrency.value);
  };

  return (
    <div class="col" style={{ gap: '12px' }} id={receiver ? 'swap_receive_box' : 'swap_deposit_box'}>
      <div style={{ fontSize: '12px', fontWeight: 500, color: 'var(--on-surface-variant)' }}>{receiver ? t('receive') : t('send')}</div>
      <div class="col" style={{ gap: '12px', padding: '16px', borderRadius: '24px', background: 'var(--surface-container)' }}>
        <div>
          <div class="rowx" style={{ gap: '4px', justifyContent: 'space-between' }}>
            <span class="rowx grow" style={{ gap: '4px', minWidth: 0 }}>
              <input
                id={receiver ? 'swap_page_receive_amount_field_key' : 'swap_page_deposit_amount_field_key'}
                inputMode="decimal"
                autoComplete="off"
                value={fiatMode ? fiatText : text}
                placeholder={showFetching ? t('fetching') : '0'}
                onFocus={() => {
                  focused.current = true;
                  if (receiver) vm.enableFixedRateMode();
                  else vm.disableFixedRateMode();
                }}
                onBlur={() => {
                  focused.current = false;
                  if (!receiver) vm.disableFixedRateMode();
                }}
                onInput={(e) => (fiatMode ? onFiat : onAmount)((e.target as HTMLInputElement).value)}
                style={{ flex: 1, minWidth: 0, border: 0, outline: 'none', background: 'none', padding: 0, fontSize: '28px', fontWeight: 400, color: 'var(--on-surface)' }}
              />
              {fiatMode && <span style={{ fontSize: '16px', color: 'var(--on-surface-variant)' }}>{fiatCode}</span>}
            </span>
            <button type="button" id={receiver ? 'swap_amount_box_receive_currency_button_key' : 'swap_amount_box_deposit_currency_button_key'} onClick={() => void presentCurrencyPicker()} class="rowx" style={{ flex: 'none', padding: '4px', borderRadius: '999px', border: 0, background: 'var(--surface)', color: 'var(--on-surface)', cursor: 'pointer', gap: 0 }}>
              <Img src={cur.iconPath ?? undefined} size={28} round />
              <span style={{ marginLeft: '10px' }}>{symbol}</span>
              {chain ? <span style={{ margin: '0 6px 0 4px', display: 'flex' }}><Icon src={chain} size={12} color="var(--on-surface-variant)" /></span> : <span style={{ width: '10px' }} />}
              <span style={{ width: '16px', height: '16px', borderRadius: '50%', background: 'var(--surface-container-high)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginRight: '4px' }}>
                <Icon src="dropdown_arrow.svg" w={8} h={5} color="var(--primary)" style={{ transform: 'rotate(180deg)' }} />
              </span>
            </button>
          </div>
          {error && !fiatMode && <div role="alert" style={{ paddingTop: '6px', fontSize: '12px', color: 'var(--error)' }} id={receiver ? 'swap_receive_error' : 'swap_deposit_error'}>{error}</div>}
        </div>
        <FiatBar
          fiatMode={fiatMode}
          converted={converted}
          max={maxText}
          maxActive={hasAll}
          onSwitch={() => {
            const next = !fiatMode;
            setFiatMode(next);
            if (next) setFiatText(fiatValue === '0.00' ? '' : fiatValue.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
            else setText(sendAll ? all : receiver ? vm.receiveAmount : vm.depositAmount);
          }}
          onMax={() => {
            if (!vm.hasAllAmount) return;
            setFiatMode(false);
            vm.enableSendAllAmount();
          }}
        />
        <div class="rowx" style={{ gap: '8px' }}>
          <button type="button" id={receiver ? 'swap_receiver_button' : 'swap_sender_button'} onClick={() => void presentWalletPicker()} class="rowx grow" style={{ minWidth: 0, height: '36px', padding: '0 12px', borderRadius: '9999px', border: 0, cursor: 'pointer', justifyContent: 'space-between', background: primaryChip ? 'var(--primary)' : 'var(--surface-container-high)' }}>
            <span class="rowx" style={{ gap: '8px', minWidth: 0 }}>
              <span style={{ fontSize: '12px', fontWeight: 500, color: primaryChip ? 'var(--on-primary)' : 'var(--on-surface)', flex: 'none' }}>{pickerText}</span>
              <span style={{ fontSize: '12px', fontWeight: 500, color: 'var(--primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{description}</span>
            </span>
            <Icon src="dropdown_arrow.svg" w={8} h={5} color={primaryChip ? 'var(--on-primary)' : 'var(--on-surface)'} style={{ transform: 'rotate(180deg)' }} />
          </button>
          {!receiver && vm.isSendFromExternal.value && !vm.depositAddress.value && (
            <ModernButton svg="refund_address.svg" size={36} iconSize={18} bg="var(--surface-container-highest)" label={t('refund_address')} id="swap_refund_button" onClick={async () => { const r = await askRefundAddress(vm.depositCurrency.value, true); vm.depositAddress.value = r ?? ''; }} />
          )}
          {receiver && !vm.receiveAddress.value && (
            <>
              <ModernButton svg="paste.svg" size={36} iconSize={20} bg="var(--surface-container-high)" label={t('paste')} id="swap_receiver_paste" onClick={() => void pasteReceiver()} />
              <ModernButton svg="scan.svg" size={36} iconSize={20} bg="var(--surface-container-high)" label={t('scan')} id="swap_receiver_scan" onClick={async () => { const s = await nav.pushForResult<string>('/scan', { mode: 'address' }); if (s) vm.receiveAddress.value = parsePaymentRequest(s).address; }} />
            </>
          )}
        </div>
        {memo && (
          <div class="col" style={{ gap: '6px' }}>
            <div class="field" style={{ borderRadius: '16px', background: 'var(--surface-container-high)' }}>
              <input value={vm.receiveAddressExtraId.value} maxLength={memo === 'destinationTag' ? 20 : 256} placeholder={memo === 'destinationTag' ? t('destination_tag_optional') : t('memo_optional')} id="swap_receive_memo" onInput={(e) => (vm.receiveAddressExtraId.value = (e.target as HTMLInputElement).value)} />
              <span class="muted" style={{ fontSize: '12px' }}>{`${vm.receiveAddressExtraId.value.length}/${memo === 'destinationTag' ? 20 : 256}`}</span>
            </div>
            <div style={{ fontSize: '12px', color: 'var(--on-surface-variant)' }}>{memo === 'destinationTag' ? t('destination_tag_swap_disclaimer') : t('memo_swap_disclaimer')}</div>
          </div>
        )}
      </div>
    </div>
  );
}

/** fetchParsedAddress: OpenAlias / ENS / … names to the currency's address */
async function parsedAddress(vm: ExchangeVM, text: string, c: SwapCurrency): Promise<string> {
  const b = builtinOf(c) ?? (c.tag ? currencyFromString(c.tag) : undefined);
  if (!text || !b) return text;
  try {
    const r = await resolveAddress(text, vm.wallet, b);
    return r?.address ?? text;
  } catch {
    return text;
  }
}

/** SwapLimitPopup */
function LimitPopup({ vm }: { vm: ExchangeVM }) {
  const amount = vm.depositMoney.value !== null ? Number.parseFloat(vm.depositMoney.value) : null;
  const max = vm.limits.value.max ?? Infinity;
  const min = vm.limits.value.min ?? 0;
  const tooLarge = amount !== null && max !== 0 && amount > max;
  const tooSmall = amount !== null && min !== 0 && amount < min;
  if (amount === null || !(tooLarge || tooSmall)) return null;
  const needed = String(tooLarge ? max : min).replace(/^(\d*\.\d{8})\d+$/, '$1');
  return (
    <div style={{ paddingTop: '12px' }} id="swap_limit_popup">
      <div class="center" style={{ padding: '12px 0', borderRadius: '99999px', background: WARN_BG, color: WARN_FG, fontWeight: 500, fontSize: '12px' }}>{`${tooLarge ? t('enter_less_than') : t('enter_greater_than')} ${needed} ${vm.depositCurrency.value.title}`}</div>
    </div>
  );
}

/** SwapProviderPreview */
function ProviderPreview({ vm }: { vm: ExchangeVM }) {
  const fetchingDeposit = vm.isFixedRateMode.value && !!vm.receiveAmount;
  if (!vm.depositAmount && !fetchingDeposit) return null;
  const provider = vm.forcedProvider.value ?? vm.providerDisplay.value;
  const rate = vm.forcedProvider.value ? vm.forcedProviderRate.value : vm.bestRate.value;
  return (
    <button type="button" id="swap_provider_preview" onClick={() => provider && nav.push(Routes.swapProviderSelector, { vm })} class="rowx" style={{ width: '100%', height: '48px', padding: '0 12px', borderRadius: '16px', border: 0, background: 'var(--surface-container)', justifyContent: 'space-between', cursor: provider ? 'pointer' : 'default', color: 'var(--on-surface)' }}>
      <span class="rowx" style={{ gap: '12px' }}>
        {provider ? <Img src={provider.description.image} size={28} /> : <Spinner />}
        <span style={{ fontSize: '14px', color: provider ? 'var(--on-surface)' : 'var(--on-surface-variant)' }}>{provider?.title ?? `${t('finding_provider')}...`}</span>
      </span>
      {provider && (
        <span class="rowx" style={{ gap: '4px' }}>
          <span style={{ fontSize: '14px', color: 'var(--on-surface-variant)' }} id="swap_rate">{`1 ${vm.depositCurrency.value.title} ≈ ${rate.toFixed(6)} ${vm.receiveCurrency.value.title}`}</span>
          <Icon src="chooser.svg" size={24} color="var(--on-surface-variant)" />
        </span>
      )}
    </button>
  );
}

// -------------------------------------------------------------- the page --

/** args: from / to (a currency key, or a token address of the wallet), PaymentRequest fields */
function SwapPage({ args }: { args?: { from?: string; to?: string; address?: string; amount?: string } }) {
  const w = currentWallet.value;
  if (!w) return null;
  return <SwapForm key={w.id} w={w} args={args} />;
}

function currencyFromArg(vm: ExchangeVM, key: string | undefined): SwapCurrency | null {
  if (!key) return null;
  const w = vm.wallet;
  const asset = ((w as any).assetList?.() ?? []).find((a: any) => a.key === key && !a.isNative);
  if (asset?.address) {
    const tag = isEvm(w.type) ? EVM_TOKEN_TAGS[w.type] : w.type === 'solana' ? 'SOL' : w.type === 'tron' ? 'TRX' : null;
    return vm.currencies.value.find((c) => c.address?.toLowerCase() === asset.address.toLowerCase()) ?? vm.currencies.value.find((c) => !c.address && c.title === asset.symbol.toUpperCase() && c.tag === tag) ?? (tag ? fromToken({ symbol: asset.symbol, name: asset.name ?? asset.symbol, address: asset.address, decimals: asset.decimals, icon: asset.icon }, tag) : null);
  }
  return ALL_CURRENCIES.some((c) => c.key === key) ? builtin(key) : null;
}

function SwapForm({ w, args }: { w: WalletBase; args?: { from?: string; to?: string; address?: string; amount?: string } }) {
  const vm = useMemo(() => new ExchangeVM(w), []);
  // for the end-to-end tests (window.__cw.swap)
  useEffect(() => {
    const g = globalThis as { __cw?: Record<string, unknown> };
    if (g.__cw) g.__cw.swap = vm;
    return () => {
      if (g.__cw?.swap === vm) delete g.__cw.swap;
    };
  }, []);
  const [errors, setErrors] = useState<{ deposit: string | null; receive: string | null }>({ deposit: null, receive: null });
  const [validated, setValidated] = useState(false);
  const started = useRef(false);
  useEffect(() => {
    const from = currencyFromArg(vm, args?.from);
    if (from && !eqCurrency(from, vm.depositCurrency.peek())) {
      vm.changeDepositCurrency(from);
      void vm.onDepositCurrencyChanged();
    }
    const to = currencyFromArg(vm, args?.to);
    if (to && !eqCurrency(to, vm.receiveCurrency.peek())) vm.changeReceiveCurrency(to);
    if (args?.address) vm.receiveAddress.value = args.address;
    if (args?.amount) vm.receiveMoney.value = args.amount;
    // FeesViewModel.isLowFee: after 1 s, Ignore / Use Suggested
    const lowFee = setTimeout(async () => {
      if (!isLowFee(vm.wallet)) return;
      const ok = await showAlert({ title: t('low_fee'), content: t('low_fee_alert'), left: t('ignor'), right: t('use_suggested') });
      if (ok === true) updateSettings((s) => ({ priority: { ...s.priority, [vm.wallet.type]: vm.wallet.defaultPriority() } }));
    }, 1000);
    return () => {
      clearTimeout(lowFee);
      vm.dispose();
    };
  }, []);
  // the bestRate reaction: the other amount follows the new rate
  const lastRate = useRef(0);
  useEffect(() => {
    const r = vm.bestRate.value;
    if (r === lastRate.current) return;
    lastRate.current = r;
    if (vm.isFixedRateMode.peek()) void vm.changeReceiveAmount(vm.receiveAmount);
    else void vm.changeDepositAmount(vm.isSendAllEnabled.peek() ? vm.depositAmount : vm.depositAmount);
  }, [vm.bestRate.value]);
  const lastForced = useRef(0);
  useEffect(() => {
    const r = vm.forcedProviderRate.value;
    if (r === lastForced.current) return;
    lastForced.current = r;
    if (vm.forcedProvider.peek() && r === 0) return;
    if (vm.isFixedRateMode.peek()) void vm.changeReceiveAmount(vm.receiveAmount);
    else if (vm.depositAmount) void vm.changeDepositAmount(vm.depositAmount);
  }, [vm.forcedProviderRate.value]);
  // the tradeState reaction: an error alert, or the confirm sheet
  useEffect(() => {
    const s = vm.tradeState.value;
    if (s.kind === 'failed') void showAlert({ title: t('provider_error', { provider: s.title }), content: s.error, right: t('ok') });
    if (s.kind === 'created' && !started.current) {
      started.current = true;
      void openSwapConfirm(vm, s.trade, vm.receiveAmount).finally(() => (started.current = false));
    }
  }, [vm.tradeState.value]);
  // the synced reaction: the "Max." amount
  const synced = isSynced(vm.wallet.syncStatus.value);
  useEffect(() => {
    if (synced && vm.hasAllAmount) void vm.updateDepositAvailableAmount();
  }, [synced, vm.depositCurrency.value, vm.wallet.balances.value]);
  void contacts.value;

  const validate = (): boolean => {
    const l = vm.limits.value;
    const dep = !vm.isFixedRateMode.value && vm.depositAmount !== t('all') && !vm.isSendAllEnabled.value ? validateAmount(vm.depositAmount, vm.depositCurrency.value, l.min, l.max) : null;
    const rec = vm.isFixedRateMode.value ? validateAmount(vm.receiveAmount, vm.receiveCurrency.value, l.min, l.max) : null;
    setErrors({ deposit: dep, receive: rec });
    setValidated(true);
    return !dep && !rec;
  };
  const onSwap = async () => {
    (document.activeElement as HTMLElement | null)?.blur();
    if (!vm.isAvailableInSelected) {
      nav.push(Routes.swapProviderPicker, { vm });
      return;
    }
    if (!validate()) return;
    const k = builtinOf(vm.depositCurrency.value)?.key;
    if ((k === 'xmr' || k === 'btc' || k === 'ltc') && !isSynced(vm.wallet.syncStatus.value)) {
      await showAlert({ title: t('exchange'), content: t('exchange_sync_alert_content'), right: t('ok') });
      return;
    }
    // shouldDisplayTOTP: 2FA for swaps into one's own wallets / elsewhere
    const own = walletInfos.value.some((x) => x.address === vm.receiveAddress.value);
    const s = settings.value;
    if (!(await requireAuth({ totp: own ? s.shouldRequireTOTP2FAForExchangesToInternalWallets : s.shouldRequireTOTP2FAForExchangesToExternalWallets }))) return;
    await vm.createTrade();
  };
  const creating = vm.tradeState.value.kind === 'creating';
  return (
    <div class="page solid" id="swap_page">
      <TopBar title={t('swap')} onClose={() => nav.pop()} trailing={<ModernButton svg="options.svg" size={36} iconSize={20} label={t('configure')} id="swap_configure" onClick={() => nav.push(Routes.swapOptions, { vm })} />} />
      <div style={{ height: '24px', flex: 'none' }} />
      <div class="page-body" style={{ padding: '0 18px' }}>
        <AmountBox vm={vm} receiver={false} error={validated ? errors.deposit : null} onEdited={() => setValidated(false)} />
        <LimitPopup vm={vm} />
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '12px 0' }}>
          <div style={{ position: 'absolute', left: 0, right: 0, height: '1px', background: 'var(--surface-container-high)' }} />
          <span style={{ position: 'relative', background: 'var(--surface)', borderRadius: '50%' }}>
            <ModernButton svg="swap_amounts.svg" size={36} iconSize={24} bg="var(--surface-container)" label={t('swap_reverse_direction')} id="swap_reverse" onClick={() => vm.reverseSwapDirection()} />
          </span>
        </div>
        <AmountBox vm={vm} receiver={true} error={validated ? errors.receive : null} onEdited={() => setValidated(false)} />
      </div>
      <div class="col" style={{ gap: '12px', padding: '12px 18px 24px', flex: 'none' }}>
        {!synced && (
          <div class="rowx" style={{ height: '48px', borderRadius: '999px', background: WARN_BG, padding: '0 12px', gap: '10px', color: WARN_FG }} id="swap_syncing">
            <Spinner />
            <span>{t('synchronizing')}...</span>
          </div>
        )}
        {vm.isFixedRateMode.value && <div class="center" style={{ fontSize: '12px', color: 'var(--on-surface-variant)' }} id="swap_fixed_text">{t('exchange_rate_is_fixed')}</div>}
        <ProviderPreview vm={vm} />
        <Button id="exchange_page_exchange_button_key" loading={creating} disabled={vm.swapDisabled} onClick={() => void onSwap()}>
          {vm.isAvailableInSelected ? t('swap') : t('change_selected_exchanges')}
        </Button>
      </div>
    </div>
  );
}

/** FeesViewModel.isLowFee: the slow priority where Cake warns about it */
function isLowFee(w: WalletBase): boolean {
  if ((w as any).chainId === 42161) return false;
  const p = settings.value.priority[w.type] ?? w.defaultPriority();
  return ['monero', 'wownero', 'haven', 'zano', 'bitcoin', 'litecoin', 'ethereum', 'polygon', 'base', 'bsc', 'bitcoinCash', 'decred', 'dogecoin'].includes(w.type) && p === 'slow';
}

registerRoute(Routes.exchange, SwapPage);
registerKeepAlive(Routes.exchange);

