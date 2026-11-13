// Cake Pay (lib/cake_pay/src/**, lib/view_model/cake_pay/**): the marketplace
// (country, card types, search, endless list), buying a card (amount,
// denominations or prepaid ranges, the three confirmations, an order paid from
// the wallet), the e-mail login with a one-time code, the account, and the
// order details. Everything goes to Cake Pay over Tor.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { t } from '../../../core/i18n.ts';
import { Button, Check, Icon, Img, MIcon, ModernButton, Page, Spinner, TopBar, copyText } from '../../components/core.tsx';
import { RemoteImg } from '../../components/remoteImg.tsx';
import { showAlert, showSheet, toast } from '../../components/overlays.tsx';
import { registerRoute, Routes } from '../../routes.ts';
import { nav } from '../../nav.ts';
import { currentWallet } from '../../../app/app.ts';
import { settings, updateSettings } from '../../../app/settings.ts';
import { FIAT_FLAG, apiString, fiatValue, formatFiatAmount } from '../../../app/prices.ts';
import { formatFixed, parseFixed } from '../../../core/amount.ts';
import { isSynced, type PendingTransaction, type WalletBase } from '../../../core/wallet.ts';
import { ConfirmSwiper } from '../send.tsx';
import { openExternal } from '../dashboard/history.tsx';
import { stateOf } from '../../../exchange/types.ts';
import * as api from '../../../cakepay/api.ts';
import { CAKE_PAY_COUNTRIES, METHOD_LABEL, countryFlag, countryFromCode, formatDuration, initialCountry, methodCurrency, paymentDataFor, type CakePayCard, type CakePayOrder, type CakePayPaymentMethod, type CakePayVendor, type Country, type PrepaidRange } from '../../../cakepay/models.ts';
import { cakePayUser, createOrder, isLogged, logIn, logout, orders, refreshCakePayUser, refreshOrder, saveOrder, userEmail, verifyEmail, type OrderRecord } from '../../../cakepay/service.ts';

/** the saved country, else Germany for EUR, else the fiat's country, else the USA */
function selectedCountry(): Country {
  const saved = settings.value.selectedCakePayCountry;
  return (saved && countryFromCode(saved)) || initialCountry(FIAT_FLAG[settings.value.fiatCurrency] ?? 'usa');
}

/** ClickableLinksText: web links in a text, opened outside the app (after the Tor notice) */
function LinkText({ text, style }: { text: string; style?: Record<string, string> }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  return (
    <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', ...style }}>
      {parts.map((p, i) => (i % 2 ? <a href="#" onClick={(e) => { e.preventDefault(); void openExternal(p); }} style={{ color: 'var(--primary)' }}>{p}</a> : p))}
    </span>
  );
}

// --------------------------------------------------------- country picker --

function pickCountry(selected: Country): Promise<Country | undefined> {
  return showSheet<Country>((close) => <CountryPicker selected={selected} close={close} />, { full: true });
}

