// Whole-app backup and restore in Cake Wallet's backup v3 format
// (lib/core/backup_service_v3.dart, cake_backup@b5d86a2a lib/backup.dart): an
// outer ZIP with data.bin (the inner ZIP in 24 MiB chunks, each one a
// cake_backup v2 container: PBKDF2-HMAC-SHA512 ×120000 → XChaCha20-Poly1305,
// with a BLAKE2b-512 checksum), metadata.json and README.txt.
//
// The inner ZIP follows the native layout where it can (~_preferences_dump,
// ~_keychain_dump, ~_transaction_descriptions_dump, wallets/<type>/<name>/),
// with the web client's wallet records in place of the native wallet files and
// cake.db. Native wallet files can't be written in a browser, and a native
// keychain dump is encrypted with a secret of the official build, so the web
// client restores its own backups and turns native ones away.

import { bytesToHex } from '@noble/hashes/utils.js';
import { unzipSync, zipSync, type Zippable } from 'fflate';
import { BackupError, cbDecrypt, cbEncrypt, packBackupV3, unpackBackupV3 } from '../core/cakeBackup.ts';
import { vault, serialize, deserialize } from '../core/vault.ts';
import type { WalletInfo, WalletSecrets } from '../core/wallet.ts';
import type { WalletType } from '../coins/types.ts';
import { customNodes, currentNodeIds } from '../core/nodes.ts';
import { contacts, loadContacts, type Contact } from './contacts.ts';
import { settings, updateSettings, type Settings } from './settings.ts';
import { getSecrets, loadWalletInfos, saveNodes, saveSecrets, saveWalletInfo, walletCache, walletInfos } from './app.ts';

