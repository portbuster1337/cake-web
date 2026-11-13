// dEuro Savings (lib/src/screens/integrations/deuro/**): the APR, the savings
// balance (and a V1 position to close), the accrued interest; approve,
// deposit, withdraw, collect and reinvest — each a contract call from the
// Ethereum wallet, confirmed with a swipe.

import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { t } from '../../../core/i18n.ts';
import { Button, Icon, Img, MIcon, ModernButton, Page, Spinner, TopBar } from '../../components/core.tsx';
import { showAlert, showSheet } from '../../components/overlays.tsx';
import { registerRoute, Routes } from '../../routes.ts';
import { nav } from '../../nav.ts';
import { currentWallet } from '../../../app/app.ts';
import { settings, updateSettings } from '../../../app/settings.ts';
import { fiatValue, formatFiatAmount } from '../../../app/prices.ts';
import { formatFixed, tryParseFixed } from '../../../core/amount.ts';
import type { PendingTransaction, WalletBase } from '../../../core/wallet.ts';
import { ConfirmSwiper } from '../send.tsx';
import { openExternal } from '../dashboard/history.tsx';
import { DEURO_TOKEN, MIN_ACCRUED_INTEREST, depositSavings, enableSavings, interestRate, reinvestInterest, savingsData, withdrawSavings, withdrawSavingsV1, type DEuroWallet, type SavingsData } from '../../../integrations/deuro.ts';

const GRADIENT = 'linear-gradient(to bottom, var(--card-gradient-primary), var(--card-gradient-secondary))';
const DEURO_API = `evm.${DEURO_TOKEN.toLowerCase()}`;
/** toStringWithPrecision(fractionalDigits: 6) */
const six = (v: bigint) => formatFixed(v, 18, { fractionDigits: 6 });

function fiatOf(v: bigint): string | null {
  if (settings.value.fiatApiMode === 'disabled') return null;
  const f = fiatValue(Number(formatFixed(v, 18)), DEURO_API);
  return f === null ? '0.00' : formatFiatAmount(f);
}

/** InfoBottomSheet / TooltipSheet */
function infoSheet(o: { title: string; image?: string; content: string; learnMore?: string; disclaimer?: boolean }): Promise<void> {
  return showSheet<void>((close) => (
    <div class="col" style={{ background: 'var(--surface)', borderRadius: '16px 16px 0 0', padding: '0 24px 24px', gap: '16px', alignItems: 'center' }} id="deuro_info_sheet">
      <TopBar title={o.title} />
      {o.image && <Img src={o.image} size={180} />}
      <div class="center" style={{ fontSize: '14px', whiteSpace: 'pre-line' }}>{o.content}</div>
      {o.disclaimer && (
        <div class="center" style={{ fontSize: '12px', color: 'var(--on-surface-variant)' }}>
          {'By continuing you agree to this '}
          <a href="#" onClick={(e) => { e.preventDefault(); close(); nav.push(Routes.readThirdPartyDisclaimer, { file: 'disclaimer_deuro.txt' }); }} style={{ color: 'var(--primary)', fontWeight: 700 }}>disclaimer</a>
        </div>
      )}
      <div class="rowx" style={{ gap: '12px', width: '100%' }}>
        {o.learnMore && <div class="grow"><Button secondary onClick={() => void openExternal(o.learnMore!)}>{t('learn_more')}</Button></div>}
        <div class="grow"><Button onClick={() => close()}>{t('close')}</Button></div>
      </div>
    </div>
  ));
}

