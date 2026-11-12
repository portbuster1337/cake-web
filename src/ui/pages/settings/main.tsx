// Settings (lib/new-ui/pages/settings_page.dart: SettingsMainPage + WalletSettingsPage).

import type { ComponentChildren } from 'preact';
import { t } from '../../../core/i18n.ts';
import { Icon, Img, Page, Row, Section, Sections } from '../../components/core.tsx';
import { requireAuth } from '../../components/auth.tsx';
import { registerRoute, Routes } from '../../routes.ts';
import { nav } from '../../nav.ts';
import { currentWallet } from '../../../app/app.ts';
import { WALLET_TYPE_NAME } from '../../../coins/types.ts';
import { isEvm } from '../../../coins/types.ts';
import { settings } from '../../../app/settings.ts';

export function SettingsHeader({ icon, title, color }: { icon: string; title: string; color: string }) {
  return (
    <div class="rowx gap8" style={{ padding: '0 12px 16px' }}>
      <Icon src={icon} size={20} color={color} />
      <span style={{ fontSize: '16px', fontWeight: 500, color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
    </div>
  );
}

export function ModalHeader({ icon, title, message }: { icon: string; title: string; message?: string }) {
  return (
    <div class="col" style={{ alignItems: 'center', gap: '10px', background: 'var(--surface-container)', borderRadius: '16px', padding: '12px', marginBottom: '20px', textAlign: 'center' }}>
      <Img src={icon} size={36} />
      <div style={{ fontSize: '16px', fontWeight: 500 }}>{title}</div>
      {message && <div class="muted" style={{ fontSize: '12px', padding: '0 32px' }}>{message}</div>}
    </div>
  );
}

const ROW_ICONS = 'assets/new-ui/settings_row_icons/';

function SettingsMainPage() {
  const w = currentWallet.value;
  const typeName = w ? WALLET_TYPE_NAME[w.type] : '';
  const netIcon = w ? (w.type === 'robinhood' ? 'assets/new-ui/crypto_full_icons/robinhood.svg' : `assets/new-ui/network_icons/${w.type.toLowerCase()}.svg`) : undefined;
  return (
    <Page title={t('settings_title')} onClose={() => nav.pop()} solid id="settings_page">
      {w && (
        <>
          <SettingsHeader icon="wallet-setting.svg" title={w.name} color="var(--primary)" />
          <Sections>
            <Section>
              <Row label={`${typeName} ${t('settings_title')}`} image={netIcon} id="settings_wallet_type" onClick={() => nav.push('/wallet_settings')} />
            </Section>
            <Section>
              <Row label={t('privacy')} image={`${ROW_ICONS}privacy.svg`} id="settings_privacy" onClick={() => nav.push(Routes.privacyPage)} />
              <Row label={t('recovery_and_keys')} image={`${ROW_ICONS}seed.svg`} id="settings_recovery_keys" onClick={() => nav.push(Routes.showKeysDisclaimer)} />
              <Row label={t('other')} image={`${ROW_ICONS}other.svg`} id="settings_other" onClick={() => nav.push(Routes.otherSettingsPage)} />
            </Section>
          </Sections>
          <div style={{ height: '24px' }} />
          <div style={{ height: '1px', background: 'var(--surface-container-highest)' }} />
          <div style={{ height: '24px' }} />
        </>
      )}
      <SettingsHeader icon="cake-setting.svg" title={t('app_settings')} color="var(--on-surface-variant)" />
      <Sections>
        <Section>
          <Row label={t('connections')} image={`${ROW_ICONS}connections.svg`} id="settings_connections" onClick={() => nav.push(Routes.connectionSync)} />
          <Row label={t('display')} image={`${ROW_ICONS}display.svg`} id="settings_display" onClick={() => nav.push(Routes.displaySettingsPage)} />
          <Row label={t('security')} image={`${ROW_ICONS}security.svg`} id="settings_security" onClick={() => nav.push(Routes.securityBackupPage)} />
          <Row label={t('backup')} image={`${ROW_ICONS}backup.svg`} id="settings_backup" onClick={async () => { if (await requireAuth({ always: true })) nav.push(Routes.backup); }} />
        </Section>
        <Section>
          <Row label={t('settings_support')} image={`${ROW_ICONS}support.svg`} id="settings_support" onClick={() => nav.push(Routes.support)} />
          <Row label={t('about')} image={`${ROW_ICONS}info.svg`} id="settings_about" onClick={() => nav.push(Routes.aboutPage)} />
        </Section>
      </Sections>
      <div style={{ height: '32px' }} />
    </Page>
  );
}

function WalletSettingsPage() {
  const w = currentWallet.value;
  if (!w) return null;
  const core: ComponentChildren[] = [];
  const features: ComponentChildren[] = [];
  if (w.hasAccountsSupport) core.push(<Row label={w.type === 'bitcoin' ? t('accounts_onchain') : t('accounts')} image={`${ROW_ICONS}accounts.svg`} onClick={() => nav.push(Routes.walletAccountsPage)} />);
  core.push(<Row label={t('nodes')} image={`${ROW_ICONS}nodes.svg`} id="wallet_settings_nodes" onClick={() => nav.push(Routes.manageNodes)} />);
  if (w.hasCoinControl) core.push(<Row label={t('coin_control_settings')} image={`${ROW_ICONS}coin-control.svg`} id="wallet_settings_coin_control" onClick={() => nav.push(Routes.unspentCoinsList, { canEdit: false })} />);
  if (w.type === 'bitcoin' && !w.isWatchOnly) features.push(<Row label={t('silent_payments')} image={`${ROW_ICONS}silent-payments.svg`} onClick={() => nav.push(Routes.silentPaymentsSettings)} />);
  if ((isEvm(w.type) || w.type === 'solana' || w.type === 'tron') && !w.info.hardwareWalletType) features.push(<Row label={t('walletConnect')} image={`${ROW_ICONS}wc.svg`} onClick={() => nav.push(Routes.walletConnectConnectionsListing)} />);
  const typeName = WALLET_TYPE_NAME[w.type];
  return (
    <Page title={`${typeName} ${t('settings_title')}`} solid id="wallet_settings_page">
      <Sections>
        <Section>{core}</Section>
        {features.length > 0 && <Section>{features}</Section>}
      </Sections>
    </Page>
  );
}

registerRoute(Routes.settings, SettingsMainPage);
registerRoute('/wallet_settings', WalletSettingsPage);
export { settings };
