// First-run and unlock screens: CreatePinWelcomePage (Routes.welcome),
// SetupPinCodePage (Routes.welcomeWallet / setupPin), WelcomePage
// (Routes.welcomePage: create or restore) and the PIN login (Routes.login).

import { useEffect, useState } from 'preact/hooks';
import { t } from '../../core/i18n.ts';
import { vault } from '../../core/vault.ts';
import { nav } from '../nav.ts';
import { registerRoute, Routes } from '../routes.ts';
import { Button, Img, Page } from '../components/core.tsx';
import { PinCode } from '../components/pincode.tsx';
import { showAlert } from '../components/overlays.tsx';
import { currentPalette } from '../theme/themes.ts';
import { setupPin, unlock, lockoutState, torStatus, phase } from '../../app/app.ts';
import { settings, updateSettings } from '../../app/settings.ts';
import { db } from '../../core/db.ts';

export const WELCOME_PAGE = '/welcome_page';

function TypingWords({ words }: { words: string[] }) {
  const [i, setI] = useState(0);
  const [n, setN] = useState(0);
  useEffect(() => {
    const w = words[i];
    const id = setTimeout(() => {
      if (n < w.length) setN(n + 1);
      else {
        setTimeout(() => {
          setN(0);
          setI((i + 1) % words.length);
        }, 1200);
      }
    }, 90);
    return () => clearTimeout(id);
  }, [i, n]);
  return (
    <span style={{ color: 'var(--primary)', fontWeight: 600 }}>
      {words[i].slice(0, n)}
      <span style={{ display: 'inline-block', width: '4px', height: '24px', background: 'var(--primary)', verticalAlign: 'middle', marginLeft: '2px', animation: 'fade-out 0.8s infinite alternate' }} />
    </span>
  );
}

function CreatePinWelcomePage() {
  const dark = currentPalette().isDark;
  return (
    <div class="page legacy" id="create_pin_welcome_page">
      <div class="page-body" style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ position: 'relative', width: '100%' }}>
          <Img src={`assets/images/welcome_${dark ? 'dark' : 'light'}_theme.svg`} w={480} h={384} style={{ width: '100%', height: 'auto' }} />
          <div class="col" style={{ position: 'absolute', left: 0, right: 0, top: '57%', alignItems: 'center' }}>
            <div style={{ fontSize: '60px', fontWeight: 700, letterSpacing: '2.5px', color: 'var(--primary)' }}>{t('welcome')}</div>
            <div class="rowx gap8" style={{ marginTop: '16px', justifyContent: 'center' }}>
              <span style={{ fontSize: '16px', fontWeight: 500 }}>{t('to').toLowerCase()}</span>
              <Img src={`assets/images/cake_logo_${dark ? 'dark' : 'light'}.svg`} h={40} w={40} />
              <span style={{ fontSize: '22px', fontWeight: 600 }}>{t('cake_wallet')}</span>
            </div>
            <div class="rowx gap4" style={{ marginTop: '48px', fontSize: '22px', fontWeight: 600 }}>
              <TypingWords words={[t('payments'), t('privacy'), t('security')]} />
              <span>{t('made_easy')}</span>
            </div>
          </div>
        </div>
      </div>
      <div class="bottom-actions">
        <div class="center muted" style={{ fontWeight: 500 }}>
          By continuing, you agree to our{' '}
          <a href="#" style={{ color: 'var(--on-surface-variant)', fontWeight: 700 }} onClick={(e) => (e.preventDefault(), nav.push(Routes.readDisclaimer))}>
            Terms of Service
          </a>
        </div>
        <div style={{ height: '12px' }} />
        <Button id="create_pin_welcome_page_create_a_pin_button_key" onClick={() => nav.push(Routes.welcomeWallet)}>
          {t('set_a_pin')}
        </Button>
        <TorLine />
      </div>
    </div>
  );
}

/** A small line telling the user how Tor is doing (Cake shows Tor state in the sync bar). */
export function TorLine() {
  const s = torStatus.value;
  if (s.state === 'idle') return null;
  const color = s.state === 'ready' ? 'var(--sync-green)' : s.state === 'error' ? 'var(--error)' : 'var(--on-surface-variant)';
  return (
    <div class="rowx gap8" style={{ justifyContent: 'center', fontSize: '12px', color }} id="tor-status-line">
      <img src="./cake/new-ui/tor.svg" alt="" style={{ width: '14px', height: '14px' }} />
      <span>{s.message}</span>
    </div>
  );
}

