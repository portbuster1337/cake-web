// Bump fee (lib/src/screens/transaction_details/rbf_details_page.dart,
// TransactionDetailsViewModel.addBumpFeesListItems): the old fee, a new fee
// from a priority (or a custom rate), the inputs and outputs, and Send, which
// replaces the transaction (same inputs, the change pays the difference).

import { useEffect, useState } from 'preact/hooks';
import { t } from '../../core/i18n.ts';
import { AddressText, Button, Icon, Page, Row, Section } from '../components/core.tsx';
import { confirmAlert, showAlert } from '../components/overlays.tsx';
import { registerRoute, Routes } from '../routes.ts';
import { nav } from '../nav.ts';
import { currentWallet } from '../../app/app.ts';
import { settings } from '../../app/settings.ts';
import { formatFixed } from '../../core/amount.ts';
import { pickFee } from './send.tsx';
import type { PendingTransaction, WalletBase } from '../../core/wallet.ts';

type RbfWallet = WalletBase & {
  canReplaceByFee?: (txid: string) => boolean;
  replaceByFee?: (txid: string, rate: number) => Promise<PendingTransaction>;
  feeRateFor?: (priority: string, custom?: number) => number;
};

function Expandable({ title, items }: { title: string; items: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" class="row tap" onClick={() => setOpen(!open)} style={{ width: '100%' }}>
        <span class="lbl">{`${title}: ${items.length}`}</span>
        <Icon src="dropdown_arrow.svg" w={12} h={7} color="var(--primary)" style={{ transform: open ? undefined : 'rotate(180deg)', transition: 'transform 300ms' }} />
      </button>
      {open && <div class="col" style={{ gap: '8px', padding: '0 16px 12px' }}>{items.map((a) => <span class="mono" style={{ fontSize: '12px' }}><AddressText address={a.includes('OP_RETURN:') && a.length > 40 ? `${a.slice(0, 40)}...` : a} /></span>)}</div>}
    </div>
  );
}

function BumpFeePage({ args }: { args?: { txid?: string } }) {
  const w = currentWallet.value as RbfWallet | null;
  const txid = args?.txid ?? '';
  const [priority, setPriority] = useState('medium');
  const [custom, setCustom] = useState(() => settings.value.customElectrumFeeRate ?? 1);
  const [pending, setPending] = useState<PendingTransaction | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const tx = w?.transactions.value.find((x) => x.id === txid);
  const rate = w?.feeRateFor?.(priority, custom) ?? 1;
  useEffect(() => {
    if (!w?.replaceByFee || !tx) return;
    let alive = true;
    setError('');
    w.replaceByFee(txid, rate).then((p) => alive && setPending(p)).catch((e) => {
      if (!alive) return;
      setPending(null);
      setError((e as Error).message);
    });
    return () => {
      alive = false;
    };
  }, [txid, rate]);
  if (!w || !tx) return null;
  const c = w.currency;
  const fmt = (v: bigint) => `${formatFixed(v, c.decimals)} ${c.title}`;
  const opt = w.priorities().find((p) => p.id === priority);
  // the old fee rate (sat/vB) from the transaction details row, as Cake derives it from the raw transaction
  const oldRate = Number.parseFloat(tx.extra?.feeRate ?? '');
  const send = async () => {
    if (!pending) return;
    if (!(await confirmAlert(t('bump_fee'), `${t('estimated_new_fee')}: ${fmt(pending.fee)}`, t('send'), t('cancel')))) return;
    setBusy(true);
    try {
      await pending.commit();
      nav.pop();
    } catch (e) {
      await showAlert({ title: t('error'), content: (e as Error).message, right: t('ok') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title={t('bump_fee')} legacy id="bump_fee_page" footer={<Button loading={busy} disabled={!pending} id="bump_fee_send" onClick={() => void send()}>{t('send')}</Button>}>
      <div class="col gap12" style={{ paddingTop: '12px' }}>
        <Section>
          <Row label={`${t('old_fee')}:`} trailingText={tx.fee !== undefined ? fmt(tx.fee) : '0.0'} copy={tx.fee !== undefined ? fmt(tx.fee) : undefined} />
          {tx.fee !== undefined && oldRate > 0 && <Row label="New recommended fee rate:" trailingText={`${Math.floor(oldRate) + 1} sat/byte`} />}
          <Row
            label={t('estimated_new_fee')}
            id="bump_fee_priority"
            subtitle={opt ? `${opt.label} (${priority === 'custom' ? `${custom} sat/byte` : opt.rateLabel ?? ''})` : undefined}
            trailingText={pending ? fmt(pending.fee) : '…'}
            arrow
            onClick={async () => {
              const v = await pickFee(w, priority, custom);
              if (!v) return;
              setPriority(v.priority);
              if (v.custom) setCustom(v.custom);
            }}
          />
          {!!tx.inputAddresses?.length && <Expandable title={t('inputs')} items={tx.inputAddresses} />}
          {!!tx.outputAddresses?.length && <Expandable title={t('outputs')} items={tx.outputAddresses} />}
        </Section>
        {error && <div class="field-error" id="bump_fee_error">{error}</div>}
      </div>
    </Page>
  );
}

registerRoute(Routes.bumpFeePage, BumpFeePage);
