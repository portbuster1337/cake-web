// Wallets tab (lib/src/screens/wallet_list/wallet_list_page.dart) and the
// wallet edit page (lib/src/screens/wallet/wallet_edit_page.dart).

import { useState } from 'preact/hooks';
import { t } from '../../../core/i18n.ts';
import { Button, Field, Img, MIcon, Page } from '../../components/core.tsx';
import { confirmAlert, showAlert, toast } from '../../components/overlays.tsx';
import { requireAuth } from '../../components/auth.tsx';
import { currentWallet, walletInfos, openWallet, renameWallet, deleteWallet, walletNameTaken } from '../../../app/app.ts';
import { settings, updateSettings } from '../../../app/settings.ts';
import { walletCurrency, type WalletType } from '../../../coins/types.ts';
import { nav } from '../../nav.ts';
import { registerRoute, Routes } from '../../routes.ts';
import type { WalletInfo } from '../../../core/wallet.ts';
import { dashboardTab } from './index.tsx';

export const WALLET_NAME_RE = /^[a-zA-Z0-9\-_ ]+$/;

export function validateWalletName(name: string): string | null {
  if (!WALLET_NAME_RE.test(name) || name.length < 1 || name.length > 33) return t('error_text_wallet_name');
  return null;
}

function iconFor(type: WalletType): string | undefined {
  if (type === 'base') return 'assets/new-ui/crypto_full_icons/base.svg';
  if (type === 'arbitrum') return 'assets/new-ui/crypto_full_icons/arbitrum.svg';
  if (type === 'robinhood') return 'assets/new-ui/crypto_full_icons/robinhood.svg';
  return walletCurrency(type).iconPath ?? undefined;
}

function groupKey(w: WalletInfo): string {
  return w.hashedWalletIdentifier || w.parentAddress || w.address || w.id;
}

async function switchTo(w: WalletInfo) {
  if (currentWallet.value?.id === w.id) {
    dashboardTab.value = 0;
    return;
  }
  if (!(await requireAuth())) return;
  toast(t('wallet_list_loading_wallet', { wallet_name: w.name }), 4000);
  try {
    await openWallet(w.id);
    dashboardTab.value = 0;
  } catch (e) {
    toast(t('wallet_list_failed_to_load', { wallet_name: w.name, error: (e as Error).message }), 4000);
  }
}

