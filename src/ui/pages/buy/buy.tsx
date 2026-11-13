// Buy / Sell (lib/new-ui/widgets/buy_sell/buy_sell_selector_modal.dart,
// lib/new-ui/pages/buy_sell/*): Buy or Sell, the amount (preset amounts or a
// custom one), the providers' quotes, the payment method, the confirmation and
// the hand-over to the provider's page.

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { t } from '../../../core/i18n.ts';
import { Button, Icon, Img, MIcon, Spinner, TopBar } from '../../components/core.tsx';
import { RemoteImg } from '../../components/remoteImg.tsx';
import { showAlert, showSheet } from '../../components/overlays.tsx';
import { registerKeepAlive, registerRoute, Routes } from '../../routes.ts';
import { nav } from '../../nav.ts';
import { currentWallet } from '../../../app/app.ts';
import { builtin, type SwapCurrency } from '../../../exchange/currency.ts';
import { BuySellVM } from '../../../buy/buysell.ts';
import { isMonochromeIcon, paymentMethodIcon, paymentMethodTitle, paymentTypeTitle, quoteBadgeKeys, type BuyMode, type PaymentMethod, type Quote } from '../../../buy/types.ts';
import { chooseFiat, FIAT_NAMES } from '../settings/pages.tsx';
import { pickSwapCurrency } from '../swap/picker.tsx';
import { badgeFor } from '../swap/util.ts';
import { cutDigits, formatWithCommas, groupThousands } from '../../../buy/format.ts';
import { themeRaw } from '../../theme/themes.ts';

/** FiatCurrency.emoji */
const FIAT_EMOJI: Record<string, string> = {"AMD":"🇦🇲","ARS":"🇦🇷","AUD":"🇦🇺","BDT":"🇧🇩","BGN":"🇧🇬","BRL":"🇧🇷","CAD":"🇨🇦","CHF":"🇨🇭","CLP":"🇨🇱","CNY":"🇨🇳","COP":"🇨🇴","CZK":"🇨🇿","DKK":"🇩🇰","EGP":"🇪🇬","EUR":"🇪🇺","GBP":"🇬🇧","GHS":"🇬🇭","GTQ":"🇬🇹","HKD":"🇭🇰","HRK":"🇭🇷","HUF":"🇭🇺","IDR":"🇮🇩","ILS":"🇮🇱","INR":"🇮🇳","IRR":"🇮🇷","ISK":"🇮🇸","JPY":"🇯🇵","KRW":"🇰🇷","MAD":"🇲🇦","MXN":"🇲🇽","MYR":"🇲🇾","NGN":"🇳🇬","NOK":"🇳🇴","NZD":"🇳🇿","PHP":"🇵🇭","PKR":"🇵🇰","PLN":"🇵🇱","RON":"🇷🇴","RUB":"🇷🇺","SAR":"🇸🇦","SEK":"🇸🇪","SGD":"🇸🇬","THB":"🇹🇭","TWD":"🇹🇼","UAH":"🇺🇦","USD":"🇺🇸","VEF":"🇻🇪","VND":"🇻🇳","ZAR":"🇿🇦","TRY":"🇹🇷","KES":"🇰🇪"};

const GRADIENT_CARD = 'linear-gradient(to bottom, var(--card-gradient-primary), var(--card-gradient-secondary))';

/** Quote.lightIconPath / darkIconPath: the ramp's logo (aggregators), else the provider's for the theme */
function logoOf(q: Quote): string {
  void themeRaw.value;
  const light = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light';
  if (q.provider.isAggregator && q.rampIconPath) return q.rampIconPath;
  return light ? q.provider.lightIcon : q.provider.icon;
}

/** the quote's crypto as MoneyText shows it (8 digits, grouped) */
const moneyText = (amount: string, c: SwapCurrency) => `${groupThousands(cutDigits(amount, 8))} ${c.title}`;

/** BuySellSelectorModal */
export function openBuySellSelector(): Promise<void> {
  return showSheet<void>((close) => <Selector close={close} />, { gradient: true }).then(() => {});
}