function SetupPinCodePage({ args }: { args?: { onSuccess?: () => void; isDuress?: boolean; title?: string } }) {
  const [first, setFirst] = useState<string | null>(null);
  const [len, setLen] = useState<number>(settings.value.pinLength ?? 4);
  const [busy, setBusy] = useState(false);
  const title = args?.isDuress ? t('durres_PIN') : t('setup_pin');
  return (
    <Page title={title} bodyClass="" solid>
      <PinCode
        title={first ? t('enter_your_pin_again') : t('enter_your_pin')}
        length={len}
        hasLengthSwitcher={!first}
        onLengthChange={setLen}
        busy={busy}
        onFull={async (pin, api) => {
          if (!first) {
            // setup_pin_code_view_model.dart: the duress PIN must differ from the regular one
            if (args?.isDuress && (await vault.verify(pin))) {
              await showAlert({ title, content: 'Invalid argument(s): Duress PIN cannot be the same as regular PIN', right: t('ok') });
              api.clear();
              return;
            }
            setFirst(pin);
            api.clear();
            return;
          }
          if (pin !== first) {
            await showAlert({ title, content: t('pin_is_incorrect'), right: t('ok') });
            setFirst(null);
            api.clear();
            return;
          }
          setBusy(true);
          try {
            if (args?.onSuccess) {
              (args as any).pin = pin;
              await (args as any).onPin?.(pin);
            } else {
              await setupPin(pin);
              updateSettings({ pinLength: len as 4 | 6 });
            }
            await showAlert({ title, content: args?.isDuress ? t('durres_PIN_set_up_successfully') : t('setup_successful'), right: t('ok') });
            if (args?.onSuccess) args.onSuccess();
            else {
              phase.value = 'ready';
              nav.reset(WELCOME_PAGE);
            }
          } catch (e) {
            await showAlert({ title, content: `${t('setup_pin_is_failed')} ${(e as Error).message}`, right: t('ok') });
            setFirst(null);
            api.clear();
          } finally {
            setBusy(false);
          }
        }}
      />
    </Page>
  );
}

function WelcomePage() {
  const dark = currentPalette().isDark;
  return (
    <Page title={t('wallet')} legacy noBack id="welcome_page" footer={
      <>
        <Button secondary id="welcome_page_restore_wallet_button_key" onClick={() => nav.push(Routes.restoreOptions, true)}>
          {t('restore_restore_wallet')}
        </Button>
        <Button id="welcome_page_create_new_wallet_button_key" onClick={() => nav.push(Routes.newWalletFromWelcome)}>
          {t('create_new')}
        </Button>
      </>
    }>
      <div class="col" style={{ alignItems: 'center', gap: '24px' }}>
        <Img src={`assets/new-ui/hero/welcome_wallet_${dark ? 'dark' : 'light'}.svg`} w={300} h={260} style={{ width: '70%', height: 'auto' }} />
        <div style={{ fontSize: '16px', lineHeight: 1.5 }}>
          <p style={{ margin: '0 0 16px' }}>{t('welcome_subtitle_new_wallet')}</p>
          <p style={{ margin: 0 }}>{t('welcome_subtitle_restore_wallet')}</p>
        </div>
      </div>
    </Page>
  );
}

function LoginPage() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [len, setLen] = useState(4);
  useEffect(() => {
    void db.get<number>('kv', 'pinLength').then((n) => n && setLen(n));
    void lockoutState().then((f) => {
      if (f.bannedUntil > Date.now()) setError(`${t('auth_store_banned_for')}${Math.ceil((f.bannedUntil - Date.now()) / 60000)}${t('auth_store_banned_minutes')}`);
    });
  }, []);
  return (
    <div class="page solid" id="login_page">
      <PinCode
        title={t('enter_your_pin')}
        length={len}
        error={error}
        busy={busy}
        onFull={async (pin, api) => {
          setBusy(true);
          try {
            const r = await unlock(pin);
            if (!r.ok) {
              api.clear();
              if (r.bannedUntil) setError(`${t('auth_store_banned_for')}${Math.ceil((r.bannedUntil - Date.now()) / 60000)}${t('auth_store_banned_minutes')}`);
              else setError(t('auth_store_incorrect_password'));
            }
          } finally {
            setBusy(false);
          }
        }}
      />
      <div style={{ position: 'absolute', bottom: '16px', left: 0, right: 0 }}>
        <TorLine />
      </div>
    </div>
  );
}

registerRoute(Routes.welcome, CreatePinWelcomePage);
registerRoute(Routes.welcomeWallet, SetupPinCodePage);
registerRoute(Routes.setupPin, SetupPinCodePage);
registerRoute(WELCOME_PAGE, WelcomePage);
registerRoute(Routes.login, LoginPage);