function WalletTile({ w, current, child }: { w: WalletInfo; current: boolean; child?: boolean }) {
  return (
    <div class="rowx" style={{ background: 'var(--surface-container)', borderRadius: child ? 0 : '18px', minHeight: '64px', margin: child ? 0 : '6px 0', cursor: 'pointer' }} onClick={() => void switchTo(w)} id={`wallet_tile_${w.name.replace(/\s+/g, '_')}`}>
      <span style={{ width: '6px', height: '35px', background: current ? 'var(--primary)' : 'transparent', borderRadius: '0 18px 18px 0', marginRight: current ? '16px' : '6px' }} />
      <Img src={iconFor(w.type)} size={32} />
      <span class="grow" style={{ fontSize: '18px', fontWeight: 500, padding: '0 12px', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>{w.name}</span>
      {!current && (
        <button type="button" aria-label={t('edit')} onClick={(e) => { e.stopPropagation(); nav.push(Routes.walletEdit, { walletId: w.id }); }} style={{ width: '34px', height: '34px', borderRadius: '50%', background: 'var(--surface)', border: 0, marginRight: '14px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--on-surface-variant)' }}>
          <MIcon name="edit" size={14} />
        </button>
      )}
    </div>
  );
}

export function WalletListPage() {
  const list = walletInfos.value;
  const cur = currentWallet.value?.id ?? settings.value.currentWalletId;
  const groups = new Map<string, WalletInfo[]>();
  for (const w of list) {
    const k = groupKey(w);
    groups.set(k, [...(groups.get(k) ?? []), w]);
  }
  const shared = [...groups.entries()].filter(([, ws]) => ws.length > 1);
  const single = [...groups.values()].filter((ws) => ws.length === 1).map((ws) => ws[0]);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  return (
    <Page title={t('wallets')} legacy noBack id="wallet_list_page">
      <div style={{ paddingBottom: '260px' }}>
        {shared.length > 0 && (
          <>
            <div style={{ fontSize: '18px', fontWeight: 700, margin: '8px 6px 16px' }}>{t('shared_seed_wallets')}</div>
            {shared.map(([k, ws], i) => {
              const expanded = open[k] ?? ws.some((w) => w.id === cur);
              const name = settings.value.walletGroupNames[k] ?? `${t('wallet_group')} ${i + 1}`;
              return (
                <div style={{ background: 'var(--surface-container)', borderRadius: '18px', overflow: 'hidden', margin: '6px 0' }}>
                  <div class="rowx gap12" style={{ padding: '14px 16px', cursor: 'pointer' }} onClick={() => setOpen({ ...open, [k]: !expanded })}>
                    <img src="./cake/new-ui/navbar/wallets.svg" alt="" style={{ width: '28px', opacity: 0.7 }} />
                    <span class="grow" style={{ fontSize: '18px', fontWeight: 500 }}>{name}</span>
                    <button type="button" aria-label={t('edit')} onClick={(e) => { e.stopPropagation(); nav.push(Routes.walletEdit, { groupKey: k, groupName: name }); }} style={{ width: '34px', height: '34px', borderRadius: '50%', background: 'var(--surface)', border: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--on-surface-variant)' }}>
                      <MIcon name="edit" size={14} />
                    </button>
                    <MIcon name="chevronDown" color="var(--on-surface-variant)" style={{ transform: expanded ? 'rotate(180deg)' : undefined }} />
                  </div>
                  {expanded && ws.map((w) => <WalletTile w={w} current={w.id === cur} child />)}
                </div>
              );
            })}
            <div style={{ height: '24px' }} />
          </>
        )}
        {single.length > 0 && (
          <>
            <div style={{ fontSize: '18px', fontWeight: 700, margin: '8px 6px 16px' }}>{t('single_seed_wallets_group')}</div>
            {single.map((w) => <WalletTile w={w} current={w.id === cur} />)}
          </>
        )}
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '0 16px 100px', background: 'linear-gradient(to bottom, transparent, var(--surface-dim) 40%)' }} class="col gap8">
        <Button secondary id="wallet_list_restore" onClick={() => nav.push(Routes.restoreOptions, false)}>
          <img src="./cake/images/restore_wallet.png" alt="" style={{ width: '12px' }} /> {t('wallet_list_restore_wallet')}
        </Button>
        <Button id="wallet_list_create" onClick={() => nav.push(Routes.newWalletType)}>
          <img src="./cake/images/new_wallet.png" alt="" style={{ width: '12px', filter: 'brightness(10)' }} /> {t('wallet_list_create_new_wallet')}
        </Button>
      </div>
    </Page>
  );
}

function WalletEditPage({ args }: { args: { walletId?: string; groupKey?: string; groupName?: string } }) {
  const info = walletInfos.value.find((w) => w.id === args.walletId);
  const isGroup = !!args.groupKey;
  const [name, setName] = useState(isGroup ? args.groupName ?? '' : info?.name ?? '');
  const err = !isGroup && name ? validateWalletName(name) : null;
  return (
    <Page
      title={isGroup ? t('wallet_list_edit_group_name') : t('wallet_list_edit_wallet')}
      legacy
      id="wallet_edit_page"
      footer={
        <div class="rowx gap12">
          {!isGroup && (
            <Button
              danger
              id="wallet_edit_delete"
              onClick={async () => {
                if (!info) return;
                if (!(await confirmAlert(t('delete_wallet'), t('delete_wallet_confirm_message', { wallet_name: info.name }), t('delete')))) return;
                if (!(await requireAuth({ force: true }))) return;
                await deleteWallet(info.id);
                nav.pop();
              }}
            >
              {t('delete')}
            </Button>
          )}
          <Button
            id="wallet_edit_save"
            disabled={!name.trim() || !!err}
            onClick={async () => {
              if (isGroup) {
                updateSettings((s) => ({ walletGroupNames: { ...s.walletGroupNames, [args.groupKey!]: name.trim() } }));
                nav.pop();
                return;
              }
              if (!info) return;
              if (walletNameTaken(name.trim(), info.id)) {
                await showAlert({ content: t('wallet_name_exists') });
                return;
              }
              await renameWallet(info.id, name.trim());
              nav.pop();
            }}
          >
            {t('save')}
          </Button>
        </div>
      }
    >
      <div style={{ paddingTop: '24px' }}>
        <Field value={name} onInput={setName} placeholder={t('wallet_list_wallet_name')} error={err} id="wallet_edit_name" />
      </div>
    </Page>
  );
}

registerRoute(Routes.walletEdit, WalletEditPage);
registerRoute(Routes.walletList, WalletListPage);
