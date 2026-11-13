// Accounts (lib/new-ui/pages/wallet_accounts_page.dart), the account creation
// sheet (AccountCreationModal) and the accounts education carousel
// (lib/new-ui/pages/account_education_page.dart).

import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../../core/i18n.ts';
import { Button, Field, Icon, Img, MIcon, ModernButton, Page, ToggleRow, TopBar } from '../../components/core.tsx';
import { confirmAlert, showAlert, showSheet } from '../../components/overlays.tsx';
import { registerRoute, Routes } from '../../routes.ts';
import { nav } from '../../nav.ts';
import { currentWallet } from '../../../app/app.ts';
import { settings, updateSettings } from '../../../app/settings.ts';
import { moveCard, resolveCardLayout, unhideCard, type CardLayout } from '../../../app/cardLayout.ts';
import { generateName } from '../../../core/names.ts';
import { formatFixed } from '../../../core/amount.ts';
import { isSynced, type WalletBase } from '../../../core/wallet.ts';
import { BalanceCard, designFromStyle, newAccountStyle, storedCardStyle } from './cards.tsx';

type AccountWallet = WalletBase & { setAccount?: (i: number) => Promise<void>; addAccount?: (label: string) => Promise<void> };

/** an account's balance on its card: sats for Bitcoin when amounts are shown in satoshi */
export function accountAmount(w: WalletBase, amount: bigint): { amount: string; asset: string } {
  const sats = w.type === 'bitcoin' && settings.value.displayAmountsInSatoshi;
  return sats ? { amount: amount.toString(), asset: 'sats' } : { amount: formatFixed(amount, w.currency.decimals, { fractionDigits: Math.min(w.currency.decimals, 8) }), asset: w.currency.title.toUpperCase() };
}

const SLIDES: { image: string; title: string; text: string }[] = [
  { image: 'accounts_overview.svg', title: 'accounts_education_organize_title', text: 'accounts_education_organize_description' },
  { image: 'recovery_shield.svg', title: 'accounts_education_recovery_title', text: 'accounts_education_recovery_description' },
  { image: 'account_order.svg', title: 'accounts_education_order_title', text: 'accounts_education_order_description' },
  { image: 'archive_warning.svg', title: 'accounts_education_archive_title', text: 'accounts_education_archive_description' },
];

export function openAccountsEducation(): Promise<void> {
  return showSheet<void>((close) => <Education close={() => close()} />).then(() => {});
}

function Education({ close }: { close: () => void }) {
  const [i, setI] = useState(0);
  const last = i === SLIDES.length - 1;
  const sl = SLIDES[i];
  return (
    <div class="col" style={{ background: 'var(--surface)', borderRadius: '30px 30px 0 0', padding: '18px', gap: '16px' }} id="accounts_education">
      <div class="rowx" style={{ gap: '8px' }}>
        <Img src="assets/new-ui/settings_row_icons/accounts.svg" size={24} />
        <span class="grow" style={{ fontSize: '24px', fontWeight: 500 }}>{t('accounts')}</span>
        <ModernButton icon="close" size={36} label={t('close')} onClick={close} />
      </div>
      <div class="col" style={{ alignItems: 'center', gap: '16px', minHeight: '360px', textAlign: 'center' }}>
        <Img src={`assets/new-ui/account_education/${sl.image}`} w={240} h={180} style={{ maxWidth: '100%', height: 'auto', maxHeight: '220px' }} />
        <div style={{ fontSize: '14px' }}>{t(sl.title)}</div>
        <div class="muted" style={{ fontSize: '14px' }}>{t(sl.text)}</div>
        {i === 2 && <div class="muted" style={{ fontSize: '14px' }}>{t('accounts_education_order_restore_description')}</div>}
      </div>
      <div class="rowx" style={{ justifyContent: 'center', gap: '8px' }}>
        {SLIDES.map((_, k) => <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: k === i ? 'var(--primary)' : 'var(--surface-container-highest)' }} />)}
      </div>
      <Button id="accounts_education_continue" onClick={() => (last ? close() : setI(i + 1))}>{last ? t('accounts_education_understand_continue') : t('continue_text')}</Button>
    </div>
  );
}