function BalanceRow({ title, amount, fiat, onTooltip }: { title: string; amount: string; fiat: string | null; onTooltip?: () => void }) {
  return (
    <div class="col" style={{ gap: '6px' }}>
      <div class="rowx" style={{ gap: '6px', color: 'var(--on-surface-variant)', fontSize: '14px' }}>
        <span>{title}</span>
        {onTooltip && <button type="button" aria-label="Info" onClick={onTooltip} style={{ border: 0, background: 'none', padding: 0, cursor: 'pointer', display: 'flex' }}><MIcon name="info" size={16} color="var(--on-surface-variant)" /></button>}
      </div>
      <div class="rowx" style={{ justifyContent: 'space-between', gap: '12px' }}>
        <span class="col" style={{ minWidth: 0 }}>
          <span style={{ fontSize: '24px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{amount}</span>
          {fiat !== null && <span style={{ fontSize: '16px', color: 'var(--on-surface-variant)' }}>{`${settings.value.fiatCurrency} ${fiat}`}</span>}
        </span>
        <span class="rowx" style={{ gap: '6px', flex: 'none' }}>
          <Img src="assets/images/deuro_icon.png" size={24} round />
          <span style={{ fontSize: '16px', fontWeight: 600 }}>DEURO</span>
        </span>
      </div>
    </div>
  );
}

function ActionButton({ label, icon, primary, onClick, disabled, id }: { label: string; icon?: string; primary?: boolean; onClick: () => void; disabled?: boolean; id: string }) {
  return (
    <button type="button" id={id} disabled={disabled} onClick={onClick} class="rowx" style={{ flex: 1, height: '48px', justifyContent: 'center', gap: '8px', borderRadius: '12px', border: primary ? 0 : '1px solid var(--outline-variant)', background: primary ? 'var(--primary)' : 'var(--surface)', color: primary ? 'var(--on-primary)' : 'var(--on-surface)', fontWeight: 600, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1 }}>
      {icon && <Icon src={icon} size={16} color={primary ? 'var(--on-primary)' : 'var(--on-surface)'} />}
      {label}
    </button>
  );
}

/** SavingsEditSheet: an amount, "Available to …" with ALL, Confirm */
function editSheet(title: string, availableTitle: string, available: bigint): Promise<string | undefined> {
  return showSheet<string>((close) => <EditSheet title={title} availableTitle={availableTitle} available={available} close={close} />);
}

function EditSheet({ title, availableTitle, available, close }: { title: string; availableTitle: string; available: bigint; close: (v?: string) => void }) {
  const [v, setV] = useState('');
  const amount = tryParseFixed(v.replace(',', '.') || '0', 18);
  return (
    <div class="col" style={{ background: 'var(--surface)', borderRadius: '16px 16px 0 0', padding: '0 24px 24px', gap: '20px' }} id="deuro_edit_sheet">
      <TopBar title={title} onClose={() => close()} />
      <input id="deuro_amount" inputMode="decimal" placeholder="0" value={v} onInput={(e) => setV((e.target as HTMLInputElement).value.replace(/[^0-9.,]/g, ''))} style={{ border: 0, outline: 'none', background: 'none', color: 'var(--on-surface)', fontSize: '32px', textAlign: 'center' }} />
      <div class="rowx" style={{ justifyContent: 'space-between', background: 'var(--surface-container)', borderRadius: '12px', padding: '12px 16px' }}>
        <span class="col">
          <span style={{ fontSize: '12px', color: 'var(--on-surface-variant)' }}>{availableTitle}</span>
          <span style={{ fontWeight: 600 }}>{`${six(available)} DEURO`}</span>
        </span>
        <button type="button" id="deuro_all" onClick={() => setV(formatFixed(available, 18))} style={{ border: 0, borderRadius: '8px', padding: '6px 12px', background: 'var(--surface-container-high)', color: 'var(--primary)', fontWeight: 600, cursor: 'pointer' }}>{t('all')}</button>
      </div>
      <Button id="deuro_edit_confirm" disabled={!amount || amount <= 0n} onClick={() => close(v.replace(',', '.'))}>{t('confirm')}</Button>
    </div>
  );
}

/** ConfirmSendingBottomSheet for a contract call: the amount, the estimated fee, an explanation, swipe to send */
function confirmSheet(w: WalletBase, title: string, tx: PendingTransaction, showAmount: boolean, explanation?: string): Promise<boolean> {
  return showSheet<boolean>((close) => <ConfirmSheet w={w} title={title} tx={tx} showAmount={showAmount} explanation={explanation} close={close} />, { dismissible: false }).then((v) => !!v);
}

function ConfirmSheet({ w, title, tx, showAmount, explanation, close }: { w: WalletBase; title: string; tx: PendingTransaction; showAmount: boolean; explanation?: string; close: (sent?: boolean) => void }) {
  const [state, setState] = useState<'ready' | 'sending' | 'error'>('ready');
  const [error, setError] = useState('');
  const fiatCode = settings.value.fiatCurrency;
  const feeFiat = fiatValue(Number(formatFixed(tx.fee, 18)), 'crypto.ETH');
  const amountFiat = fiatOf(tx.amount);
  return (
    <div class="col" style={{ background: 'var(--surface)', borderRadius: '16px 16px 0 0', padding: '0 24px 24px', gap: '16px' }} id="deuro_confirm_sheet">
      <TopBar title={title} trailing={state !== 'sending' ? <ModernButton icon="close" size={36} color="var(--on-surface-variant)" label={t('close')} onClick={() => close()} /> : undefined} />
      {showAmount && (
        <div class="col" style={{ alignItems: 'center' }}>
          <span style={{ fontSize: '28px' }} id="deuro_confirm_amount">{`${six(tx.amount)} DEURO`}</span>
          {amountFiat !== null && <span class="muted">{`${amountFiat} ${fiatCode}`}</span>}
        </div>
      )}
      <div class="rowx" style={{ justifyContent: 'space-between', background: 'var(--surface-container)', borderRadius: '16px', padding: '12px' }}>
        <span>{t('send_estimated_fee').replace(/:\s*$/, '')}</span>
        <span class="col" style={{ alignItems: 'flex-end' }}>
          <span id="deuro_confirm_fee">{`${tx.feeFormatted} ${w.currency.title}`}</span>
          {feeFiat !== null && settings.value.fiatApiMode !== 'disabled' && <span class="muted" style={{ fontSize: '12px' }}>{`${formatFiatAmount(feeFiat)} ${fiatCode}`}</span>}
        </span>
      </div>
      {explanation && <div style={{ fontSize: '14px', color: 'var(--on-surface-variant)' }}>{explanation}</div>}
      {state === 'error' && <div role="alert" style={{ color: 'var(--error)', overflowWrap: 'anywhere' }}>{error}</div>}
      {state === 'sending' ? (
        <div class="rowx" style={{ justifyContent: 'center', gap: '12px', color: 'var(--on-surface-variant)' }}><Spinner /> {`${t('sending')}...`}</div>
      ) : state === 'ready' ? (
        <ConfirmSwiper label={t('swipe_to_send')} onConfirm={async () => {
          setState('sending');
          try {
            await tx.commit();
            close(true);
          } catch (e) {
            setError((e as Error).message);
            setState('error');
          }
        }} />
      ) : (
        <Button onClick={() => close()}>{t('close')}</Button>
      )}
    </div>
  );
}

function SavingsPage() {
  const w = currentWallet.value;
  const [data, setData] = useState<SavingsData | null>(null);
  const [rate, setRate] = useState('0');
  const [busy, setBusy] = useState(false);
  const dw = w as unknown as DEuroWallet;

  const reload = async () => {
    if (!w) return;
    try {
      setData(await savingsData(dw));
    } catch (e) {
      await showAlert({ title: t('error'), content: (e as Error).message, right: t('ok') });
    }
  };

  useEffect(() => {
    if (!w) return;
    void interestRate(dw).then(setRate).catch(() => {});
    void reload();
    // the welcome sheet on the first visit (should_show_deuro_disclaimer)
    if (!settings.peek().dismissedPromos?.deuroDisclaimer) {
      void infoSheet({ title: 'dEURO', image: 'assets/images/deuro_hero.png', content: t('deuro_savings_welcome_description'), learnMore: 'https://deuro.com/what-is-deuro.html', disclaimer: true }).then(() => updateSettings((s) => ({ dismissedPromos: { ...s.dismissedPromos, deuroDisclaimer: true } })));
    }
  }, [w?.id]);

  if (!w || w.type !== 'ethereum') return null;
  const priority = settings.value.priority[w.type] ?? w.defaultPriority();
  const tokenBalance = w.balances.value[DEURO_TOKEN.toLowerCase()]?.available ?? 0n;
  const enabled = !!data && data.approved > 0n;
  const actionsEnabled = enabled && !!data && data.accrued >= MIN_ACCRUED_INTEREST;

  /** prepare → confirm → commit → "Transaction sent!" → reload */
  const run = async (title: string, prepare: () => Promise<PendingTransaction>, showAmount = true, explanation?: string) => {
    if (busy) return;
    setBusy(true);
    let tx: PendingTransaction;
    try {
      tx = await prepare();
    } catch (e) {
      setBusy(false);
      await showAlert({ title: t('error'), content: (e as Error).message, right: t('ok') });
      return;
    }
    setBusy(false);
    if (!(await confirmSheet(w, title, tx, showAmount, explanation))) return;
    await infoSheet({ title: t('transaction_sent'), image: 'assets/images/birthday_cake.png', content: t('deuro_tx_commited_content') });
    void reload();
  };

  const onApprove = async () => {
    const eth = w.balances.value[w.currency.key]?.available ?? 0n;
    if (eth === 0n) {
      await infoSheet({ title: 'dEURO', image: 'assets/images/deuro_not_enough_eth.png', content: t('deuro_tooltip_no_eth') });
      return;
    }
    await run(t('approve_tokens'), () => enableSavings(dw, priority), false, t('deuro_savings_approve_app_description'));
  };
  const onDeposit = async () => {
    const v = await editSheet(t('deuro_savings_add'), t('deuro_savings_available_to_add'), tokenBalance);
    const amount = v ? tryParseFixed(v, 18) : null;
    if (!amount) return;
    await run(t('deuro_savings_add'), () => depositSavings(dw, amount, priority));
  };
  const onWithdraw = async () => {
    const v = await editSheet(t('deuro_savings_remove'), t('deuro_savings_available_to_remove'), data?.savings ?? 0n);
    const amount = v ? tryParseFixed(v, 18) : null;
    if (!amount) return;
    await run(t('deuro_savings_remove'), () => withdrawSavings(dw, amount, priority));
  };
  /** prepareCollectInterest: withdraw the interest at 6 decimals */
  const onCollect = async () => {
    if (!data || data.accrued < MIN_ACCRUED_INTEREST) {
      await showAlert({ title: t('error'), content: 'Accrued interest is below minimum threshold', right: t('ok') });
      return;
    }
    const amount = tryParseFixed(six(data.accrued), 18);
    if (!amount) {
      await showAlert({ title: t('error'), content: 'Invalid accrued interest amount', right: t('ok') });
      return;
    }
    await run(t('deuro_savings_remove'), () => withdrawSavings(dw, amount, priority));
  };
  const onReinvest = () => run(t('deuro_reinvest_interest'), () => reinvestInterest(dw, priority), false);
  const onWithdrawV1 = () => run(t('deuro_savings_remove'), () => withdrawSavingsV1(dw, data?.savingsV1 ?? 0n, priority));

  const tooltip = (title: string, content: string) => void infoSheet({ title, content, learnMore: 'https://deuro.com/#faq' });
  const chip = (label: ComponentChildren, onClick: () => void, id: string) => (
    <button type="button" id={id} onClick={onClick} class="rowx" style={{ gap: '6px', height: '36px', padding: '0 14px', borderRadius: '999px', border: '1px solid var(--outline-variant)', background: 'var(--surface-container)', color: 'var(--on-surface)', cursor: 'pointer' }}>{label}</button>
  );
  return (
    <Page title={t('deuro_savings')} legacy id="deuro_savings_page" bodyClass="">
      <div class="col" style={{ minHeight: '100%' }}>
        <div style={{ margin: '15px', borderRadius: '15px', background: 'var(--surface-container-lowest)' }}>
          <div class="rowx" style={{ padding: '10px 20px', justifyContent: 'space-between', color: 'var(--on-surface-variant)', fontWeight: 500 }}>
            <span>Current APR</span>
            <span style={{ fontWeight: 800 }} id="deuro_apr">{`${rate}%`}</span>
          </div>
          <div class="col" style={{ borderRadius: '15px', background: GRADIENT, padding: '20px', gap: '20px' }}>
            <BalanceRow title={t('deuro_savings_balance')} amount={six(data?.savings ?? 0n)} fiat={fiatOf(data?.savings ?? 0n)} onTooltip={() => tooltip(t('deuro_savings_balance'), t('deuro_savings_balance_tooltip'))} />
            {!!data?.savingsV1 && <BalanceRow title={`${t('deuro_savings_balance')} V1`} amount={six(data.savingsV1)} fiat={fiatOf(data.savingsV1)} />}
            {!data ? (
              <div class="center"><Spinner /></div>
            ) : (
              <div class="rowx" style={{ gap: '12px' }}>
                {data.savingsV1 ? (
                  <ActionButton id="deuro_withdraw_v1" label={`${t('deuro_savings_remove')} V1`} primary onClick={() => void onWithdrawV1()} disabled={busy} />
                ) : enabled ? (
                  <>
                    <ActionButton id="deuro_deposit" label={t('deuro_savings_add')} icon="assets/images/received.png" primary onClick={() => void onDeposit()} disabled={busy} />
                    <ActionButton id="deuro_withdraw" label={t('deuro_savings_remove')} icon="assets/images/upload.png" onClick={() => void onWithdraw()} disabled={busy} />
                  </>
                ) : (
                  <ActionButton id="deuro_approve" label={t('deuro_savings_approve_app')} primary onClick={() => void onApprove()} disabled={busy} />
                )}
              </div>
            )}
          </div>
        </div>
        <div class="col" style={{ margin: '0 16px', borderRadius: '15px', background: GRADIENT, padding: '20px', gap: '10px' }}>
          <BalanceRow title={t('deuro_savings_collect_interest')} amount={six(data?.accrued ?? 0n)} fiat={fiatOf(data?.accrued ?? 0n)} onTooltip={() => tooltip(t('deuro_savings_collect_interest'), t('deuro_savings_collect_interest_tooltip'))} />
          <div class="rowx" style={{ gap: '12px' }}>
            <ActionButton id="deuro_collect" label={t('deuro_collect_interest')} icon="assets/images/collect_interest.png" primary onClick={() => void onCollect()} disabled={!actionsEnabled || busy} />
            <ActionButton id="deuro_reinvest" label={t('deuro_reinvest_interest')} onClick={() => void onReinvest()} disabled={!actionsEnabled || busy} />
          </div>
        </div>
        <div class="grow" />
        <div class="rowx" style={{ justifyContent: 'center', gap: '10px', padding: '24px 16px 32px' }}>
          {chip(<><MIcon name="info" size={16} /> {t('deuro_about_deuro')}</>, () => void infoSheet({ title: 'dEURO', image: 'assets/images/deuro_hero.png', content: t('deuro_savings_welcome_description'), learnMore: 'https://deuro.com/what-is-deuro.html' }), 'deuro_about')}
          {chip(<><MIcon name="language" size={16} /> {t('website')}</>, () => void openExternal('https://deuro.com/'), 'deuro_website')}
        </div>
      </div>
    </Page>
  );
}

/** ThirdPartyDisclaimerPage: a disclaimer text of the assets (default title "Disclaimer") */
function ThirdPartyDisclaimerPage({ args }: { args?: { file?: string; title?: string } }) {
  const [text, setText] = useState('');
  useEffect(() => {
    const file = (args?.file ?? 'disclaimer_deuro.txt').replace(/[^A-Za-z0-9_.-]/g, '');
    void fetch(`./cake/text/${file}`, { credentials: 'same-origin' }).then((r) => r.text()).then(setText).catch(() => {});
  }, []);
  return (
    <Page title={args?.title ?? 'Disclaimer'} legacy id="third_party_disclaimer_page">
      <div style={{ fontSize: '12px', whiteSpace: 'pre-wrap', lineHeight: 1.45, padding: '10px 0 24px' }} id="third_party_disclaimer_text">{text}</div>
    </Page>
  );
}

registerRoute(Routes.dEuroSavings, SavingsPage);
registerRoute(Routes.readThirdPartyDisclaimer, ThirdPartyDisclaimerPage);
