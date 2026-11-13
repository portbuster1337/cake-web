// Accounts (lib/new-ui/pages/wallet_accounts_page.dart), the account creation
// sheet (AccountCreationModal) and the accounts education carousel
// (lib/new-ui/pages/account_education_page.dart).

import { useState } from 'preact/hooks';
import { t } from '../../../core/i18n.ts';
import { Button, Field, Img, MIcon, ModernButton, TopBar } from '../../components/core.tsx';
import { showAlert, showSheet } from '../../components/overlays.tsx';
import { registerRoute, Routes } from '../../routes.ts';
import { nav } from '../../nav.ts';
import { currentWallet } from '../../../app/app.ts';
import { settings } from '../../../app/settings.ts';
import { generateName } from '../../../core/names.ts';
import { formatFixed } from '../../../core/amount.ts';
import { isSynced, type WalletBase } from '../../../core/wallet.ts';
import { BalanceCard, designFromStyle } from './cards.tsx';

type AccountWallet = WalletBase & { setAccount?: (i: number) => Promise<void>; addAccount?: (label: string) => Promise<void> };

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

function WalletAccountsPage() {
  const w = currentWallet.value as AccountWallet | null;
  const [busy, setBusy] = useState(false);
  if (!w) return null;
  const s = settings.value;
  const accounts = w.accounts.value;
  const cur = w.currentAccount.value;
  // the selected account is the front card, at the bottom of the deck
  const ordered = [...accounts.filter((a) => a.index !== cur), ...accounts.filter((a) => a.index === cur)];
  const hidden = s.balanceDisplayMode === 'hiddenBalance';
  const select = async (index: number) => {
    if (index === cur) return;
    if (!isSynced(w.syncStatus.value)) {
      await showAlert({ title: t('wallet_is_syncing'), content: t('cannot_manage_accounts_during_sync'), right: t('ok') });
      return;
    }
    await w.setAccount?.(index);
  };
  const add = async () => {
    const name = await showSheet<string>((close) => <AccountCreation close={close} />);
    if (name === undefined || !w.addAccount) return;
    setBusy(true);
    try {
      await w.addAccount(name);
    } catch (e) {
      await showAlert({ title: t('error'), content: (e as Error).message, right: t('ok') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="page solid" id="wallet_accounts_page">
      <TopBar title={t('accounts')} onClose={() => nav.pop()} trailing={<ModernButton icon="info" size={36} iconSize={19} label={t('accounts_help')} onClick={() => void openAccountsEducation()} />} />
      <div class="page-body" style={{ padding: '12px 5% 196px' }}>
        <div class="col" style={{ alignItems: 'center' }}>
          {ordered.map((a, i) => {
            const front = i === ordered.length - 1;
            const design = designFromStyle(s.cardDesigns[`${w.id}:${a.index}`], w.currency.key);
            const label = `${a.index + 1}. ${a.label || t('unnamed_account')}`;
            return (
              <div style={{ width: '100%', maxWidth: '768px', position: 'relative', height: front ? 'auto' : 'calc(min(90vw, 768px) * 0.62 * 0.2)', zIndex: i, cursor: front ? 'default' : 'pointer' }} id={`account_card_${a.index}`} onClick={() => !front && void select(a.index)}>
                <div style={{ position: front ? 'relative' : 'absolute', top: 0, left: 0, right: 0 }}>
                  <BalanceCard design={design} label={label} amount={front ? formatFixed(a.balance ?? 0n, w.currency.decimals, { fractionDigits: Math.min(w.currency.decimals, 8) }) : ''} asset={front ? w.currency.title.toUpperCase() : ''} hidden={hidden} width={768} onMenu={front ? () => nav.push(Routes.cardCustomizer, { account: a.index }) : undefined} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ position: 'absolute', left: '24px', right: '24px', bottom: '50px' }}>
        <button type="button" id="add_account" disabled={busy} onClick={() => void add()} class="rowx" style={{ width: '100%', justifyContent: 'center', gap: '8px', padding: '18px', borderRadius: '999px', border: 0, background: 'var(--surface-container)', color: 'var(--primary)', fontWeight: 500, fontSize: '16px', cursor: 'pointer' }}>
          <MIcon name="add" size={28} color="var(--primary)" />
          {t('add_account')}
        </button>
      </div>
    </div>
  );
}

registerRoute(Routes.walletAccountsPage, WalletAccountsPage);