function CountryPicker({ selected, close }: { selected: Country; close: (c?: Country) => void }) {
  const [q, setQ] = useState('');
  const list = CAKE_PAY_COUNTRIES.filter((c) => c.fullName.toLowerCase().includes(q.toLowerCase()));
  return (
    <div class="col" style={{ height: '100%', background: 'var(--surface)' }} id="cake_pay_country_picker">
      <TopBar title={t('select_your_country')} onClose={() => close()} />
      <div style={{ padding: '0 18px 12px' }}>
        <div class="field"><input placeholder={t('search')} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} id="cake_pay_country_search" /></div>
      </div>
      <div class="page-body" style={{ padding: '0 18px 24px' }}>
        <div class="list">
          {list.map((c) => (
            <button type="button" class="row tap has-icon" id={`cake_pay_country_${c.code}`} onClick={() => close(c)} style={c.code === selected.code ? { color: 'var(--primary)' } : undefined}>
              <Img src={countryFlag(c)} size={24} />
              <span class="lbl"><span>{c.fullName}</span></span>
              {c.code === selected.code && <MIcon name="check" size={18} color="var(--primary)" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- cards page --

function CardsPage() {
  const [authKnown, setAuthKnown] = useState(false);
  const [vendors, setVendors] = useState<CakePayVendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingNext, setLoadingNext] = useState(false);
  const [search, setSearch] = useState('');
  const [types, setTypes] = useState({ prepaid: true, gift: true });
  const page = useRef(1);
  const hasMore = useRef(true);
  const seq = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout>>();
  const country = selectedCountry();

  /** getVendors: page 1 (a new search or filter), only vendors with a card that are available */
  const load = async (text: string, f = types, c = country) => {
    const s = ++seq.current;
    setLoading(true);
    page.current = 1;
    hasMore.current = true;
    try {
      const list = await api.getVendors({ page: 1, countryCode: c.countryCode, search: text, giftCards: f.gift, prepaidCards: f.prepaid });
      if (s === seq.current) setVendors(list.filter((v) => v.card && v.available));
    } catch {
      if (s === seq.current) setVendors([]);
    }
    if (s === seq.current) setLoading(false);
  };

  /** fetchNextPage: an "Invalid page." answer ends the list */
  const next = async () => {
    if (loading || !hasMore.current || loadingNext) return;
    setLoadingNext(true);
    page.current++;
    const s = seq.current;
    try {
      const list = await api.getVendors({ page: page.current, countryCode: country.countryCode, search, giftCards: types.gift, prepaidCards: types.prepaid });
      if (s === seq.current) setVendors((v) => [...v, ...list.filter((x) => x.card && x.available)]);
    } catch (e) {
      if (String((e as Error).message).includes('detail":"Invalid page."')) hasMore.current = false;
    } finally {
      setLoadingNext(false);
    }
  };

  useEffect(() => {
    void refreshCakePayUser().catch(() => false).then(() => setAuthKnown(true));
    void load('');
    // the country picker, once, until a country is saved
    if (!settings.peek().selectedCakePayCountry) {
      void pickCountry(country).then((c) => {
        const chosen = c ?? country;
        updateSettings({ selectedCakePayCountry: chosen.code });
        if (chosen.code !== country.code) void load(search, types, chosen);
      });
    }
    return () => clearTimeout(debounce.current);
  }, []);

  const onProfile = async () => {
    if (cakePayUser.value) {
      nav.push(Routes.cakePayAccountPage);
      return;
    }
    const ok = await nav.pushForResult<boolean>(Routes.cakePayWelcomePage);
    if (ok) await refreshCakePayUser();
  };

  const onFilter = async () => {
    const f = await showSheet<{ prepaid: boolean; gift: boolean }>((close) => <FilterSheet initial={types} close={close} />);
    if (f && (f.prepaid !== types.prepaid || f.gift !== types.gift)) {
      setTypes(f);
      void load(search, f);
    }
  };

  const onCountry = async () => {
    const c = await pickCountry(country);
    if (c && c.code !== country.code) {
      updateSettings({ selectedCakePayCountry: c.code });
      void load(search, types, c);
    }
  };

  const user = cakePayUser.value;
  return (
    <Page
      title="Cake Pay"
      legacy
      id="cake_pay_cards_page"
      bodyClass=""
      trailing={
        authKnown && user ? (
          <button type="button" aria-label={t('profile')} id="cake_pay_profile" onClick={() => void onProfile()} style={{ width: '36px', height: '36px', border: 0, background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ width: '24px', height: '24px', borderRadius: '50%', background: 'var(--primary)', color: 'var(--on-primary)', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px' }}>{user.trim()[0]?.toUpperCase()}</span>
          </button>
        ) : (
          <button type="button" aria-label={t('profile')} id="cake_pay_profile" onClick={() => void onProfile()} style={{ width: '36px', height: '36px', border: 0, background: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon src="assets/images/profile.png" size={24} color="var(--on-surface)" />
          </button>
        )
      }
    >
      {!authKnown ? (
        <div class="center" style={{ paddingTop: '40%' }}><Spinner large /></div>
      ) : (
        <div class="col" style={{ height: '100%', padding: '0 14px' }}>
          <div class="rowx" style={{ gap: '5px', padding: '6px 0 6px 2px', height: '32px', boxSizing: 'content-box', flex: 'none' }}>
            <div class="rowx grow" style={{ height: '32px', borderRadius: '10px', background: 'var(--surface-container)', padding: '0 10px', gap: '6px' }}>
              <Icon src="assets/images/mini_search_icon.png" size={16} color="var(--on-surface-variant)" />
              <input
                id="cake_pay_search"
                placeholder={t('search')}
                value={search}
                onInput={(e) => {
                  const v = (e.target as HTMLInputElement).value;
                  setSearch(v);
                  clearTimeout(debounce.current);
                  debounce.current = setTimeout(() => void load(v), 500);
                }}
                style={{ flex: 1, border: 0, outline: 'none', background: 'none', color: 'var(--on-surface)', fontSize: '14px', minWidth: 0 }}
              />
            </div>
            <button type="button" aria-label={t('filters')} id="cake_pay_filter" onClick={() => void onFilter()} style={{ width: '32px', height: '32px', borderRadius: '10px', border: 0, background: 'var(--surface-container)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon src="assets/images/filter_icon.png" size={18} color="var(--on-surface)" />
            </button>
            <button type="button" id="cake_pay_country" onClick={() => void onCountry()} class="rowx" style={{ height: '32px', padding: '0 8px', gap: '6px', borderRadius: '10px', border: 0, background: 'var(--surface-container)', cursor: 'pointer', color: 'var(--on-surface)', fontWeight: 700, fontSize: '16px' }}>
              <Img src={countryFlag(country)} size={24} />
              {country.countryCode}
            </button>
          </div>
          <div
            class="grow"
            style={{ overflowY: 'auto', minHeight: 0, paddingBottom: '24px' }}
            id="cake_pay_vendor_list"
            onScroll={(e) => {
              const el = e.currentTarget as HTMLDivElement;
              if (el.scrollTop + el.clientHeight >= el.scrollHeight - 200) void next();
            }}
          >
            {loading ? (
              <div class="center" style={{ paddingTop: '30%' }}><Spinner large /></div>
            ) : !vendors.length ? (
              <div class="center muted" style={{ paddingTop: '30%' }}>{t('no_cards_found')}</div>
            ) : (
              <div class="col" style={{ gap: '5px', padding: '0 2px' }}>
                {vendors.map((v) => <VendorItem v={v} onClick={async () => { await nav.pushForResult(Routes.cakePayBuyCardPage, { vendor: v }); await refreshCakePayUser(); }} />)}
                {loadingNext && <div class="center" style={{ padding: '12px' }}><Spinner /></div>}
              </div>
            )}
          </div>
        </div>
      )}
    </Page>
  );
}

/** CardItem */
function VendorItem({ v, onClick }: { v: CakePayVendor; onClick: () => void }) {
  return (
    <button type="button" class="rowx" id={`cake_pay_vendor_${v.id}`} onClick={onClick} style={{ width: '100%', height: '78px', borderRadius: '10px', border: 0, padding: 0, background: 'var(--surface)', color: 'var(--on-surface)', cursor: 'pointer', textAlign: 'start', overflow: 'hidden', flex: 'none' }}>
      {v.card?.cardImageUrl && (
        <span style={{ height: '100%', aspectRatio: '1.8', borderRadius: '10px', overflow: 'hidden', flex: 'none', display: 'flex', background: 'var(--surface-container)' }}>
          <CardImage url={v.card.cardImageUrl} />
        </span>
      )}
      <span class="col grow" style={{ padding: '0 8px', minWidth: 0 }}>
        <span style={{ fontSize: '18px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</span>
        <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--on-surface-variant)', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{v.card?.description ?? ''}</span>
      </span>
    </button>
  );
}

/** the card's picture (over Tor), cover-cropped; CakePayCardImagePlaceholder otherwise */
function CardImage({ url }: { url: string | null }) {
  return (
    <span style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }} class="cake-pay-card-image">
      <RemoteImg src={url} size={48} cover fallback="assets/images/cake_pay_icon.png" />
    </span>
  );
}

function FilterSheet({ initial, close }: { initial: { prepaid: boolean; gift: boolean }; close: (v?: { prepaid: boolean; gift: boolean }) => void }) {
  const [f, setF] = useState(initial);
  return (
    <div class="col" style={{ background: 'var(--surface)', borderRadius: '16px 16px 0 0', padding: '0 18px 24px' }} id="cake_pay_filters">
      <TopBar title={t('filters')} onClose={() => close(f)} />
      <div class="section-header">Card Type</div>
      <div class="list">
        <div class="row tap" onClick={() => setF({ ...f, prepaid: !f.prepaid })} id="cake_pay_filter_prepaid"><span class="lbl"><span>{t('prepaid_cards')}</span></span><Check on={f.prepaid} /></div>
        <div class="row tap" onClick={() => setF({ ...f, gift: !f.gift })} id="cake_pay_filter_gift"><span class="lbl"><span>{t('gift_cards')}</span></span><Check on={f.gift} /></div>
      </div>
      <div style={{ height: '18px' }} />
      <Button onClick={() => close(f)}>{t('ok')}</Button>
    </div>
  );
}

// --------------------------------------------------------- buy card page --

/** availableMethods: the coins of the wallet Cake Pay takes (no Lightning or MWEB here) */
function methodsFor(w: WalletBase): CakePayPaymentMethod[] {
  switch (w.type) {
    case 'bitcoin': return ['BTC'];
    case 'litecoin': return ['LTC'];
    case 'monero': return ['XMR'];
    case 'zcash': return ['ZEC'];
    default: return [];
  }
}

const toDouble = (s: string | null | undefined): number | null => {
  if (s === null || s === undefined || s === '') return null;
  const n = Number(s.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** _formatAmount: whole numbers without decimals, else 2 */
const fmtAmount = (v: number) => (v % 1 === 0 ? String(Math.trunc(v)) : v.toFixed(2));
/** Dart's double.toString */
const dartNum = (n: number) => (Number.isInteger(n) && Math.abs(n) < 1e21 ? `${n}.0` : String(n));

function BuyCardPage({ args }: { args: { vendor: CakePayVendor } }) {
  const w = currentWallet.value;
  const vendor = args.vendor;
  const card = vendor.card!;
  const methods = useMemo(() => (w ? methodsFor(w) : []), [w?.id]);
  const [method, setMethod] = useState<CakePayPaymentMethod | null>(methods[0] ?? null);
  const [amount, setAmount] = useState<number>(card.denominations.length ? card.denominations[0].value : 0);
  const [amountText, setAmountText] = useState('');
  const [quantity, setQuantity] = useState(1);
  const [range, setRange] = useState<PrepaidRange | null>(card.prepaidRange[0] ?? null);
  const [min, setMin] = useState(card.prepaidRange.length ? card.prepaidRange[0].minValue : toDouble(card.minValue) ?? 0);
  const [max, setMax] = useState(card.prepaidRange.length ? card.prepaidRange[0].maxValue : toDouble(card.maxValue) ?? 0);
  const denomination = useRef<[string, number | null]>(['', null]);
  const confirms = useRef({ noVpn: false, voidedRefund: false, terms: false });
  const [purchasing, setPurchasing] = useState(false);
  const fiat = card.fiatCurrency;

  // DenominationsAmountWidget / PrepaidRangeAmountWidget initState
  useEffect(() => {
    if (card.prepaidRange.length) {
      const r = card.prepaidRange[0];
      const a = fmtAmount(r.minValue);
      setAmountText(a);
      setAmount(Number(a));
      denomination.current = [a, Number.parseInt(r.rangeId, 10)];
    } else if (card.denominations.length) {
      const d = card.denominations[0];
      setAmountText(dartNum(d.value));
      denomination.current = [dartNum(d.value), d.cardId];
    }
  }, []);

  if (!w) return null;
  const synced = isSynced(w.syncStatus.value);
  const isDenominationSelected = card.denominations.length > 0 && card.denominations.some((d) => d.value === amount);
  const sufficient = (amount >= min && amount <= max) || (isDenominationSelected && quantity > 0);
  const amountError = sufficient ? null : amount < min ? t('error_text_input_below_minimum_limit') : amount > max ? t('error_text_input_above_maximum_limit') : null;

  const onAmountInput = (raw: string) => {
    const v = raw.replace(/[^0-9.,]/g, '');
    setAmountText(v);
    setAmount(v ? Number(v.replace(',', '.')) || 0 : 0);
    if (card.prepaidRange.length) denomination.current = [v.replace(',', '.'), denomination.current[1]];
  };

  /** confirmPurchaseFirst: signed in, the three confirmations, then the order */
  const purchase = async () => {
    if (!(await isLogged())) {
      nav.push(Routes.cakePayWelcomePage);
      return;
    }
    setPurchasing(true);
    try {
      const c = confirms.current;
      if (!c.noVpn || !c.voidedRefund || !c.terms) {
        const r = await showSheet<{ noVpn: boolean; voidedRefund: boolean; terms: boolean }>((close) => <ThreeCheckboxSheet close={close} />, { dismissible: false });
        if (r) confirms.current = r;
      }
      const ok = confirms.current;
      if (!(ok.noVpn && ok.voidedRefund && ok.terms)) return;
      if (!(await isLogged())) {
        nav.push(Routes.cakePayWelcomePage);
        return;
      }
      await createAndPay();
    } finally {
      setPurchasing(false);
    }
  };

  /** createOrder: the card id and price (prepaid range, denomination or amount), the order, its payment, the record */
  const createAndPay = async () => {
    let cardId = card.id;
    let price = dartNum(amount);
    if (card.prepaidRange.length) {
      cardId = denomination.current[1] ?? card.id;
      price = denomination.current[0] || dartNum(amount);
    } else if (isDenominationSelected) {
      cardId = denomination.current[1] ?? card.id;
      price = denomination.current[0];
    }
    let order: CakePayOrder;
    try {
      // (Cake: an unsupported wallet only gets an error after the order is made)
      order = await createOrder({ cardId, price, quantity, confirmsNoVpn: confirms.current.noVpn, confirmsVoidedRefund: confirms.current.voidedRefund, confirmsTermsAgreed: confirms.current.terms });
    } catch (e) {
      if (e instanceof api.CakePayUnauthorizedError) {
        nav.push(Routes.cakePayWelcomePage);
        return;
      }
      await showAlert({ title: t('error'), content: (e as Error).message, right: t('ok') });
      return;
    }
    const pd = paymentDataFor(method, order);
    if (!pd) {
      await showAlert({ title: t('error'), content: methods.length ? 'Payment data or order is not available.' : 'Unsupported wallet type, please use Bitcoin, Monero, Litecoin or Zcash.', right: t('ok') });
      return;
    }
    let pending: PendingTransaction;
    try {
      pending = await w.createTransaction({ outputs: [{ address: pd.address, amount: parseFixed(pd.price, w.currency.decimals), sendAll: false }], priority: settings.peek().priority[w.type] ?? w.defaultPriority() });
    } catch (e) {
      await showAlert({ title: t('error'), content: (e as Error).message, right: t('ok') });
      return;
    }
    const record: OrderRecord = { id: order.orderId, stateRaw: order.status, transferId: order.externalId ?? '', from: methodCurrency(method!), to: order.fiatCurrencyCode, createdAt: Date.now(), amount: pd.amount, receiveAmount: order.totalReceiveAmount, quantity: String(order.quantity), receiveAddress: pd.address, walletId: w.id, source: 'order', provider: 'cakePay' };
    await saveOrder(record);
    const sent = await showSheet<boolean>((close) => <PurchaseConfirmSheet w={w} order={order} pending={pending} quantity={quantity} close={close} />, { dismissible: false, full: true });
    if (sent) nav.pop();
  };

  const showText = (title: string, text: string, button: string) => showSheet<void>((close) => (
    <div class="col" style={{ background: 'var(--surface)', borderRadius: '16px 16px 0 0', maxHeight: '80vh' }}>
      <TopBar title={title} onClose={() => close()} />
      <div class="page-body" style={{ padding: '0 24px 16px' }}><LinkText text={text} style={{ fontSize: '14px' }} /></div>
      <div style={{ padding: '0 24px 24px' }}><Button onClick={() => close()}>{button}</Button></div>
    </div>
  ));

  return (
    <div class="page legacy" id="cake_pay_buy_card_page">
      <TopBar title={<span class="rowx" style={{ gap: '8px', justifyContent: 'center' }}><span style={{ width: '8px', height: '8px', borderRadius: '50%', background: synced ? '#2CCF6F' : '#FFB84E', flex: 'none' }} /><span style={{ fontSize: '18px', fontWeight: 700 }}>{card.name}</span></span>} onBack={() => nav.pop()} />
      <div class="page-body" style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ margin: '0 0 12px', padding: '16px 24px 18px', borderRadius: '0 0 24px 24px', background: 'var(--surface-container)' }}>
          <div style={{ height: '150px', borderRadius: '10px', overflow: 'hidden', boxShadow: '0 2px 8px rgba(0,0,0,.6)', marginBottom: '18px', display: 'flex', background: 'var(--surface)' }}>
            <CardImage url={card.cardImageUrl} />
          </div>
          {card.prepaidRange.length ? (
            <div class="col" style={{ gap: '12px' }}>
              <span style={{ fontSize: '16px', fontWeight: 600 }}>Select range:</span>
              <select id="cake_pay_range" value={range?.rangeId} onChange={(e) => {
                const r = card.prepaidRange.find((x) => x.rangeId === (e.target as HTMLSelectElement).value)!;
                setRange(r);
                setMin(r.minValue);
                setMax(r.maxValue);
                // onPrepaidRangeChanged + _applySelectedRange(forceAmountUpdate: true)
                const a = fmtAmount(r.minValue);
                setAmountText(a);
                setAmount(Number(a));
                denomination.current = [a, Number.parseInt(r.rangeId, 10)];
              }} style={{ padding: '10px', borderRadius: '10px', background: 'var(--surface)', color: 'var(--on-surface)', border: '1px solid var(--outline-variant)' }}>
                {card.prepaidRange.map((r) => <option value={r.rangeId}>{`${fiat} ${fmtAmount(r.minValue)} - ${fmtAmount(r.maxValue)}`}</option>)}
              </select>
              <AmountField fiat={fiat} text={amountText} onInput={(v) => { onAmountInput(v); denomination.current = [v.replace(',', '.'), range ? Number.parseInt(range.rangeId, 10) : null]; }} min={fmtAmount(min)} max={fmtAmount(max)} />
            </div>
          ) : card.denominations.length ? (
            <div class="rowx" style={{ gap: '16px', alignItems: 'flex-end' }}>
              <label class="col grow" style={{ gap: '4px' }}>
                <select id="cake_pay_denomination" value={amountText} onChange={(e) => {
                  const v = (e.target as HTMLSelectElement).value;
                  const d = card.denominations.find((x) => dartNum(x.value) === v)!;
                  setAmountText(v);
                  setAmount(d.value);
                  denomination.current = [v, d.cardId];
                }} style={{ padding: '8px', borderRadius: '8px', background: 'var(--surface)', color: 'var(--on-surface)', border: 0, fontSize: '16px' }}>
                  {card.denominations.map((d) => <option value={dartNum(d.value)}>{`${fiat} ${dartNum(d.value)}`}</option>)}
                </select>
                <span style={{ borderTop: '1px solid var(--on-surface-variant)', fontSize: '12px', color: 'var(--on-surface-variant)' }}>{t('value')}</span>
              </label>
              <label class="col" style={{ gap: '4px', width: '70px' }}>
                <input id="cake_pay_quantity" type="number" min={1} max={99} value={quantity} onInput={(e) => setQuantity(Math.max(1, Math.min(99, Number.parseInt((e.target as HTMLInputElement).value, 10) || 1)))} style={{ border: 0, outline: 'none', background: 'none', color: 'var(--on-surface)', fontSize: '16px', width: '100%' }} />
                <span style={{ borderTop: '1px solid var(--on-surface-variant)', fontSize: '12px', color: 'var(--on-surface-variant)' }}>{t('quantity')}</span>
              </label>
              <span class="col grow" style={{ gap: '4px' }}>
                <span style={{ fontSize: '16px' }}>{`${fiat} ${dartNum(amount * quantity)}`}</span>
                <span style={{ borderTop: '1px solid var(--on-surface-variant)', fontSize: '12px', color: 'var(--on-surface-variant)' }}>{t('total')}</span>
              </span>
            </div>
          ) : (
            <AmountField fiat={fiat} text={amountText} onInput={onAmountInput} min={card.minValue ?? '-'} max={card.maxValue ?? '-'} />
          )}
          {amountText && amountError && <div role="alert" style={{ fontSize: '12px', color: 'var(--error)', paddingTop: '8px' }} id="cake_pay_amount_error">{amountError}</div>}
        </div>
        <div class="col" style={{ padding: '0 24px', gap: '8px' }}>
          {vendor.cakeWarnings && <div class="center" style={{ background: 'var(--primary)', color: '#fff', borderRadius: '10px', border: '1px solid rgba(255,255,255,.2)', padding: '8px', fontSize: '12px', fontWeight: 600 }}>{vendor.cakeWarnings}</div>}
          <div style={{ maxHeight: '140px', overflowY: 'auto' }}><LinkText text={card.description} style={{ fontSize: '14px' }} /></div>
          {card.expiryAndValidity && (
            <div class="rowx" style={{ gap: '8px' }}>
              <span style={{ fontSize: '16px', fontWeight: 900 }}>{`${t('expiry_and_validity')}:`}</span>
              <span class="grow center" style={{ fontSize: '14px' }}>{card.expiryAndValidity}</span>
            </div>
          )}
          <button type="button" class="link-btn" onClick={() => void showText(t('how_to_use_card'), card.howToUse, t('got_it'))} id="cake_pay_how_to_use">{t('how_to_use_card')} ›</button>
          <button type="button" class="link-btn" onClick={() => void showText(t('settings_terms_and_conditions'), card.termsAndConditions, t('agree'))} id="cake_pay_terms">{t('settings_terms_and_conditions')} ›</button>
        </div>
        <div class="grow" />
        <div class="col" style={{ padding: '10px 20px 34px', gap: '10px' }}>
          {methods.length > 1 && method && (
            <div class="rowx" style={{ justifyContent: 'space-between', padding: '0 4px' }}>
              <span style={{ fontSize: '16px', fontWeight: 900 }}>Payment Method</span>
              <span class="rowx" style={{ gap: 0, border: '1px solid var(--outline-variant)', borderRadius: '8px', overflow: 'hidden' }}>
                {methods.map((m) => <button type="button" onClick={() => setMethod(m)} style={{ padding: '8px 12px', border: 0, background: m === method ? 'var(--surface-container-high)' : 'none', color: 'var(--on-surface)', cursor: 'pointer' }}>{METHOD_LABEL[m]}</button>)}
              </span>
            </div>
          )}
          {!synced && (
            <div class="rowx" style={{ height: '48px', borderRadius: '999px', background: '#8E5800', padding: '0 12px', gap: '10px', color: '#FFB84E' }}>
              <Spinner />
              <span>{`${t('synchronizing')}...`}</span>
            </div>
          )}
          <Button id="cake_pay_purchase" disabled={!synced || !sufficient || purchasing} loading={purchasing} onClick={() => void purchase()}>{t('purchase_gift_card')}</Button>
        </div>
      </div>
    </div>
  );
}

/** EnterAmountWidget: the fiat in front, "QTY 1" after; the limits under it */
function AmountField({ fiat, text, onInput, min, max }: { fiat: string; text: string; onInput: (v: string) => void; min: string; max: string }) {
  return (
    <div class="col" style={{ gap: '6px' }}>
      <span style={{ fontSize: '18px', fontWeight: 600 }}>{t('enter_amount')}</span>
      <div class="rowx" style={{ borderBottom: '1px solid var(--on-surface-variant)', gap: '8px', paddingBottom: '4px' }}>
        <span style={{ fontSize: '16px', fontWeight: 600 }}>{`${fiat}:`}</span>
        <input id="cake_pay_amount" inputMode="decimal" placeholder="0.00" value={text} onInput={(e) => onInput((e.target as HTMLInputElement).value)} style={{ flex: 1, border: 0, outline: 'none', background: 'none', color: 'var(--on-surface)', fontSize: '20px', minWidth: 0 }} />
        <span style={{ fontSize: '16px' }}>QTY <b>1</b></span>
      </div>
      <div class="rowx" style={{ justifyContent: 'space-between', fontSize: '12px', color: 'var(--on-surface-variant)' }}>
        <span>{`${t('min_amount', { value: min })} ${fiat}`}</span>
        <span>{`${t('max_amount', { value: max })} ${fiat}`}</span>
      </div>
    </div>
  );
}

/** ThreeCheckboxAlert */
function ThreeCheckboxSheet({ close }: { close: (v?: { noVpn: boolean; voidedRefund: boolean; terms: boolean }) => void }) {
  const [c, setC] = useState({ noVpn: false, voidedRefund: false, terms: false });
  const all = c.noVpn && c.voidedRefund && c.terms;
  const row = (k: keyof typeof c, label: string) => (
    <div class="rowx tap" style={{ gap: '12px', padding: '8px 0', cursor: 'pointer', alignItems: 'flex-start' }} onClick={() => setC({ ...c, [k]: !c[k] })} id={`cake_pay_confirm_${k}`}>
      <Check on={c[k]} />
      <span style={{ fontSize: '14px' }}>{label}</span>
    </div>
  );
  return (
    <div class="col" style={{ background: 'var(--surface)', borderRadius: '16px 16px 0 0', padding: '0 24px 24px', gap: '4px' }} id="cake_pay_three_checkbox">
      <TopBar title={t('cakepay_confirm_purchase')} />
      {row('noVpn', t('cakepay_confirm_no_vpn'))}
      {row('voidedRefund', t('cakepay_confirm_voided_refund'))}
      {row('terms', t('cakepay_confirm_terms_agreed'))}
      <a href="#" onClick={(e) => { e.preventDefault(); void openExternal('https://cakepay.com/terms/'); }} style={{ color: 'var(--primary)', fontSize: '14px', paddingTop: '8px' }}>{t('settings_terms_and_conditions')}</a>
      {!all && <div style={{ color: 'var(--error)', fontSize: '12px', paddingTop: '8px' }}>Please confirm all checkboxes</div>}
      <div class="rowx" style={{ gap: '12px', paddingTop: '16px' }}>
        <div class="grow"><Button secondary onClick={() => close()}>{t('cancel')}</Button></div>
        <div class="grow"><Button id="cake_pay_confirm_ok" disabled={!all} onClick={() => close(c)}>{t('confirm')}</Button></div>
      </div>
    </div>
  );
}

/** ConfirmSendingBottomSheet (Cake Pay): the recipient is Cake Pay and the card, the payment id and the time left */
function PurchaseConfirmSheet({ w, order, pending, quantity, close }: { w: WalletBase; order: CakePayOrder; pending: PendingTransaction; quantity: number; close: (sent?: boolean) => void }) {
  const [now, setNow] = useState(Date.now());
  const [state, setState] = useState<'ready' | 'sending' | 'sent' | 'error'>('ready');
  const [error, setError] = useState('');
  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, []);
  const left = order.paymentData.expirationTime - now;
  const expired = left < 0;
  const fiatCode = settings.value.fiatCurrency;
  const amount = Number(formatFixed(pending.amount, w.currency.decimals));
  const amountFiat = fiatValue(amount, apiString(w.currency));
  const feeFiat = fiatValue(Number(formatFixed(pending.fee, w.currency.decimals)), apiString(w.currency));
  const first = order.cards[0];
  if (state === 'sent') {
    return (
      <div class="col" style={{ height: '100%', background: 'var(--surface)', padding: '24px', gap: '16px', alignItems: 'center' }} id="cake_pay_sent">
        <div style={{ fontSize: '24px', fontWeight: 600, marginTop: '24px' }}>{t('transaction_sent_new')}</div>
        <div class="grow" style={{ display: 'flex', alignItems: 'center' }}><Img src="assets/new-ui/birthday_cake.svg" size={200} /></div>
        <button type="button" onClick={() => void copyText(order.orderId)} style={{ border: 0, background: 'var(--surface-container)', borderRadius: '16px', padding: '12px 16px', color: 'var(--on-surface)', cursor: 'pointer', overflowWrap: 'anywhere' }}>{`${t('order_id')}: ${order.orderId}`}</button>
        <div style={{ width: '100%' }}><Button onClick={() => close(true)}>{t('done')}</Button></div>
      </div>
    );
  }
  const line = (label: string, value: ComponentChildren, id?: string) => (
    <div class="rowx" style={{ padding: '12px', justifyContent: 'space-between', gap: '12px' }} id={id}>
      <span>{label}</span>
      <span style={{ textAlign: 'end', color: 'var(--on-surface-variant)', overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  );
  return (
    <div class="col" style={{ height: '100%', background: 'var(--surface)' }} id="cake_pay_confirm_sheet">
      <TopBar leading={<div class="rowx gap8"><Img src={w.currency.iconPath ?? undefined} size={28} /><span style={{ fontSize: '20px', fontWeight: 500 }}>{t('confirm_transaction')}</span></div>} trailing={state !== 'sending' ? <ModernButton icon="close" size={36} color="var(--on-surface-variant)" label={t('close')} onClick={() => close()} /> : undefined} />
      <div class="page-body" style={{ padding: '0 24px 24px' }}>
        <div class="col" style={{ gap: '20px' }}>
          <div class="col" style={{ alignItems: 'center' }}>
            <div style={{ fontSize: '32px' }} id="cake_pay_confirm_amount">{`${pending.amountFormatted} `}<span class="muted">{w.currency.title}</span></div>
            {amountFiat !== null && <div class="muted" style={{ fontSize: '18px', fontWeight: 500 }}>{`${formatFiatAmount(amountFiat)} ${fiatCode}`}</div>}
          </div>
          <div class="rowx" style={{ gap: '12px', background: 'var(--surface-container)', borderRadius: '16px', padding: '12px' }}>
            <span style={{ width: '48px', height: '30px', borderRadius: '6px', overflow: 'hidden', display: 'flex', flex: 'none' }}><RemoteImg src={first?.cardImagePath} size={30} fallback="assets/images/cakepay.png" /></span>
            <span class="col" style={{ minWidth: 0 }}>
              <span style={{ fontWeight: 600 }}>Cake Pay</span>
              <span class="muted" style={{ fontSize: '12px' }}>{first?.cardName ?? 'Cake Pay'}</span>
            </span>
            <span class="grow" />
            <span style={{ fontWeight: 500 }}>{`${order.totalReceiveAmount} ${order.fiatCurrencyCode}`}</span>
          </div>
          <div style={{ background: 'var(--surface-container)', borderRadius: '16px' }}>
            {line(t('payment_id').replace(/:\s*$/, ''), order.orderId, 'cake_pay_confirm_order')}
            {line('Expires in', expired ? '00:00:00' : formatDuration(left), 'cake_pay_confirm_expiry')}
            {line(t('send_amount').replace(/:\s*$/, ''), `${pending.amountFormatted} ${w.currency.title}`)}
            {line(`QTY: ${quantity}`, '')}
            {line(t('send_fee').replace(/:\s*$/, ''), `${pending.feeFormatted} ${w.currency.title}${feeFiat !== null ? ` (${formatFiatAmount(feeFiat)} ${fiatCode})` : ''}`)}
          </div>
          {state === 'error' && <div role="alert" style={{ color: 'var(--error)', overflowWrap: 'anywhere' }} id="cake_pay_send_error">{error}</div>}
          {expired && state === 'ready' && <div role="alert" style={{ color: 'var(--error)' }}>Order has expired.</div>}
          {state === 'sending' ? (
            <div class="rowx" style={{ justifyContent: 'center', gap: '12px', color: 'var(--on-surface-variant)' }}><Spinner /> {`${t('sending')}...`}</div>
          ) : state === 'ready' && !expired ? (
            <ConfirmSwiper label={t('swipe_to_send')} onConfirm={async () => {
              setState('sending');
              try {
                await pending.commit();
                setState('sent');
              } catch (e) {
                setError((e as Error).message);
                setState('error');
              }
            }} />
          ) : (
            <Button onClick={() => close()}>{t('close')}</Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ auth --

function WelcomePage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const login = async () => {
    setBusy(true);
    try {
      await logIn(email.trim());
    } catch (e) {
      setBusy(false);
      await showAlert({ title: t('login'), content: (e as Error).message, right: t('ok') });
      return;
    }
    setBusy(false);
    const verified = await nav.pushForResult<boolean>(Routes.cakePayVerifyOtpPage, { email: email.trim() });
    if (verified) nav.pop(true);
  };
  return (
    <Page title={t('welcome_to_cakepay')} legacy id="cake_pay_welcome_page">
      <div class="col" style={{ gap: '24px', paddingTop: '24px' }}>
        <div class="field"><input id="cake_pay_email" type="email" placeholder={t('email_address')} value={email} onInput={(e) => setEmail((e.target as HTMLInputElement).value)} autoComplete="email" /></div>
        <div style={{ fontSize: '14px' }}>{t('about_cake_pay')}</div>
        <div style={{ fontSize: '14px', color: 'var(--on-surface-variant)' }}>{t('cake_pay_account_note')}</div>
        <Button id="cake_pay_login" disabled={!valid} loading={busy} onClick={() => void login()}>{t('login')}</Button>
      </div>
    </Page>
  );
}

function OtpPage({ args }: { args: { email: string } }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const verify = async () => {
    setBusy(true);
    try {
      await verifyEmail(code.trim());
      nav.pop(true);
    } catch {
      setBusy(false);
      await showAlert({ title: t('verification'), content: 'Invalid OTP. Try again', right: t('ok') });
    }
  };
  return (
    <Page title={t('verification')} legacy id="cake_pay_otp_page">
      <div class="col" style={{ gap: '20px', paddingTop: '24px' }}>
        <div class="field"><input id="cake_pay_otp" inputMode="numeric" placeholder={t('enter_code')} value={code} onInput={(e) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ''))} autoComplete="one-time-code" /></div>
        <div style={{ fontSize: '14px', color: 'var(--on-surface-variant)' }}>{t('fill_code')}</div>
        <div class="rowx" style={{ gap: '6px', fontSize: '14px' }}>
          <span>{t('didnt_get_code')}</span>
          <button type="button" class="link-btn" style={{ width: 'auto', minHeight: 0, padding: 0 }} onClick={async () => { try { await logIn(args.email); toast(t('fill_code')); } catch (e) { toast((e as Error).message); } }}>{t('resend_code')}</button>
        </div>
        <Button id="cake_pay_otp_continue" disabled={code.length <= 5} loading={busy} onClick={() => void verify()}>{t('continue_text')}</Button>
      </div>
    </Page>
  );
}

function AccountPage() {
  const [email, setEmail] = useState('');
  useEffect(() => void userEmail().then((e) => setEmail(e ?? '')), []);
  return (
    <Page title={t('account')} legacy id="cake_pay_account_page" footer={<Button id="cake_pay_logout" onClick={async () => { await logout(email); nav.reset(Routes.dashboard); }}>{t('logout')}</Button>}>
      <div class="col" style={{ gap: '6px', paddingTop: '24px' }}>
        <span class="muted">{t('email_address')}</span>
        <span style={{ fontSize: '16px', fontWeight: 600 }} id="cake_pay_account_email">{email}</span>
      </div>
    </Page>
  );
}

// ---------------------------------------------------------- order details --

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n: number) => String(n).padStart(2, '0');
/** DateFormatter.withCurrentLocal(): "MMMM d, yyyy, HH:mm" */
const dateText = (ms: number) => {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function OrderDetailsPage({ args }: { args: { id: string } }) {
  void orders.value;
  const order = orders.value.find((o) => o.id === args.id);
  const [cards, setCards] = useState<CakePayOrder['cards']>([]);
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const r = await refreshOrder(args.id);
        if (r) setCards(r.cards);
      } catch (e) {
        // a 401 ends the polling (isCakePaySessionExpired)
        if (e instanceof api.CakePayUnauthorizedError) stop = true;
      }
    };
    void tick();
    const h = setInterval(() => void tick(), 20_000);
    return () => {
      stop = true;
      clearInterval(h);
    };
  }, [args.id]);
  if (!order) return null;
  return (
    <Page title="Order Details" legacy id="order_details_page" bodyClass="">
      <div class="col">
        <div class="col" style={{ padding: '14px 24px', gap: '6px', borderBottom: '1px solid var(--surface-container-high)' }} id="order_status">
          <span class="muted" style={{ fontSize: '14px' }}>{t('trade_details_state')}</span>
          <span style={{ fontSize: '16px' }}>{stateOf(order.stateRaw).title}</span>
        </div>
        <div style={{ padding: '12px 24px' }}>
          <button type="button" id="order_card" onClick={() => { void navigator.clipboard?.writeText(order.id).catch(() => {}); toast(t('copied_to_clipboard')); }} class="col" style={{ width: '100%', border: 0, borderRadius: '15px', padding: '16px 20px', background: 'var(--surface-container-highest)', color: 'var(--on-surface)', textAlign: 'start', cursor: 'pointer', gap: '6px' }}>
            <span style={{ fontSize: '16px', fontWeight: 600, overflowWrap: 'anywhere' }}>{`${t('order_id')}  ${order.id}`}</span>
            <span style={{ fontSize: '12px' }}>{dateText(order.createdAt)}</span>
            <span style={{ fontSize: '14px' }}>{`${order.receiveAmount ?? ''} ${order.to ?? ''} · QTY ${order.quantity ?? ''}`}</span>
            <span style={{ fontSize: '20px', fontWeight: 700, paddingTop: '12px' }}>{`${order.from ?? ''} → ${order.to ?? ''}`}</span>
            {cards.map((c) => (
              <span class="rowx" style={{ gap: '10px', paddingTop: '6px' }}>
                <span style={{ width: '40px', height: '25px', borderRadius: '4px', overflow: 'hidden', display: 'flex' }}><RemoteImg src={c.cardImagePath} size={25} fallback="assets/images/cakepay.png" /></span>
                <span>{c.cardName ?? ''}</span>
              </span>
            ))}
          </button>
        </div>
        <div class="col" style={{ padding: '14px 24px', gap: '6px', borderBottom: '1px solid var(--surface-container-high)' }}>
          <span class="muted" style={{ fontSize: '14px' }}>Order provider</span>
          <span style={{ fontSize: '16px' }}>Cake Pay</span>
        </div>
      </div>
    </Page>
  );
}

/** HistoryOrderTile: "Order", the date, the amount paid */
export function OrderTile({ order, first, last, hidden, date }: { order: OrderRecord; first?: boolean; last?: boolean; hidden?: boolean; date: string }) {
  const amount = hidden ? '---' : `${formatOrderAmount(order.amount)} ${order.from ?? ''}`;
  return (
    <button type="button" class="history-tile" id={`order_tile_${order.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`} onClick={() => nav.push(Routes.orderDetails, { id: order.id })} style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', border: 0, background: 'var(--surface-container)', padding: '12px 16px 12px 12px', cursor: 'pointer', color: 'var(--on-surface)', textAlign: 'start', borderTopLeftRadius: first ? '22px' : 0, borderTopRightRadius: first ? '22px' : 0, borderBottomLeftRadius: last ? '22px' : 0, borderBottomRightRadius: last ? '22px' : 0, position: 'relative' }}>
      {!first && <span style={{ position: 'absolute', top: 0, left: '56px', right: '16px', height: '1px', background: 'color-mix(in srgb, var(--outline-variant) 69%, transparent)' }} />}
      <Img src="assets/images/cakepay.png" size={36} />
      <span class="grow col" style={{ gap: '2px', minWidth: 0 }}>
        <span>Order</span>
        <span class="muted">{date}</span>
      </span>
      <span style={{ fontWeight: 500 }}>{amount}</span>
    </button>
  );
}

/** formatAmount (cw_core/lib/format_amount.dart) */
export function formatOrderAmount(a: string): string {
  if (!a) return a;
  if (a.endsWith('.') || a.endsWith(',')) return `${a}00`;
  if (!a.includes('.') && !a.includes(',')) return `${a}.00`;
  return a;
}

registerRoute(Routes.cakePayCardsPage, CardsPage);
registerRoute(Routes.cakePayBuyCardPage, BuyCardPage);
registerRoute(Routes.cakePayWelcomePage, WelcomePage);
registerRoute(Routes.cakePayVerifyOtpPage, OtpPage);
registerRoute(Routes.cakePayAccountPage, AccountPage);
registerRoute(Routes.orderDetails, OrderDetailsPage);