function AccountCreation({ close }: { close: (name?: string) => void }) {
  const [name, setName] = useState('');
  return (
    <div class="col" style={{ padding: '0 18px 24px', gap: '16px' }} id="account_creation">
      <TopBar title={t('create_account')} onClose={() => close()} />
      <Img src="assets/new-ui/account_education/create_account.svg" w={200} h={140} style={{ alignSelf: 'center', maxWidth: '100%', height: 'auto' }} />
      <div class="muted center">{t('account_creation_description')}</div>
      <Field value={name} onInput={setName} placeholder={t('account_name')} maxLength={32} id="account_creation_name" suffix={<button type="button" class="ficon" aria-label={t('generate_name')} onClick={() => setName(generateName())}><Img src="assets/new-ui/randomize.svg" size={20} /></button>} />
      <Button id="account_creation_continue" onClick={() => close(name.trim())}>{t('continue_text')}</Button>
    </div>
  );
}

/** the wallet's card layout: the visible accounts back to front, and the archived ones */
export function accountLayout(w: WalletBase): CardLayout {
  return resolveCardLayout(w.accounts.value.map((a) => a.index), settings.value.accountCards[w.id]);
}

export function saveAccountLayout(w: WalletBase, l: CardLayout): void {
  updateSettings((x) => ({ accountCards: { ...x.accountCards, [w.id]: { order: l.visible, hidden: l.hidden } } }));
}

const amountText = (w: WalletBase, amount: bigint) => {
  const x = accountAmount(w, amount);
  return `${x.amount} ${x.asset === 'sats' ? 'sats' : w.currency.title}`;
};

const accountLabel = (a: { index: number; label: string }) => `${a.index + 1}. ${a.label.trim() || t('unnamed_account')}`;

export function readyToManage(w: WalletBase): Promise<boolean> {
  if (isSynced(w.syncStatus.value)) return Promise.resolve(true);
  return showAlert({ title: t('wallet_is_syncing'), content: t('cannot_manage_accounts_during_sync'), right: t('ok') }).then(() => false);
}

