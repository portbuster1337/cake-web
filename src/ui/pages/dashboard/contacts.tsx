// Contacts tab (lib/src/screens/contact/contact_list_page.dart) and the
// contact page (contact_page.dart). Also used as the address book picker.

import { useEffect, useState } from 'preact/hooks';
import { t } from '../../../core/i18n.ts';
import { AddressText, Button, Field, Img, MIcon, ModernButton, Page } from '../../components/core.tsx';
import { confirmAlert, showAlert, toast } from '../../components/overlays.tsx';
import { pickCurrency } from '../../components/currencyPicker.tsx';
import { contacts, deleteContact, loadContacts, saveContact, type Contact } from '../../../app/contacts.ts';
import { walletInfos } from '../../../app/app.ts';
import { ALL_CURRENCIES, currency, walletCurrency, WALLET_TYPE_NAME } from '../../../coins/types.ts';
import { isValidAddressFor } from '../../../core/addressValidator.ts';
import { nav } from '../../nav.ts';
import { registerRoute, Routes } from '../../routes.ts';
import { copyText } from '../../components/core.tsx';

function iconForCurrencyKey(key: string): string | undefined {
  if (key === 'baseEth') return 'assets/new-ui/crypto_full_icons/base.svg';
  if (key === 'arbEth') return 'assets/new-ui/crypto_full_icons/arbitrum.svg';
  if (key === 'robEth') return 'assets/new-ui/crypto_full_icons/robinhood.svg';
  try {
    return currency(key).iconPath ?? undefined;
  } catch {
    return undefined;
  }
}

async function showAddressPopup(name: string, address: string) {
  const ok = await showAlert({ title: name, content: <div style={{ fontSize: '16px' }}><AddressText address={address} /></div>, left: t('cancel'), right: t('copy') });
  if (ok) await copyText(address);
}

export function ContactListPage({ args }: { args?: { picker?: boolean; currency?: string; onPick?: (c: { address: string; name: string }) => void } }) {
  const picker = !!args?.picker;
  const [tab, setTab] = useState<'wallets' | 'contacts'>(picker ? 'contacts' : 'wallets');
  useEffect(() => void loadContacts(), []);
  const wallets = walletInfos.value.filter((w) => w.address);
  const list = contacts.value.filter((c) => !args?.currency || c.currency === args.currency || currency(c.currency).tag === currency(args.currency).title);
  const pick = (address: string, name: string) => {
    if (picker) {
      args?.onPick?.({ address, name });
      nav.pop({ address, name });
    } else void showAddressPopup(name, address);
  };
  return (
    <Page
      title={t('address_book')}
      legacy
      noBack={!picker}
      id="contact_list_page"
      trailing={!picker ? <ModernButton icon="add" size={36} iconSize={22} label={t('add_contact')} id="add_contact_button" onClick={() => nav.push(Routes.addressBookAddContact)} /> : undefined}
    >
      <div class="rowx gap24" style={{ padding: '0 6px 16px' }}>
        {(['wallets', 'contacts'] as const).map((k) => (
          <button type="button" onClick={() => setTab(k)} id={`contacts_tab_${k}`} style={{ background: 'none', border: 0, padding: '4px 0', fontSize: '20px', fontWeight: 600, color: tab === k ? 'var(--primary)' : 'var(--on-surface-variant)', borderBottom: tab === k ? '2px solid var(--primary)' : '2px solid transparent', cursor: 'pointer' }}>
            {k === 'wallets' ? t('wallets') : t('contact_list_contacts')}
          </button>
        ))}
      </div>
      <div class="col" style={{ gap: '8px', paddingBottom: '120px' }}>
        {tab === 'wallets'
          ? wallets
              .filter((w) => !args?.currency || walletCurrency(w.type).key === args.currency)
              .map((w) => (
                <button type="button" class="rowx gap12" onClick={() => pick(w.address, w.name)} style={{ background: 'var(--surface-container)', borderRadius: '18px', padding: '16px', border: 0, cursor: 'pointer', color: 'var(--on-surface)', textAlign: 'start' }}>
                  <Img src={walletCurrency(w.type).iconPath ?? undefined} size={24} />
                  <span class="grow">{w.name} <span class="muted">({WALLET_TYPE_NAME[w.type]})</span></span>
                </button>
              ))
          : list.map((c) => <ContactRow c={c} picker={picker} onPick={() => pick(c.address, c.name)} />)}
        {tab === 'contacts' && !list.length && <div class="empty">{t('no_contacts') === 'no_contacts' ? '' : t('no_contacts')}</div>}
      </div>
    </Page>
  );
}

