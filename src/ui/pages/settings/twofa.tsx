// Cake 2FA (lib/src/screens/setup_2fa/**, lib/view_model/set_up_2fa_viewmodel.dart,
// lib/utils/totp_utils.dart): TOTP with HMAC-SHA512, 8 digits, 30 s, current step only.

import { useState } from 'preact/hooks';
import { hmac } from '@noble/hashes/hmac.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { base32 } from '@scure/base';
import { t } from '../../../core/i18n.ts';
import { Button, Field, Img, Page, Row, Section, Segmented, ToggleRow, TopBar, copyText } from '../../components/core.tsx';
import { confirmAlert, showAlert, showSheet } from '../../components/overlays.tsx';
import { QrCode } from '../../components/qr.tsx';
import { registerRoute, Routes } from '../../routes.ts';
import { nav } from '../../nav.ts';
import { settings, updateSettings, type Settings } from '../../../app/settings.ts';
import { db } from '../../../core/db.ts';
import { openExternal } from '../dashboard/history.tsx';

export function generateTotpSecret(): string {
  return base32.encode(crypto.getRandomValues(new Uint8Array(16)));
}

export function totpCode(secret: string, nowMs = Date.now()): string {
  const key = base32.decode(secret.replace(/\s/g, '').toUpperCase());
  let counter = Math.floor(Math.floor(nowMs / 1000) / 30);
  const msg = new Uint8Array(8);
  for (let i = 7; i >= 0; i--) {
    msg[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  const h = hmac(sha512, key, msg);
  const o = h[63] & 0x0f;
  const code = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 100_000_000;
  return String(code).padStart(8, '0');
}

export function totpUri(secret: string): string {
  const device = (navigator.userAgent.match(/(Firefox|Chrome|Safari|Edg)\/[\d.]+/)?.[1] ?? 'Browser') + '%20Web';
  return `otpauth://totp/Cake%20Wallet:${device}?secret=${secret}&issuer=Cake%20Wallet&algorithm=SHA512&digits=8&period=30`;
}

type Flag = keyof Settings;
const FLAGS: { key: Flag; label: string; control: string }[] = [
  { key: 'shouldRequireTOTP2FAForAccessingWallet', label: 'require_for_assessing_wallet', control: 'accessWallet' },
  { key: 'shouldRequireTOTP2FAForSendsToNonContact', label: 'require_for_sends_to_non_contacts', control: 'sendsToNonContacts' },
  { key: 'shouldRequireTOTP2FAForSendsToContact', label: 'require_for_sends_to_contacts', control: 'sendsToContacts' },
  { key: 'shouldRequireTOTP2FAForSendsToInternalWallets', label: 'require_for_sends_to_internal_wallets', control: 'sendsToInternalWallets' },
  { key: 'shouldRequireTOTP2FAForExchangesToInternalWallets', label: 'require_for_exchanges_to_internal_wallets', control: 'exchangesToInternalWallets' },
  { key: 'shouldRequireTOTP2FAForExchangesToExternalWallets', label: 'require_for_exchanges_to_external_wallets', control: 'exchangesToExternalWallets' },
  { key: 'shouldRequireTOTP2FAForAddingContacts', label: 'require_for_adding_contacts', control: 'addingContacts' },
  { key: 'shouldRequireTOTP2FAForCreatingNewWallets', label: 'require_for_creating_new_wallets', control: 'creatingNewWallets' },
  { key: 'shouldRequireTOTP2FAForAllSecurityAndBackupSettings', label: 'require_for_all_security_and_backup_settings', control: 'securityAndBackupSettings' },
];

const PRESETS: Record<string, string[]> = {
  narrow: ['addingContacts', 'sendsToNonContacts', 'creatingNewWallets', 'securityAndBackupSettings'],
  normal: ['sendsToContacts', 'sendsToNonContacts', 'sendsToInternalWallets', 'securityAndBackupSettings', 'exchangesToInternalWallets'],
  aggressive: ['accessWallet', 'securityAndBackupSettings'],
};

function applyPreset(p: string) {
  const on = new Set(PRESETS[p] ?? []);
  const patch: Partial<Settings> = { selectedCake2FAPreset: p };
  for (const f of FLAGS) (patch as any)[f.key] = on.has(f.control);
  updateSettings(patch);
}

function detectPreset(s: Settings): string {
  const on = FLAGS.filter((f) => s[f.key]).map((f) => f.control);
  for (const [k, v] of Object.entries(PRESETS)) if (v.length === on.length && v.every((c) => on.includes(c))) return k;
  return 'none';
}

// --------------------------------------------------------- verification --

const BAN_KEY = 'auth:totp';

async function checkCode(code: string, isForSetup: boolean): Promise<'ok' | 'wrong' | { banned: number }> {
  const st = (await db.get<{ count: number; bannedUntil: number }>('kv', BAN_KEY)) ?? { count: 0, bannedUntil: 0 };
  if (st.bannedUntil > Date.now()) return { banned: Math.ceil((st.bannedUntil - Date.now()) / 60000) };
  const ok = code === totpCode(settings.value.totpSecretKey);
  if (isForSetup) updateSettings({ useTOTP2FA: ok });
  if (ok) {
    await db.put('kv', BAN_KEY, { count: 0, bannedUntil: 0 });
    return 'ok';
  }
  const count = st.count + 1;
  // the 3rd failure bans for (3 - 3) * 180 s = 0 min, the 4th for 3 min, …
  const ban = count >= 3 ? (count - 3) * 180_000 : 0;
  await db.put('kv', BAN_KEY, { count, bannedUntil: ban ? Date.now() + ban : 0 });
  return ban ? { banned: Math.ceil(ban / 60000) } : 'wrong';
}

export function verifyTotpSheet(closable = true): Promise<boolean> {
  return showSheet<boolean>((close) => <TotpEnter isForSetup={false} onDone={(ok) => close(ok)} closable={closable} />, { full: true, dismissible: closable }).then((v) => !!v);
}

function TotpEnter({ isForSetup, onDone, closable = true }: { isForSetup: boolean; onDone: (ok: boolean) => void; closable?: boolean }) {
  const [code, setCode] = useState('');
  return (
    <div class="col" style={{ height: '100%', background: 'var(--surface)' }} id="totp_page">
      <TopBar title={isForSetup ? t('setup_2fa') : t('verify_with_2fa')} onClose={closable ? () => onDone(false) : undefined} />
      <div class="page-body pad col gap16">
        <Field value={code} onInput={(v) => setCode(v.replace(/\D/g, '').slice(0, 8))} placeholder={t('totp_code')} inputMode="numeric" id="totp_code" autoFocus />
        <div class="muted">{t('please_fill_totp')}</div>
      </div>
      <div class="bottom-actions">
        <Button disabled={code.length !== 8} id="totp_continue" onClick={async () => {
          const r = await checkCode(code, isForSetup);
          if (r === 'ok') {
            await showAlert({ content: isForSetup ? t('totp_2fa_success') : t('totp_verification_success') });
            onDone(true);
          } else if (r === 'wrong') {
            await showAlert({ content: t('totp_2fa_failure') });
            setCode('');
          } else {
            await showAlert({ content: t('failed_authentication', { state_error: `${t('auth_store_banned_for')}${r.banned}${t('auth_store_banned_minutes')}` }) });
          }
        }}>{t('continue_text')}</Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- pages --

function Setup2FAInfoPage() {
  const dark = document.documentElement.dataset.theme !== 'light';
  return (
    <Page title="Cake 2FA" legacy id="setup_2fa_info_page" footer={<Button onClick={() => nav.replace(Routes.setup_2faPage)}>{t('understand')}</Button>}>
      <div class="col" style={{ alignItems: 'center', gap: '24px', paddingTop: '24px', textAlign: 'center' }}>
        <Img src={`assets/images/2fa_warning_${dark ? 'dark' : 'light'}.svg`} w={160} h={160} />
        <div style={{ fontSize: '18px', fontWeight: 600 }}>{t('pre_seed_title')}</div>
        <div class="muted">{t('setup_warning_2fa_text')}</div>
      </div>
    </Page>
  );
}

function Setup2FAPage() {
  // opening any 2FA page writes the current preset's flags (Cake quirk)
  if (settings.value.selectedCake2FAPreset !== 'none' && detectPreset(settings.value) !== settings.value.selectedCake2FAPreset) applyPreset(settings.value.selectedCake2FAPreset);
  return (
    <Page title="Cake 2FA" legacy id="setup_2fa_page">
      <div class="col gap24" style={{ alignItems: 'center', paddingTop: '16px' }}>
        <Img src="assets/images/2fa.png" w={220} h={220} />
        <div class="muted center">{t('setup_2fa_text')}</div>
        <Section>
          <Row label={t('setup_totp_recommended')} id="setup_totp" onClick={() => { updateSettings({ totpSecretKey: generateTotpSecret() }); nav.replace(Routes.setup_2faQRPage); }} />
          <Row label="Cake 2FA Guide" onClick={() => openExternal('https://docs.cakewallet.com/features/advanced/authentication/')} />
        </Section>
      </div>
    </Page>
  );
}

function Setup2FAQRPage() {
  const secret = settings.value.totpSecretKey;
  const uri = totpUri(secret);
  return (
    <Page title={t('setup_2fa')} legacy id="setup_2fa_qr_page" footer={<Button id="setup_2fa_qr_continue" onClick={() => nav.replace(Routes.totpAuthCodePage, { isForSetup: true })}>{t('continue_text')}</Button>}>
      <div class="col gap16" style={{ alignItems: 'center' }}>
        <div>{t('scan_qr_on_device')}</div>
        <div style={{ border: '3px solid var(--on-surface)', borderRadius: '24px' }}><QrCode data={uri} size={220} /></div>
        <div class="muted">{t('add_secret_code')}</div>
        <Section>
          <Row label={t('totp_secret_code')} subtitle={<span class="mono" id="totp_secret">{secret}</span>} copy={secret} />
          <Row label={t('totp_auth_url')} subtitle={<span class="mono" style={{ fontSize: '11px' }}>{uri}</span>} copy={uri} />
        </Section>
        <button type="button" class="link-btn" onClick={() => openExternal('https://docs.cakewallet.com/features/advanced/authentication/#enabling-cake-2fa')}>{t('how_to_use')}</button>
      </div>
    </Page>
  );
}

function TotpAuthCodePage({ args }: { args?: { isForSetup?: boolean } }) {
  return (
    <div class="page solid">
      <TotpEnter isForSetup={!!args?.isForSetup} onDone={(ok) => {
        if (ok && args?.isForSetup) nav.replace(Routes.modify2FAPage);
        else nav.pop(ok);
      }} />
    </div>
  );
}

function Modify2FAPage() {
  const s = settings.value;
  const preset = detectPreset(s);
  return (
    <Page title={t('modify_2fa')} legacy id="modify_2fa_page">
      <div class="col gap16">
        <Section>
          <Row label={t('disable_cake_2fa')} id="disable_2fa" onClick={async () => {
            if (!(await confirmAlert(t('disable_cake_2fa'), t('question_to_disable_2fa'), t('disable')))) return;
            updateSettings({ useTOTP2FA: false });
            nav.reset(Routes.dashboard);
          }} />
        </Section>
        <div class="col gap12">
          <div>{t('cake_2fa_preset')}</div>
          <Segmented options={[{ value: 'narrow', label: 'Narrow' }, { value: 'normal', label: 'Normal' }, { value: 'aggressive', label: 'Aggressive' }]} value={preset} onChange={(v) => applyPreset(v)} />
        </div>
        <Section>
          {FLAGS.map((f) => (
            <ToggleRow label={t(f.label)} value={!!s[f.key]} onChange={(v) => {
              updateSettings({ [f.key]: v } as any);
              updateSettings((x) => ({ selectedCake2FAPreset: detectPreset(x) }));
            }} />
          ))}
        </Section>
      </div>
    </Page>
  );
}

registerRoute(Routes.setup2faInfoPage, Setup2FAInfoPage);
registerRoute(Routes.setup_2faPage, Setup2FAPage);
registerRoute(Routes.setup_2faQRPage, Setup2FAQRPage);
registerRoute(Routes.totpAuthCodePage, TotpAuthCodePage);
registerRoute(Routes.modify2FAPage, Modify2FAPage);
export { copyText };
