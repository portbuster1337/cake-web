// Silent Payments settings (lib/src/screens/settings/silent_payments_settings.dart)
// and its logs page (silent_payments_logs_page.dart).

import { t } from '../../../core/i18n.ts';
import { Page, Row, Section, ToggleRow } from '../../components/core.tsx';
import { registerRoute, Routes } from '../../routes.ts';
import { nav } from '../../nav.ts';
import { settings, updateSettings } from '../../../app/settings.ts';

function SilentPaymentsSettingsPage() {
  const s = settings.value;
  return (
    <Page title={t('silent_payments_settings')} solid id="silent_payments_settings_page">
      <div class="col" style={{ gap: '16px', paddingTop: '10px' }}>
        <Section>
          <ToggleRow label={t('silent_payments_always_scan')} value={s.silentPaymentsAlwaysScan} id="silent_payments_always_scan" onChange={(v) => updateSettings({ silentPaymentsAlwaysScan: v })} />
          <Row label={t('silent_payments_scanning')} id="silent_payments_scanning" onClick={() => nav.push(Routes.rescan)} />
          <Row label={t('silent_payments_logs')} id="silent_payments_logs" onClick={() => nav.push(Routes.silentPaymentsLogs)} />
        </Section>
        <div class="info-box" id="silent_payments_note">Sending to silent payment (sp1…) addresses works. Receiving them needs a server that serves BIP-352 tweak data (Cake runs its own); this web client does not scan for incoming silent payments yet.</div>
      </div>
    </Page>
  );
}

function SilentPaymentsLogsPage() {
  return (
    <Page title={t('silent_payments_logs')} solid id="silent_payments_logs_page">
      <div class="center muted" style={{ paddingTop: '40%' }}>No logs found</div>
    </Page>
  );
}

registerRoute(Routes.silentPaymentsSettings, SilentPaymentsSettingsPage);
registerRoute(Routes.silentPaymentsLogs, SilentPaymentsLogsPage);