function ContactRow({ c, picker, onPick }: { c: Contact; picker: boolean; onPick: () => void }) {
  const [actions, setActions] = useState(false);
  return (
    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: '18px' }}>
      <div class="rowx gap12" style={{ background: 'var(--surface-container)', padding: '16px', cursor: 'pointer' }} onClick={onPick} onContextMenu={(e) => { e.preventDefault(); if (!picker) setActions(!actions); }} id={`contact_${c.name.replace(/\s+/g, '_')}`}>
        <Img src={iconForCurrencyKey(c.currency)} size={24} />
        <span class="grow">{c.name}</span>
        {!picker && (
          <button type="button" aria-label={t('edit')} class="ficon" onClick={(e) => { e.stopPropagation(); setActions(!actions); }}>
            <MIcon name="more" size={20} color="var(--on-surface-variant)" />
          </button>
        )}
      </div>
      {actions && (
        <div class="rowx" style={{ position: 'absolute', right: 0, top: 0, bottom: 0 }}>
          <button type="button" onClick={() => { setActions(false); nav.push(Routes.addressBookAddContact, { contact: c }); }} style={{ height: '100%', border: 0, background: 'var(--primary)', color: 'var(--on-primary)', padding: '0 16px', cursor: 'pointer' }}>{t('edit')}</button>
          <button
            type="button"
            onClick={async () => {
              setActions(false);
              if (await confirmAlert(t('address_remove_contact'), t('address_remove_content'), t('remove'))) await deleteContact(c.id);
            }}
            style={{ height: '100%', border: 0, background: 'var(--error)', color: 'var(--on-error)', padding: '0 16px', cursor: 'pointer' }}
          >
            {t('delete')}
          </button>
        </div>
      )}
    </div>
  );
}

function ContactPage({ args }: { args?: { contact?: Contact; address?: string; currency?: string } }) {
  const ex = args?.contact;
  const [name, setName] = useState(ex?.name ?? '');
  const [cur, setCur] = useState<string | undefined>(ex?.currency ?? args?.currency);
  const [address, setAddress] = useState(ex?.address ?? args?.address ?? '');
  const c = cur ? currency(cur) : undefined;
  const addrErr = c && address && !isValidAddressFor(c, address) ? t('error_text_address') : null;
  const nameErr = name.length > 32 ? t('error_text_contact_name') : null;
  const valid = !!name.trim() && !!c && !!address.trim() && !addrErr && !nameErr;
  return (
    <Page
      title={t('contact')}
      legacy
      id="contact_page"
      footer={
        <div class="rowx gap12">
          <Button secondary onClick={() => { setName(''); setCur(undefined); setAddress(''); }}>{t('reset')}</Button>
          <Button
            id="contact_page_save_button"
            disabled={!valid}
            onClick={async () => {
              try {
                await saveContact({ id: ex?.id, name: name.trim(), address: address.trim(), currency: cur! });
                nav.pop();
              } catch (e) {
                const m = (e as Error).message;
                await showAlert({ title: t('contact'), content: m === 'contact_name_exists' ? t('contact_name_exists') : m });
              }
            }}
          >
            {t('save')}
          </Button>
        </div>
      }
    >
      <div class="col gap16" style={{ paddingTop: '24px' }}>
        <Field value={name} onInput={setName} placeholder={t('contact_name')} error={nameErr} id="contact_name" />
        <button type="button" class="field" style={{ cursor: 'pointer', justifyContent: 'space-between' }} id="contact_currency" onClick={async () => {
          const p = await pickCurrency(ALL_CURRENCIES, { selected: cur });
          if (p) setCur(p.key);
        }}>
          <span class={c ? '' : 'muted'} style={{ fontSize: '16px' }}>{c ? `${c.title}${c.tag ? ` (${c.tag})` : ''}` : t('settings_currency')}</span>
          <MIcon name="chevronDown" color="var(--primary)" />
        </button>
        {c && <Field value={address} onInput={setAddress} placeholder={t('widgets_address')} error={addrErr} multiline rows={2} mono id="contact_address" suffix={<button type="button" class="ficon" onClick={async () => { try { setAddress((await navigator.clipboard.readText()).trim()); } catch { toast(t('paste')); } }}><img src="./cake/images/paste_ios.png" alt={t('paste')} style={{ width: '18px' }} /></button>} />}
      </div>
    </Page>
  );
}

registerRoute(Routes.addressBook, ContactListPage);
registerRoute(Routes.pickerAddressBook, (p: any) => <ContactListPage args={{ ...(p.args ?? {}), picker: true }} />);
registerRoute(Routes.addressBookAddContact, ContactPage);
