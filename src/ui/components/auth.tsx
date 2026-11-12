// AuthPage as a sheet: re-enter the PIN before sensitive actions
// (switching wallets, showing seeds/keys, backups, security settings).

import { useState } from 'preact/hooks';
import { t } from '../../core/i18n.ts';
import { showSheet } from './overlays.tsx';
import { PinCode } from './pincode.tsx';
import { TopBar } from './core.tsx';
import { verifyPin, lockoutState, MAX_FAILED_LOGINS, BAN_TIMEOUT_S } from '../../app/app.ts';
import { settings } from '../../app/settings.ts';
import { db } from '../../core/db.ts';

/** AuthService.requireAuth(): whole minutes since the last successful PIN entry >= "Require PIN after" */
export function authExpired(): boolean {
  const minutes = settings.value.pinTimeOutDuration;
  return Math.floor((Date.now() - lastAuthTime()) / 60000) >= minutes;
}

export function lastAuthTime(): number {
  try {
    return Number(sessionStorage.getItem('cw-last-auth') ?? 0);
  } catch {
    return 0;
  }
}

export function saveLastAuthTime(): void {
  try {
    sessionStorage.setItem('cw-last-auth', String(Date.now()));
  } catch { /* storage disabled */ }
}

/**
 * authenticateAction: resolves true once the PIN was entered (or recently enough,
 * unless `always` — Cake's ALWAYS_AUTH_ROUTES: seed, keys, backup, PIN, 2FA, …).
 * With Cake 2FA enabled and `totp` set, the TOTP code is asked after the PIN.
 */
export async function requireAuth(opts: { always?: boolean; force?: boolean; totp?: boolean } = {}): Promise<boolean> {
  const always = opts.always || opts.force;
  if (!always && !opts.totp && !authExpired()) return true;
  const ok = await showSheet<boolean>((close) => <AuthSheet close={close} />, { full: true });
  if (!ok) return false;
  saveLastAuthTime();
  if (opts.totp && settings.value.useTOTP2FA) {
    const { verifyTotpSheet } = await import('../pages/settings/twofa.tsx');
    return verifyTotpSheet();
  }
  return true;
}

function AuthSheet({ close }: { close: (v?: boolean) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div class="col" style={{ height: '100%', background: 'var(--surface)' }} id="auth_sheet">
      <TopBar title={t('authentication')} onClose={() => close(false)} />
      <PinCode
        title={t('enter_your_pin')}
        length={settings.value.pinLength}
        error={error}
        busy={busy}
        onFull={async (pin, api) => {
          setBusy(true);
          try {
            const f = await lockoutState();
            if (f.bannedUntil > Date.now()) {
              setError(`${t('auth_store_banned_for')}${Math.ceil((f.bannedUntil - Date.now()) / 60000)}${t('auth_store_banned_minutes')}`);
              api.clear();
              return;
            }
            if (await verifyPin(pin)) {
              await db.put('kv', 'auth:failures', { count: 0, bannedUntil: 0 });
              close(true);
              return;
            }
            const count = f.count + 1;
            const ban = count >= MAX_FAILED_LOGINS ? (count - MAX_FAILED_LOGINS + 1) * BAN_TIMEOUT_S * 1000 : 0;
            await db.put('kv', 'auth:failures', { count, bannedUntil: ban ? Date.now() + ban : 0 });
            setError(ban ? `${t('auth_store_banned_for')}${Math.ceil(ban / 60000)}${t('auth_store_banned_minutes')}` : t('auth_store_incorrect_password'));
            api.clear();
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}