function Selector({ close }: { close: () => void }) {
  const open = (mode: BuyMode) => {
    close();
    nav.push(Routes.buySellPage, { mode });
  };
  const option = (title: string, desc: string, icon: string, mode: BuyMode) => (
    <button type="button" id={`buy_sell_selector_${mode}`} onClick={() => open(mode)} class="rowx" style={{ width: '100%', gap: '20px', padding: '24px', borderRadius: '16px', border: '1px solid var(--surface-container-high)', background: GRADIENT_CARD, color: 'var(--on-surface)', cursor: 'pointer', textAlign: 'start' }}>
      <Icon src={icon} size={55} color="var(--on-surface-variant)" />
      <span class="col" style={{ gap: '8px' }}>
        <span style={{ fontWeight: 500, fontSize: '16px' }}>{title}</span>
        <span style={{ fontSize: '12px', color: 'var(--on-surface-variant)' }}>{desc}</span>
      </span>
    </button>
  );
  return (
    <div class="col" style={{ gap: '24px', alignItems: 'center', padding: '24px 0', borderRadius: '18px 18px 0 0' }} id="buy_sell_selector">
      <div style={{ fontSize: '20px', fontWeight: 500 }}>{t('buy_or_sell')}</div>
      <div style={{ fontSize: '12px', color: 'var(--on-surface-variant)' }}>{t('buy_or_sell_desc')}</div>
      <div class="col" style={{ gap: '12px', padding: '0 18px', width: '100%', boxSizing: 'border-box' }}>
        {option(t('buy_crypto'), t('buy_crypto_desc'), 'plus.svg', 'buy')}
        {option(t('sell_crypto'), t('sell_crypto_desc'), 'sell.svg', 'sell')}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- shared --

function TokenChain({ c, size }: { c: SwapCurrency; size: number }) {
  const badge = badgeFor(c);
  return (
    <span style={{ position: 'relative', width: `${size}px`, height: `${size}px`, flex: 'none', display: 'inline-flex' }}>
      <Img src={c.iconPath ?? undefined} size={size} round />
      {badge && !c.chainIconPath && c.tag && (
        <span style={{ position: 'absolute', right: '-2px', bottom: '-2px', width: '14px', height: '14px', padding: '3px', boxSizing: 'border-box', borderRadius: '4px', background: 'var(--on-surface)', display: 'flex' }}>
          <Icon src={badge} size={8} color="var(--surface)" />
        </span>
      )}
    </span>
  );
}

/** BuySellCurrencyPickerPill */
function CurrencyPill({ title, crypto, fiat, onClick, id }: { title: string; crypto?: SwapCurrency; fiat?: string; onClick: () => void; id: string }) {
  return (
    <div class="col" style={{ gap: '12px' }}>
      <span style={{ color: 'var(--on-surface-variant)' }}>{title}</span>
      <button type="button" id={id} onClick={onClick} class="rowx" style={{ width: '100%', height: '62px', padding: '0 12px', borderRadius: '18px', border: 0, background: 'var(--surface-container)', color: 'var(--on-surface)', cursor: 'pointer', justifyContent: 'space-between', textAlign: 'start' }}>
        <span class="rowx" style={{ gap: '12px', minWidth: 0 }}>
          {crypto ? <TokenChain c={crypto} size={30} /> : <span style={{ width: '30px', fontSize: '24px', lineHeight: 1 }}>{FIAT_EMOJI[fiat!] ?? ''}</span>}
          <span class="col" style={{ gap: '2px', minWidth: 0 }}>
            <span>{crypto ? crypto.fullName ?? crypto.title : FIAT_NAMES[fiat!] ?? fiat}</span>
            <span style={{ fontSize: '12px', color: 'var(--on-surface-variant)' }}>{crypto ? crypto.title : fiat}</span>
          </span>
        </span>
        <Icon src="dropdown_arrow.svg" size={8} color="var(--primary)" style={{ transform: 'rotate(180deg)' }} />
      </button>
    </div>
  );
}

function Shell({ id, title, bottomText, onClose, onBack, children, footer }: { id: string; title: string; bottomText?: string; onClose?: () => void; onBack?: () => void; children: ComponentChildren; footer?: ComponentChildren }) {
  return (
    <div class="page" id={id}>
      <TopBar title={title} bottomText={bottomText} onClose={onClose} onBack={onBack} />
      <div class="page-body" style={{ display: 'flex', flexDirection: 'column' }}>{children}</div>
      {footer && <div style={{ padding: '18px', flex: 'none' }}>{footer}</div>}
    </div>
  );
}

/** wait until the condition holds (asyncWhen) */
function until(cond: () => boolean): Promise<void> {
  return new Promise((ok) => {
    if (cond()) return ok();
    const h = setInterval(() => {
      if (cond()) {
        clearInterval(h);
        ok();
      }
    }, 100);
  });
}

const title = (vm: BuySellVM) => `${vm.isBuy ? t('buy') : t('sell')} ${vm.cryptoCurrency.value.fullName ?? ''}`;

// ----------------------------------------------------------- amount page --

/** args: mode (buy by default, as Routes.buySellPage opens) and the currency (a currency key; the charts) */
function AmountPage({ args }: { args?: { mode?: BuyMode; currency?: string } }) {
  const w = currentWallet.value;
  if (!w) return null;
  return <AmountForm key={w.id} args={args} />;
}

function AmountForm({ args }: { args?: { mode?: BuyMode; currency?: string } }) {
  const w = currentWallet.value!;
  const vm = useMemo(() => {
    let initial: SwapCurrency | undefined;
    if (args?.currency) {
      try {
        initial = builtin(args.currency);
      } catch { /* not a currency key */ }
    }
    return new BuySellVM(w, args?.mode ?? 'buy', initial);
  }, []);
  const [custom, setCustom] = useState(false);
  const [loadingMethods, setLoadingMethods] = useState(false);
  const [text, setText] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // "a hack for the 'up to' display": quotes for the fourth preset amount
    void vm.changeFiatAmount(vm.defaultAmounts[3]);
    void vm.calculateBestRate();
    const g = globalThis as { __cw?: Record<string, unknown> };
    if (g.__cw) g.__cw.buy = vm;
    return () => {
      if (g.__cw?.buy === vm) delete g.__cw.buy;
    };
  }, []);
  useEffect(() => {
    if (custom) input.current?.focus();
  }, [custom]);

  const navigateToProviders = async () => {
    if (loadingMethods) return;
    setLoadingMethods(true);
    try {
      await until(() => vm.paymentMethodState.peek() === 'loaded' || vm.paymentMethodState.peek() === 'failed');
      if (vm.paymentMethodState.peek() === 'failed') {
        await showAlert({ title: t('failed_to_load_payment_methods'), content: t('please_try_again_later'), right: 'OK' });
        return;
      }
      const all = vm.paymentMethods.peek().find((m) => m.type === 'all');
      if (all) vm.changePaymentMethod(all);
      void vm.calculateBestRate();
      nav.push(Routes.buySellProviders, { vm });
    } finally {
      setLoadingMethods(false);
    }
  };

  const onPreset = async (amount: string | null) => {
    if (amount === null) {
      // resets the rate (no "0 USD = 0.0… BTC")
      await vm.changeFiatAmount('');
      setCustom(true);
      return;
    }
    if (vm.isBuy) await vm.changeFiatAmount(amount);
    else await vm.setCryptoAmountFromFiat(amount);
    await navigateToProviders();
  };

  const selectCrypto = async () => {
    const r = await pickSwapCurrency({ items: vm.activeWalletCurrencies, selected: vm.cryptoCurrency.value });
    if (r) vm.changeCryptoCurrency(r.currency);
  };
  const selectFiat = async () => {
    const f = await chooseFiat(vm.fiatCurrency.value);
    if (f) vm.changeFiatCurrency(f);
  };

  const fiat = vm.fiatCurrency.value;
  const max = vm.maxFiatAmount;
  const crypto = vm.cryptoCurrency.value;
  void vm.quoteState.value;
  return (
    <Shell id="buy_sell_amount_page" title={vm.isBuy ? t('buy') : t('sell')} bottomText={custom && max !== null ? `${t('up_to')} ~${max} ${fiat}` : undefined} onClose={() => nav.pop()}>
      {custom ? (
        <div class="col" style={{ flex: 1, justifyContent: 'space-between' }}>
          <span />
          <div class="col" style={{ gap: '8px', alignItems: 'center' }}>
            <div class="rowx" style={{ justifyContent: 'center', alignItems: 'baseline', gap: '8px', maxWidth: '100%' }}>
              <input
                ref={input}
                id="buy_sell_custom_amount"
                inputMode="decimal"
                autoComplete="off"
                value={text}
                placeholder="0.00"
                size={Math.max(4, text.length + 1)}
                onInput={(e) => {
                  const v = (e.target as HTMLInputElement).value.replace(/[^0-9.,]/g, '');
                  setText(v);
                  if (vm.isBuy) void vm.changeFiatAmount(v);
                  else void vm.setCryptoAmountFromFiat(v);
                }}
                style={{ border: 0, outline: 'none', background: 'none', color: 'var(--on-surface)', fontSize: '45px', fontWeight: 400, textAlign: 'end', padding: 0, minWidth: 0, maxWidth: '70vw' }}
              />
              <span style={{ fontSize: '45px', fontWeight: 400, color: 'var(--on-surface-variant)' }}>{fiat}</span>
            </div>
            <div style={{ opacity: vm.cryptoAmount.value ? 1 : 0, fontSize: '18px', fontWeight: 600, color: 'var(--on-surface-variant)' }} id="buy_sell_custom_crypto">{`≈ ${vm.cryptoAmount.value} ${crypto.title}`}</div>
          </div>
          <div style={{ padding: '18px' }}>
            <Button id="buy_sell_custom_continue" disabled={!text} loading={loadingMethods} onClick={() => void navigateToProviders()}>{t('continue_text')}</Button>
          </div>
        </div>
      ) : (
        <div class="col" style={{ gap: '24px', padding: '0 18px 24px' }}>
          {vm.hasMultipleCurrencies && <CurrencyPill title={vm.isBuy ? t('buy') : t('sell')} crypto={crypto} onClick={() => void selectCrypto()} id="buy_sell_crypto_pill" />}
          <CurrencyPill title={vm.isBuy ? t('purchase_with') : t('receive')} fiat={fiat} onClick={() => void selectFiat()} id="buy_sell_fiat_pill" />
          <span style={{ color: 'var(--on-surface-variant)' }}>{vm.isBuy ? t('choose_amount_to_buy') : t('choose_amount_to_sell')}</span>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', columnGap: '8px', rowGap: '16px' }}>
            {[...vm.defaultAmounts, null].map((a) => (
              <button type="button" id={`buy_sell_amount_${a ?? 'custom'}`} onClick={() => void onPreset(a)} class="col" style={{ height: '105px', borderRadius: '9999px', border: '1px solid var(--surface-container-high)', background: GRADIENT_CARD, color: 'var(--on-surface)', cursor: 'pointer', alignItems: 'center', justifyContent: 'center', gap: '2px' }}>
                {loadingMethods && a === vm.fiatAmount.value ? (
                  <Spinner />
                ) : (
                  <>
                    <span class="rowx" style={{ gap: '4px', fontSize: '18px', fontWeight: 600 }}>
                      {a !== null && <span>{groupThousands(a)}</span>}
                      <span style={{ color: a === null ? 'var(--primary)' : 'var(--on-surface-variant)' }}>{a === null ? t('custom') : fiat}</span>
                    </span>
                    {a === null && <span style={{ fontSize: '12px', color: 'var(--on-surface-variant)' }}>{t('enter_amount')}</span>}
                  </>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </Shell>
  );
}

// --------------------------------------------------------- provider page --

/** BuySellQuoteFailure */
function QuoteFailure({ vm }: { vm: BuySellVM }) {
  const s = vm.quoteState.value;
  const rec = vm.recommendedFiat;
  const recommended = rec && rec !== vm.fiatCurrency.value ? rec : null;
  return (
    <div class="col" style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: '24px', padding: '0 18px', textAlign: 'center' }} id="buy_sell_quote_failure">
      <MIcon name="warning_amber" size={48} />
      <div class="col" style={{ gap: '10px' }}>
        <span style={{ fontSize: '20px', fontWeight: 500 }}>{t('could_not_load_quotes')}</span>
        <span>{recommended ? t('providers_in_region_use_fiat', { fiat: recommended }) : s.kind === 'failed' ? s.error : ''}</span>
      </div>
      {recommended && <Button onClick={() => void vm.retryWithRecommendedFiat()}>{t('switch_to_fiat', { fiat: recommended })}</Button>}
    </div>
  );
}

function QuoteRow({ vm, q }: { vm: BuySellVM; q: Quote }) {
  const amount = vm.amountForQuote(q);
  const fiat = vm.fiatAmountForQuote(q);
  const badges = quoteBadgeKeys(q).map((k) => t(k));
  return (
    <button type="button" class="row tap has-icon" id={`buy_sell_quote_${(q.rampName ?? q.provider.title).replace(/[^A-Za-z0-9]/g, '')}`} onClick={() => { vm.changeQuote(q); nav.push(Routes.buySellConfirmation, { vm }); }}>
      <RemoteImg src={logoOf(q)} size={32} fallback={q.provider.icon} />
      <span class="lbl">
        <span>
          {q.rampName ?? q.provider.title}
          {q.rampName != null && <span class="sec"> {q.provider.title}</span>}
        </span>
        {badges.length > 0 && <span class="sub" style={{ color: 'var(--primary)' }}>{badges.join(' - ')}</span>}
      </span>
      <span class="col" style={{ alignItems: 'flex-end', gap: '4px', flex: 'none' }}>
        {amount !== null && <span>{moneyText(amount, vm.cryptoCurrency.value)}</span>}
        {fiat !== null && <span style={{ fontSize: '12px', color: 'var(--on-surface-variant)' }}>{`= ${fiat} ${vm.fiatCurrency.value}`}</span>}
      </span>
      <Icon src="arrow_forward.svg" w={8} h={14} color="var(--on-surface-variant)" class="chev" />
    </button>
  );
}

function ProviderPage({ args }: { args: { vm: BuySellVM } }) {
  const vm = args.vm;
  const [expanded, setExpanded] = useState(false);
  const s = vm.quoteState.value;
  let body: ComponentChildren;
  if (s.kind === 'loading' || s.kind === 'initial') {
    body = (
      <div class="rowx" style={{ flex: 1, justifyContent: 'center', gap: '8px', color: 'var(--on-surface-variant)' }} id="buy_sell_loading_rates">
        <Spinner />
        <span>{t('loading_rates')}</span>
      </div>
    );
  } else if (s.kind === 'failed') body = <QuoteFailure vm={vm} />;
  else {
    const more = vm.sortedQuotes.value;
    body = (
      <div class="col" style={{ gap: '24px', padding: '0 18px 24px' }}>
        <div class="list">
          <button type="button" class="row tap" id="buy_sell_payment_method_row" onClick={() => nav.push(Routes.buySellPaymentMethods, { vm })}>
            <span class="lbl"><span>{t('payment_method')}</span></span>
            <span class="trail">{vm.selectedPaymentMethod.value ? paymentMethodTitle(vm.selectedPaymentMethod.value) : ''}</span>
            <Icon src="arrow_forward.svg" w={8} h={14} color="var(--on-surface-variant)" class="chev" />
          </button>
        </div>
        <div>
          <div class="section-header">{t('available_providers')}</div>
          <div class="list" id="buy_sell_quotes">
            {vm.sortedRecommendedQuotes.value.map((q) => <QuoteRow vm={vm} q={q} />)}
            {more.length > 0 && (
              <button type="button" class="row tap" id="buy_sell_more_options" onClick={() => setExpanded(!expanded)}>
                <span class="lbl"><span>{t('more_options')}</span></span>
                <Icon src="dropdown_arrow.svg" size={10} color="var(--on-surface-variant)" style={{ transform: expanded ? 'none' : 'rotate(180deg)' }} />
              </button>
            )}
            {expanded && more.map((q) => <QuoteRow vm={vm} q={q} />)}
          </div>
        </div>
      </div>
    );
  }
  return (
    <Shell id="buy_sell_provider_page" title={title(vm)} onBack={() => nav.pop()}>
      {body}
    </Shell>
  );
}

// --------------------------------------------------- payment method page --

function PaymentMethodPage({ args }: { args: { vm: BuySellVM } }) {
  const vm = args.vm;
  const sel = vm.selectedPaymentMethod.value;
  const pick = (m: PaymentMethod) => {
    vm.changePaymentMethod(m);
    void vm.calculateBestRate();
    nav.pop();
  };
  return (
    <Shell id="buy_sell_payment_method_page" title={t('payment_method')} onBack={() => nav.pop()}>
      <div style={{ padding: '0 18px 24px' }}>
        <div class="list">
          {vm.paymentMethods.value.map((m) => {
            const icon = paymentMethodIcon(m);
            return (
              <button type="button" class="row tap has-icon" id={`buy_sell_method_${paymentMethodTitle(m).replace(/[^A-Za-z0-9]/g, '')}`} onClick={() => pick(m)}>
                {isMonochromeIcon(icon) ? <Icon src={icon} size={24} color="var(--on-surface-variant)" /> : <RemoteImg src={icon} size={24} fallback="assets/new-ui/buy_payment_methods/debit_card.svg" />}
                <span class="lbl"><span>{paymentMethodTitle(m)}</span></span>
                {sel === m && <MIcon name="check" size={16} color="var(--primary)" />}
              </button>
            );
          })}
        </div>
      </div>
    </Shell>
  );
}

// ------------------------------------------------------ confirmation page --

function ConfirmationPage({ args }: { args: { vm: BuySellVM } }) {
  const vm = args.vm;
  const q = vm.selectedQuote.value;
  if (!q) return null;
  const amount = vm.amountForQuote(q);
  const crypto = vm.cryptoCurrency.value;
  const methodTitle = paymentTypeTitle(q.paymentType) ?? q.customPaymentMethodType;
  const max = q.limits?.max;
  const limits = q.limits && max != null && max !== Infinity ? `${q.limits.min ?? 0} - ${max}` : null;
  // topLeftSubTitle
  const rate = q.rate > 0 ? `1 ${crypto.title} = ${formatWithCommas(q.rate.toFixed(2))} ${vm.fiatCurrency.value}` : '';
  const row = (label: string, trailing: ComponentChildren, id: string) => (
    <div class="row" id={id}>
      <span class="lbl"><span>{label}</span></span>
      {trailing}
    </div>
  );
  return (
    <Shell
      id="buy_sell_confirmation_page"
      title={title(vm)}
      onBack={() => nav.pop()}
      footer={<Button id="buy_sell_proceed" onClick={() => nav.replaceFrom(Routes.buySellPage, Routes.buySellRedirecting, { vm })}>{t('proceed')}</Button>}
    >
      <div class="col" style={{ gap: '24px', alignItems: 'center' }}>
        <div class="col" style={{ gap: '4px', alignItems: 'center' }}>
          <span style={{ fontSize: '32px' }} id="buy_sell_confirm_fiat">{`${vm.fiatAmount.value} ${vm.fiatCurrency.value}`}</span>
          {amount !== null && <span style={{ color: 'var(--on-surface-variant)', fontWeight: 500 }} id="buy_sell_confirm_crypto">{`≈ ${cutDigits(amount, 8)} ${crypto.title}`}</span>}
        </div>
        <div style={{ padding: '0 18px', width: '100%', boxSizing: 'border-box' }}>
          <div class="list">
            {row(t('provider'), <span class="rowx" style={{ gap: '8px', color: 'var(--on-surface-variant)', fontWeight: 500 }}><RemoteImg src={logoOf(q)} size={24} fallback={q.provider.icon} />{q.rampName ?? q.provider.title}</span>, 'buy_sell_confirm_provider')}
            {methodTitle ? row(t('payment_method'), <span class="trail">{methodTitle}</span>, 'buy_sell_confirm_method') : null}
            {row(t('rate'), <span class="trail">{rate}</span>, 'buy_sell_confirm_rate')}
            {limits && row('Limits', <span class="trail">{limits}</span>, 'buy_sell_confirm_limits')}
          </div>
        </div>
      </div>
    </Shell>
  );
}

// ------------------------------------------------------- redirecting page --

/**
 * BuySellRedirectingPage: after 2 s the provider's link is prepared (DFX signs in over Tor). Cake then opens it in
 * the browser; a web page may only open a tab on a tap, and that tab is outside this app's Tor connection, so the
 * link opens from a button here.
 */
function RedirectingPage({ args }: { args: { vm: BuySellVM } }) {
  const vm = args.vm;
  const q = vm.selectedQuote.peek();
  const [redirected, setRedirected] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const h = setTimeout(async () => {
      const r = await vm.launchTrade();
      if (r.url) setUrl(r.url);
      if (r.alert) await showAlert({ title: r.alert.title, content: r.alert.content, right: t('ok') });
      setRedirected(true);
    }, 2000);
    return () => clearTimeout(h);
  }, []);
  if (!q) return null;
  const failed = vm.quoteState.value.kind === 'failed';
  const s = vm.quoteState.value;
  const amount = vm.amountForQuote(q);
  return (
    <div class="page" id="buy_sell_redirecting_page">
      <div class="col" style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: '24px', padding: '0 18px', textAlign: 'center' }}>
        {failed ? (
          <>
            <MIcon name="warning_amber" size={48} />
            <div class="col" style={{ gap: '10px' }}>
              <span style={{ fontSize: '20px', fontWeight: 500 }}>{t('could_not_proceed_with_trade')}</span>
              <span id="buy_sell_redirect_error">{s.kind === 'failed' ? s.error || t('please_try_again_later') : ''}</span>
            </div>
          </>
        ) : (
          <>
            <RemoteImg src={logoOf(q)} size={64} fallback={q.provider.icon} />
            <div class="col" style={{ gap: '10px' }}>
              <span style={{ fontSize: '20px', fontWeight: 500 }}>{`${t('connecting_you_to')} ${q.provider.title}...`}</span>
              <span>{`${vm.fiatAmount.value} ${vm.fiatCurrency.value} → ${amount !== null ? `${cutDigits(amount, 8)} ${vm.cryptoCurrency.value.title}` : 'null'}`}</span>
            </div>
            {url && (
              <div class="col" style={{ gap: '12px', width: '100%' }}>
                <Button id="buy_sell_open_provider" onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}>{`Open ${q.provider.title}`}</Button>
                <span style={{ fontSize: '12px', color: 'var(--on-surface-variant)' }}>{`${q.provider.title} opens in your browser, outside this app's Tor connection. Use Tor Browser to keep it private.`}</span>
              </div>
            )}
          </>
        )}
      </div>
      {(redirected || failed) && (
        <div style={{ padding: '18px' }}>
          <Button secondary={!!url} id="buy_sell_redirect_close" onClick={() => nav.pop()}>{t('close')}</Button>
        </div>
      )}
    </div>
  );
}

registerRoute(Routes.buySellPage, AmountPage);
registerKeepAlive(Routes.buySellPage);
registerRoute(Routes.buySellProviders, ProviderPage);
registerRoute(Routes.buySellPaymentMethods, PaymentMethodPage);
registerRoute(Routes.buySellConfirmation, ConfirmationPage);
registerRoute(Routes.buySellRedirecting, RedirectingPage);