export const APP_NAME = 'Cake Wallet';
export const CAKE_VERSION = '6.5.3';
const PASSWORD_KEY = 'backup:password';
/** secrets.backupKeychainSalt of this build: the official app's is not public, so this one is empty */
const KEYCHAIN_SALT = '';
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Settings that are device security state: not exported, and kept on import (like Cake's PIN, 2FA, duress, timeout) */
const SECURITY_KEYS: (keyof Settings)[] = [
  'pinLength', 'pinTimeOutDuration', 'enableDuressPin', 'useTOTP2FA', 'totpSecretKey', 'selectedCake2FAPreset',
  'shouldRequireTOTP2FAForAccessingWallet', 'shouldRequireTOTP2FAForSendsToContact', 'shouldRequireTOTP2FAForSendsToNonContact',
  'shouldRequireTOTP2FAForSendsToInternalWallets', 'shouldRequireTOTP2FAForExchangesToInternalWallets', 'shouldRequireTOTP2FAForExchangesToExternalWallets',
  'shouldRequireTOTP2FAForAddingContacts', 'shouldRequireTOTP2FAForCreatingNewWallets', 'shouldRequireTOTP2FAForAllSecurityAndBackupSettings',
];

/** walletTypeToString(type).toLowerCase(): the wallets/ directory names of the native app */
const TYPE_DIR: Record<WalletType, string> = {
  monero: 'monero', bitcoin: 'bitcoin', litecoin: 'litecoin', haven: 'haven', ethereum: 'ethereum', nano: 'nano', banano: 'banano', bitcoinCash: 'bitcoin cash',
  polygon: 'polygon', solana: 'solana', tron: 'tron', wownero: 'wownero', zano: 'zano', decred: 'decred', dogecoin: 'dogecoin', base: 'base', arbitrum: 'arbitrum',
  zcash: 'zcash', bsc: 'bnb smart chain', robinhood: 'robinhood chain',
};

const TOKEN_CACHES = ['evm:tokens', 'sol:tokens', 'trx:tokens'];

export { BackupError };

/** IncompatibleBackupAppException: made by another app (Monero.com) */
export class IncompatibleBackupAppError extends Error {
  constructor(readonly sourceApp: string) {
    super(`This backup was created in ${sourceApp}, but you are restoring it in ${APP_NAME}. Please make sure this is the correct backup file before continuing.`);
  }
}

// --------------------------------------------------------------- password --

/** BACKUP_CODE_PASSWORD: 64 lower-case hex chars, generated on first use */
export async function getBackupPassword(): Promise<string> {
  const p = await vault.get<string>(PASSWORD_KEY);
  if (p) return p;
  const fresh = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  await vault.put(PASSWORD_KEY, fresh);
  return fresh;
}

export async function setBackupPassword(p: string): Promise<void> {
  await vault.put(PASSWORD_KEY, p);
}

// ----------------------------------------------------------------- export --

interface WalletRecord {
  info: WalletInfo;
  secrets: WalletSecrets;
  caches: Record<string, unknown>;
}

/** backup_view_model.dart: cake_wallet_backup_yyyy-MM-dd_Hm.zip (hour and minute not zero-padded) */
export function backupFileName(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${APP_NAME.replace(/ /g, '_').toLowerCase()}_backup_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${d.getHours()}${d.getMinutes()}.zip`;
}

async function innerZip(password: string): Promise<Uint8Array> {
  const files: Zippable = {};
  const wallets: { id: string; name: string; type: WalletType; path: string }[] = [];
  const descriptions: Record<string, { id: string; recipientAddress: null; transactionNote: string; transactionKey: null }> = {};
  for (const info of walletInfos.value) {
    const secrets = await getSecrets(info.id);
    const caches: Record<string, unknown> = {};
    for (const k of TOKEN_CACHES) {
      const v = await walletCache.get(info.id, k);
      if (v !== undefined) caches[k] = v;
    }
    const path = `wallets/${TYPE_DIR[info.type]}/${info.name}/${info.name}.json`;
    files[path] = enc.encode(serialize({ info, secrets, caches } satisfies WalletRecord));
    wallets.push({ id: info.id, name: info.name, type: info.type, path });
    const notes = (await vault.get<Record<string, string>>(`txnotes:${info.id}`)) ?? {};
    for (const [txid, note] of Object.entries(notes)) {
      const id = `${txid}_${info.address}`;
      descriptions[id] = { id, recipientAddress: null, transactionNote: note, transactionKey: null };
    }
  }
  const prefs: Record<string, unknown> = { ...settings.value };
  for (const k of SECURITY_KEYS) delete prefs[k];
  files['~_preferences_dump'] = enc.encode(JSON.stringify(prefs));
  files['~_transaction_descriptions_dump'] = enc.encode(JSON.stringify(descriptions));
  const keychain = { wallets: wallets.map((w) => ({ name: w.name, type: `WalletType.${w.type}`, password: '', hardwareWalletType: null })), BACKUP_CODE_PASSWORD: password, _all: {} };
  files['~_keychain_dump'] = await cbEncrypt(KEYCHAIN_SALT + password, enc.encode(JSON.stringify(keychain)));
  files['cake_web.json'] = enc.encode(serialize({ version: 1, app: APP_NAME, wallets, contacts: contacts.value, nodes: { custom: customNodes.value, current: currentNodeIds.value } }));
  return zipSync(files, { level: 9 });
}

/** BackupServiceV3.exportBackup */
export async function exportBackup(): Promise<{ name: string; data: Uint8Array }> {
  const password = await getBackupPassword();
  return { name: backupFileName(), data: await packBackupV3(await innerZip(password), password, APP_NAME, CAKE_VERSION) };
}

// ----------------------------------------------------------------- import --

/** BackupServiceV3.importBackup: v3 (ZIP) and v2 (one container) files; v1 needs the official build's secret */
export async function importBackup(file: Uint8Array, password: string, checkBackupApp = true): Promise<void> {
  let inner: Uint8Array;
  if (file[0] === 0x50) {
    let outer: Record<string, Uint8Array>;
    try {
      outer = unzipSync(file);
    } catch {
      throw new BackupError('This is not a valid backup file, please make sure you have selected the correct one');
    }
    const readme = outer['README.txt'] ? dec.decode(outer['README.txt']) : '';
    const src = /^This is a (.+) backup\./m.exec(readme)?.[1];
    if (checkBackupApp && src && src !== APP_NAME) throw new IncompatibleBackupAppError(src);
    inner = await unpackBackupV3(outer, password);
  } else if (file[0] === 0x02) {
    inner = await cbDecrypt(password, file);
  } else if (file[0] === 0x01) {
    throw new BackupError('This backup uses the first backup format of the Cake Wallet app, which only the app can open');
  } else {
    throw new BackupError('This is not a valid backup file, please make sure you have selected the correct one');
  }
  const files = unzipSync(inner);
  for (const name of Object.keys(files)) {
    if (name.startsWith('/') || name.split('/').includes('..')) throw new BackupError(`unsafe backup entry: ${name}, please contact support`);
  }
  const web = files['cake_web.json'];
  if (!web) throw new BackupError('This backup was made by the Cake Wallet app: its wallet files are encrypted with a secret of the app and cannot be opened here. Restore each wallet from its recovery phrase instead.');
  const manifest = deserialize<{ wallets: { id: string; path: string }[]; contacts?: Contact[]; nodes?: { custom?: typeof customNodes.value; current?: typeof currentNodeIds.value } }>(dec.decode(web));
  // keychain dump: the backup password comes back (importKeychainDumpV2)
  const kc = files['~_keychain_dump'];
  if (kc) {
    const k = JSON.parse(dec.decode(await cbDecrypt(KEYCHAIN_SALT + password, kc))) as { BACKUP_CODE_PASSWORD?: string };
    if (k.BACKUP_CODE_PASSWORD) await setBackupPassword(k.BACKUP_CODE_PASSWORD);
  }
  const byAddress = new Map<string, string>();
  for (const w of manifest.wallets) {
    const raw = files[w.path];
    if (!raw) continue;
    const rec = deserialize<WalletRecord>(dec.decode(raw));
    await saveSecrets(rec.info.id, rec.secrets);
    await saveWalletInfo(rec.info);
    for (const [k, v] of Object.entries(rec.caches ?? {})) await walletCache.put(rec.info.id, k, v);
    if (rec.info.address) byAddress.set(rec.info.address, rec.info.id);
  }
  // ~_transaction_descriptions_dump: "<txid>_<wallet address>" → note
  const td = files['~_transaction_descriptions_dump'];
  if (td) {
    const notes: Record<string, Record<string, string>> = {};
    for (const d of Object.values(JSON.parse(dec.decode(td)) as Record<string, { id: string; transactionNote?: string | null }>)) {
      if (!d?.transactionNote) continue;
      const cut = d.id.lastIndexOf('_');
      const walletId = cut > 0 ? byAddress.get(d.id.slice(cut + 1)) : undefined;
      if (!walletId) continue;
      (notes[walletId] ??= {})[d.id.slice(0, cut)] = d.transactionNote;
    }
    for (const [id, n] of Object.entries(notes)) await vault.put(`txnotes:${id}`, { ...((await vault.get<Record<string, string>>(`txnotes:${id}`)) ?? {}), ...n });
  }
  if (manifest.contacts) {
    await loadContacts();
    const have = new Set(contacts.value.map((c) => c.id));
    await vault.put('contacts', [...contacts.value, ...manifest.contacts.filter((c) => !have.has(c.id))]);
    await loadContacts();
  }
  if (manifest.nodes) {
    const ids = new Set(customNodes.value.map((n) => n.id));
    customNodes.value = [...customNodes.value, ...(manifest.nodes.custom ?? []).filter((n) => !ids.has(n.id))];
    currentNodeIds.value = { ...currentNodeIds.value, ...(manifest.nodes.current ?? {}) };
    await saveNodes();
  }
  // ~_preferences_dump (importPreferencesDump), keeping this device's security state
  const pd = files['~_preferences_dump'];
  if (pd) {
    const prefs = JSON.parse(dec.decode(pd)) as Partial<Settings>;
    for (const k of SECURITY_KEYS) delete (prefs as Record<string, unknown>)[k];
    updateSettings(prefs);
  }
  await loadWalletInfos();
}