function WalletAccountsPage() {
  const w = currentWallet.value as AccountWallet | null;
  const [busy, setBusy] = useState(false);
  // the drag in a ref (its events can come faster than renders), and in state for the picture
  const dragRef = useRef<{ from: number; startY: number; dy: number; active: boolean } | null>(null);
  const [drag, setDragState] = useState<{ from: number; startY: number; dy: number; active: boolean } | null>(null);
  const setDrag = (d: typeof drag) => {
    dragRef.current = d;
    setDragState(d);
  };
  const cardsRef = useRef<HTMLDivElement>(null);
  const [multi, setMulti] = useState(() => !!w?.isMultiAccountsEnabled);
  // _initialize: the active account in front; with accounts on, the education the first time
  const initialize = (x: WalletBase) => {
    const l = accountLayout(x);
    const cur = x.currentAccount.value;
    if (l.visible.includes(cur) && l.visible[l.visible.length - 1] !== cur) saveAccountLayout(x, { ...l, visible: [...l.visible.filter((a) => a !== cur), cur] });
    if (x.isMultiAccountsEnabled && !settings.peek().dismissedPromos?.education_accounts && x.accounts.value.length) {
      void openAccountsEducation().then(() => updateSettings((y) => ({ dismissedPromos: { ...y.dismissedPromos, education_accounts: true } })));
    }
  };
  useEffect(() => {
    if (w) initialize(w);
  }, [w?.id]);
  if (!w) return null;
  const s = settings.value;
  // the selected account is the front card (an account found or added since keeps its place behind it)
  const raw = accountLayout(w);
  const cur = w.currentAccount.value;
  const layout = raw.visible.includes(cur) ? { ...raw, visible: [...raw.visible.filter((a) => a !== cur), cur] } : raw;
  /** ListItemToggle "Multiple Accounts": off selects the primary account */
  const toggleMulti = async (v: boolean) => {
    setMulti(v);
    await w.setMultiAccountsEnabled(v);
    initialize(w);
  };
  const byIndex = new Map(w.accounts.value.map((a) => [a.index, a]));
  const visible = layout.visible.map((i) => byIndex.get(i)!).filter(Boolean);
  const hidden = s.balanceDisplayMode === 'hiddenBalance';
  /** a card tapped: to the front, and its account selected */
  const toFront = async (pos: number) => {
    if (pos === visible.length - 1) return;
    if (!(await readyToManage(w))) return;
    saveAccountLayout(w, { ...layout, visible: moveCard(layout.visible, pos, layout.visible.length) });
    await w.setAccount?.(layout.visible[pos]);
  };
  /** onReorder after a drag; the front card stays the selected account */
  const drop = async (from: number, to: number) => {
    if (from === to) return;
    const next = moveCard(layout.visible, from, to);
    saveAccountLayout(w, { ...layout, visible: next });
    const front = next[next.length - 1];
    if (front !== w.currentAccount.value && (await readyToManage(w))) await w.setAccount?.(front);
  };
  const add = async () => {
    if (!(await readyToManage(w))) return;
    const name = await showSheet<string>((close) => <AccountCreation close={close} />);
    if (name === undefined || !w.addAccount) return;
    setBusy(true);
    try {
      const next = w.accounts.value.reduce((m, a) => Math.max(m, a.index), -1) + 1;
      updateSettings((x) => ({ cardDesigns: { ...x.cardDesigns, [`${w.id}:${next}`]: newAccountStyle(x.cardDesigns, w.id, w.currency.key) } }));
      await w.addAccount(name);
      // _showAddAccountModal: the newest account is selected (and comes in front)
      const newest = w.accounts.value.reduce((m, a) => Math.max(m, a.index), 0);
      saveAccountLayout(w, { ...accountLayout(w), visible: [...accountLayout(w).visible.filter((a) => a !== newest), newest] });
      await w.setAccount?.(newest);
    } catch (e) {
      await showAlert({ title: t('error'), content: (e as Error).message, right: t('ok') });
    } finally {
      setBusy(false);
    }
  };
  // a back card shows its top fifth; dragging by that much moves a card by one place
  const slot = () => (cardsRef.current?.clientWidth ?? 360) * 0.62 * 0.2;
  const target = (d: NonNullable<typeof drag>) => Math.max(0, Math.min(visible.length - 1, d.from + Math.round(d.dy / slot())));
  return (
    <div class="page solid" id="wallet_accounts_page">
      <TopBar
        title={t('accounts')}
        onClose={() => nav.pop()}
        trailing={
          <span class="rowx" style={{ gap: '8px' }}>
            <ModernButton icon="question_mark" size={36} iconSize={19} label={t('accounts_help')} onClick={() => void openAccountsEducation()} />
            {multi && <ModernButton svg="archived.svg" size={36} iconSize={19} id="archived_accounts_button" label={t('archived_accounts')} bg={layout.hidden.length ? 'var(--primary)' : undefined} color={layout.hidden.length ? 'var(--on-primary)' : undefined} onClick={() => nav.push(Routes.archivedAccounts)} />}
          </span>
        }
      />
      {w.canToggleMultiAccounts && (
        <div style={{ padding: '0 24px' }}>
          <div class="list">
            <ToggleRow label={t('multiple_accounts')} value={multi} id="multiple_accounts_toggle" onChange={(v) => void toggleMulti(v)} />
          </div>
        </div>
      )}
      {multi && <div class="center muted" style={{ padding: '24px 18px' }}>{t('account_customizer_desc')}</div>}
      {multi && (
      <div class="page-body" style={{ padding: '0 5% 196px' }}>
        <div class="col" style={{ alignItems: 'center', touchAction: drag?.active ? 'none' : undefined }} ref={cardsRef}>
          {visible.map((a, i) => {
            const front = i === visible.length - 1;
            const design = designFromStyle(storedCardStyle(s.cardDesigns, `${w.id}:${a.index}`), w.currency.key);
            const shown = accountAmount(w, a.balance ?? 0n);
            const dragging = drag?.active && drag.from === i;
            return (
              <div
                style={{ width: '100%', maxWidth: '768px', position: 'relative', height: front ? 'auto' : 'calc(min(90vw, 768px) * 0.62 * 0.2)', zIndex: dragging ? 100 : i, cursor: front ? 'default' : 'pointer', transform: dragging ? `translateY(${drag!.dy}px) scale(1.05)` : undefined, transition: dragging ? 'none' : 'transform .15s' }}
                id={`account_card_${a.index}`}
                onPointerDown={(e) => {
                  if ((e.target as HTMLElement).closest('button')) return;
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                  setDrag({ from: i, startY: e.clientY, dy: 0, active: false });
                }}
                onPointerMove={(e) => {
                  const d = dragRef.current;
                  if (!d || d.from !== i) return;
                  const dy = e.clientY - d.startY;
                  setDrag({ ...d, dy, active: d.active || Math.abs(dy) > 8 });
                }}
                onPointerUp={() => {
                  const d = dragRef.current;
                  if (!d || d.from !== i) return;
                  setDrag(null);
                  if (d.active) void drop(d.from, target(d));
                  else void toFront(i);
                }}
                onPointerCancel={() => setDrag(null)}
              >
                <div style={{ position: front ? 'relative' : 'absolute', top: 0, left: 0, right: 0 }}>
                  <BalanceCard design={design} label={accountLabel(a)} amount={front ? shown.amount : ''} asset={front ? shown.asset : ''} hidden={hidden} width={768} onMenu={front ? () => void (async () => { if (await readyToManage(w)) nav.push(Routes.cardCustomizer, { account: a.index, canHide: visible.length > 1 }); })() : undefined} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      )}
      {multi && (
        <div style={{ position: 'absolute', left: '24px', right: '24px', bottom: '50px' }}>
          <button type="button" id="add_account" disabled={busy} onClick={() => void add()} class="rowx" style={{ width: '100%', justifyContent: 'center', gap: '8px', padding: '18px', borderRadius: '999px', border: 0, background: 'var(--surface-container)', color: 'var(--primary)', fontWeight: 500, fontSize: '16px', cursor: 'pointer' }}>
            <MIcon name="add" size={28} color="var(--primary)" />
            {t('add_account')}
          </button>
        </div>
      )}
    </div>
  );
}

/** AccountSummary / AccountFundsSummary */
function AccountSummary({ a, w, funded }: { a: { index: number; label: string; balance?: bigint }; w: WalletBase; funded: boolean }) {
  return (
    <div class="rowx" style={{ gap: '12px', padding: '12px 14px', borderRadius: '18px', background: funded ? 'none' : 'var(--surface-container)', border: funded ? '1px solid var(--warning-outline)' : 0, textAlign: 'start' }}>
      <Icon src="account.svg" size={24} color="var(--on-surface-variant)" />
      <span class="grow" style={{ fontWeight: 500 }}>{accountLabel(a)}</span>
      {funded && <span>{amountText(w, a.balance ?? 0n)}</span>}
    </div>
  );
}

/** ArchiveConfirmationContent: funded accounts warn about their funds */
export function confirmArchive(w: WalletBase, a: { index: number; label: string; balance?: bigint }): Promise<boolean> {
  const funded = (a.balance ?? 0n) > 0n;
  return confirmAlert(
    funded ? t('archive_account_confirmation_title') : t('archive_account_title'),
    <div class="col" style={{ gap: '16px', textAlign: 'center' }} id="archive_confirmation">
      {funded ? (
        <>
          <div style={{ color: 'var(--warning-outline)' }}>{t('archive_account_funds_title')}</div>
          <AccountSummary a={a} w={w} funded />
          <div style={{ color: 'var(--warning-outline)' }}>{t('archive_account_move_funds')}</div>
          <div class="muted">{t('archive_account_funded_disclaimer')}</div>
        </>
      ) : (
        <>
          <AccountSummary a={a} w={w} funded={false} />
          <div>{t('archive_account_empty_disclaimer')}</div>
          <div class="muted">{t('archive_account_restore_hint')}</div>
        </>
      )}
    </div>,
    t('continue_text'),
    t('cancel'),
  );
}

/** HiddenAccountsPage: the archived accounts, funded ones first; a tap brings one back (and selects it) */
function ArchivedAccountsPage() {
  const w = currentWallet.value as AccountWallet | null;
  if (!w) return null;
  const layout = accountLayout(w);
  const byIndex = new Map(w.accounts.value.map((a) => [a.index, a]));
  const archived = layout.hidden.map((i) => byIndex.get(i)!).filter(Boolean);
  const funded = archived.filter((a) => (a.balance ?? 0n) > 0n);
  const empty = archived.filter((a) => !((a.balance ?? 0n) > 0n));
  const unarchive = async (a: { index: number; label: string; balance?: bigint }) => {
    const ok = await confirmAlert(t('unarchive_account_title'), (a.balance ?? 0n) > 0n ? t('unarchive_account_funds_description') : t('unarchive_account_description'), t('continue_text'), t('cancel'));
    if (!ok) return;
    saveAccountLayout(w, unhideCard(accountLayout(w), a.index));
    await w.setAccount?.(a.index);
  };
  const row = (a: { index: number; label: string; balance?: bigint }) => (
    <button type="button" class="row tap has-icon" id={`archived_account_${a.index}`} onClick={() => void unarchive(a)}>
      <Icon src="account.svg" size={24} color="var(--on-surface-variant)" />
      <span class="lbl"><span>{accountLabel(a)}</span></span>
      {(a.balance ?? 0n) > 0n && <span class="trail">{amountText(w, a.balance!)}</span>}
    </button>
  );
  return (
    <Page title={t('archived_accounts')} solid id="archived_accounts_page">
      {!archived.length ? (
        <div class="col" style={{ alignItems: 'center', gap: '12px', paddingTop: '35%', textAlign: 'center' }} id="archived_accounts_empty">
          <Icon src="archived.svg" size={50} color="var(--on-surface-variant)" />
          <div style={{ fontSize: '18px', fontWeight: 600 }}>{t('no_archived_accounts')}</div>
          <div class="muted">{t('no_archived_accounts_description')}</div>
        </div>
      ) : (
        <div class="col" style={{ gap: '20px' }}>
          <div class="center muted">{t('select_account_to_unarchive')}</div>
          {funded.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, margin: '0 4px 4px' }}>{t('funded_accounts')}</div>
              <div class="muted" style={{ fontSize: '12px', margin: '0 4px 12px' }}>{t('funded_accounts_description')}</div>
              <div class="list">{funded.map(row)}</div>
            </div>
          )}
          {empty.length > 0 && (
            <div>
              <div style={{ fontWeight: 600, margin: '0 4px 12px' }}>{t('empty_accounts')}</div>
              <div class="list">{empty.map(row)}</div>
            </div>
          )}
        </div>
      )}
    </Page>
  );
}

registerRoute(Routes.walletAccountsPage, WalletAccountsPage);
registerRoute(Routes.archivedAccounts, ArchivedAccountsPage);
