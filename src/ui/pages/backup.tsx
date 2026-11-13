// Backup (lib/src/screens/backup/backup_page.dart, edit_backup_password_page.dart)
// and Restore from backup (lib/src/screens/restore/restore_from_backup_page.dart).

import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../core/i18n.ts';
import { Button, Field, MIcon, Page, Spinner } from '../components/core.tsx';
import { showAlert, showSheet, toast } from '../components/overlays.tsx';
import { registerRoute, Routes } from '../routes.ts';
import { nav } from '../nav.ts';
import { openWallet, walletInfos } from '../../app/app.ts';
import { settings } from '../../app/settings.ts';
import { exportBackup, getBackupPassword, importBackup, IncompatibleBackupAppError, setBackupPassword } from '../../app/backup.ts';

function download(name: string, data: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/zip' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** a blocking overlay while the backup is built (the "Creating backup" bottom sheet) */
function busyOverlay(text: string): () => void {
  let done: () => void = () => {};
  void showSheet<void>((close) => {
    done = () => close();
    return <div class="col" style={{ alignItems: 'center', gap: '16px', padding: '32px 24px 40px' }}><Spinner large /><div>{text}</div></div>;
  });
  return () => done();
}

function BackupPage() {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void getBackupPassword().then(setPassword);
  }, []);
  const doExport = async () => {
    if (!password) return;
    const ok = await showAlert({ title: t('export_backup'), content: t('save_backup_password'), left: t('seed_alert_back'), right: t('seed_alert_yes'), error: true });
    if (ok !== true) return;
    setBusy(true);
    const close = busyOverlay(t('creating_backup'));
    try {
      const { name, data } = await exportBackup();
      download(name, data);
    } catch (e) {
      await showAlert({ title: t('error'), content: (e as Error).message, right: t('ok') });
    } finally {
      close();
      setBusy(false);
    }
  };
  return (
    <Page
      title={t('backup')}
      legacy
      id="backup_page"
      footer={
        <>
          <Button secondary id="backup_change_password" onClick={() => nav.push(Routes.editBackupPassword)}>{t('change_password')}</Button>
          <Button loading={busy} id="backup_export" onClick={() => void doExport()}>{t('export_backup')}</Button>
        </>
      }
    >
      <div class="col" style={{ alignItems: 'center', justifyContent: 'center', gap: '16px', minHeight: '60%', textAlign: 'center', paddingTop: '48px' }}>
        <div style={{ fontSize: '14px' }}>{`${t('backup_password')}:`}</div>
        <button type="button" id="backup_password" onClick={() => void navigator.clipboard.writeText(password).then(() => toast(t('transaction_details_copied', { title: t('backup_password') }))).catch(() => {})} style={{ background: 'none', border: 0, color: 'var(--on-surface)', fontSize: '26px', fontWeight: 600, wordBreak: 'break-all', cursor: 'pointer', fontFamily: 'inherit' }}>{password}</button>
        <div class="muted" style={{ fontSize: '14px' }}>{t('write_down_backup_password')}</div>
      </div>
    </Page>
  );
}

function EditBackupPasswordPage() {
  const [stored, setStored] = useState('');
  const [v, setV] = useState('');
  useEffect(() => {
    void getBackupPassword().then((p) => {
      setStored(p);
      setV(p);
    });
  }, []);
  const save = async () => {
    const ok = await showAlert({ title: t('save_backup_password_alert'), content: t('change_backup_password_alert'), left: t('cancel'), right: t('ok') });
    if (ok !== true) return;
    await setBackupPassword(v);
    nav.pop();
  };
  return (
    <Page title={t('edit_backup_password')} legacy id="edit_backup_password_page" footer={<Button disabled={v === stored} id="edit_backup_password_save" onClick={() => void save()}>{t('save')}</Button>}>
      <div style={{ paddingTop: '24px' }}>
        <Field value={v} onInput={setV} id="edit_backup_password_field" />
      </div>
    </Page>
  );
}

/** restore_from_backup_view_model.dart: errors as Cake words them */
function backupErrorText(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  const l = m.toLowerCase();
  if (l.includes('message authentication code (mac)')) return 'Incorrect backup password';
  if (l.includes('faileddecryption')) return 'Failed to decrypt backup file, please check you entered the right password';
  if (l.includes('failed_to_decode')) return 'Failed to decode backup file, please try again';
  return m;
}

function RestoreFromBackupPage() {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [file, setFile] = useState<{ name: string; data: Uint8Array } | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const run = async (checkApp: boolean): Promise<void> => {
    if (!password || !file) {
      await showAlert({ title: t('error'), content: t('please_select_backup_file'), right: t('ok') });
      return;
    }
    setBusy(true);
    try {
      await importBackup(file.data, password, checkApp);
      const id = settings.value.currentWalletId ?? walletInfos.value[0]?.id;
      if (id && walletInfos.value.some((w) => w.id === id)) await openWallet(id).catch(() => {});
      nav.reset(Routes.dashboard);
    } catch (e) {
      if (e instanceof IncompatibleBackupAppError) {
        setBusy(false);
        if ((await showAlert({ title: t('warning'), content: e.message, left: t('cancel'), right: t('ok') })) === true) await run(false);
        return;
      }
      await showAlert({ title: t('error'), content: backupErrorText(e), right: t('ok') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page
      title={t('restore_title_from_backup')}
      legacy
      id="restore_from_backup_page"
      footer={
        <>
          <Button danger id="restore_select_backup_file" onClick={() => input.current?.click()}>{t('select_backup_file')}</Button>
          <Button loading={busy} id="restore_backup_import" onClick={() => void run(true)}>{t('import')}</Button>
        </>
      }
    >
      <div class="col gap16" style={{ paddingTop: '24px' }}>
        <Field value={password} onInput={setPassword} placeholder={t('enter_backup_password')} type={show ? 'text' : 'password'} id="restore_backup_password" suffix={<button type="button" class="ficon" onClick={() => setShow(!show)}><MIcon name={show ? 'eyeOff' : 'eye'} size={20} /></button>} />
        {file && <div id="restore_backup_file_name">{`File Name: ${file.name}`}</div>}
        <input ref={input} type="file" accept=".zip,application/zip,application/octet-stream" id="restore_backup_file" style={{ display: 'none' }} onChange={async (e) => {
          const f = (e.target as HTMLInputElement).files?.[0];
          if (f) setFile({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
        }} />
      </div>
    </Page>
  );
}

registerRoute(Routes.backup, BackupPage);
registerRoute(Routes.editBackupPassword, EditBackupPasswordPage);
registerRoute(Routes.restoreFromBackup, RestoreFromBackupPage);
