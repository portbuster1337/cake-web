// Nano: Change Representative (lib/src/screens/nano/nano_change_rep_page.dart).

import { useEffect, useState } from 'preact/hooks';
import { t } from '../../core/i18n.ts';
import { Button, Field, Icon, Page } from '../components/core.tsx';
import { confirmAlert, showAlert } from '../components/overlays.tsx';
import { registerRoute, Routes } from '../routes.ts';
import { nav } from '../nav.ts';
import { currentWallet } from '../../app/app.ts';
import { updateSettings } from '../../app/settings.ts';
import { parsePaymentRequest } from '../../core/paymentUri.ts';
import { isValidNanoAddress } from '../../coins/nano/nano.ts';
import type { N2Node, NanoWallet } from '../../coins/nano/wallet.ts';

/** the "verified" badge outline (Icons.verified), its check covered by the score */
const BADGE = 'M23 12l-2.44-2.79.34-3.69-3.61-.82-1.89-3.2L12 2.96 8.6 1.5 6.71 4.69 3.1 5.5l.34 3.7L1 12l2.44 2.79-.34 3.7 3.61.82L8.6 22.5l3.4-1.47 3.4 1.46 1.89-3.19 3.61-.82-.34-3.69L23 12z';

/** rpc.nano.to reports absolute weights; shown as the share of the listed representatives' total */
function weightPercent(rep: N2Node, total: number): string {
  if (!total || !rep.weight) return '0';
  return ((rep.weight / total) * 100).toFixed(2).replace(/\.?0+$/, '');
}

function RepTile({ rep, total, onClick, divider }: { rep: N2Node; total: number; onClick?: () => void; divider?: boolean }) {
  return (
    <>
      {divider && <div style={{ height: '1px', background: 'var(--outline-variant)' }} />}
      <button type="button" onClick={onClick} disabled={!onClick} class="rowx" id={onClick ? `rep_${rep.account.slice(5, 13)}` : 'current_rep'} style={{ width: '100%', justifyContent: 'space-between', padding: '20px 0', background: 'none', border: 0, cursor: onClick ? 'pointer' : 'default', textAlign: 'start', color: 'var(--on-surface)' }}>
        <span class="col" style={{ marginInlineStart: '24px', width: '50%', gap: '0', minWidth: 0 }}>
          <span style={{ fontWeight: 700, fontSize: rep.alias ? '18px' : '14px', wordBreak: 'break-all' }}>{rep.alias || rep.account}</span>
          <span style={{ marginTop: '7px', fontWeight: 700, color: 'var(--on-surface-variant)' }}>{`${t('voting_weight')}: ${weightPercent(rep, total)}%`}</span>
          <span style={{ marginTop: '4px', color: 'var(--on-surface-variant)' }}>
            <span style={{ fontWeight: 700 }}>{`${t('uptime')}: `}</span>
            <span style={{ fontWeight: 900 }}>{rep.uptime ?? ''}</span>
          </span>
        </span>
        <span style={{ position: 'relative', width: '50px', height: '50px', marginInlineEnd: '24px', marginInlineStart: '14px', flex: 'none' }}>
          <svg viewBox="0 0 24 24" width="50" height="50" aria-hidden="true"><path d={BADGE} fill="var(--primary)" /></svg>
          <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800, color: 'var(--on-primary)' }}>{String(rep.score ?? 0)}</span>
        </span>
      </button>
    </>
  );
}

function ChangeRepPage() {
  const w = currentWallet.value as NanoWallet | null;
  const [address, setAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [reps, setReps] = useState<N2Node[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!w || w.type !== 'nano') return;
    let alive = true;
    void w.getN2Reps().then((r) => alive && setReps(r));
    if (!w.representativeAddress.value) void w.refreshRep().catch(() => {});
    return () => {
      alive = false;
    };
  }, [w?.id]);
  if (!w || w.type !== 'nano') return null;
  const current = w.representativeAddress.value;
  const total = reps.reduce((s, r) => s + (r.weight || 0), 0);
  const currentNode: N2Node = reps.find((r) => r.account === current) ?? { account: current, score: 0, uptime: '???', weight: 0 };
  const listed = reps.filter((r) => r.alias && r.alias.trim());
  const onInput = (v: string) => {
    setAddress(v);
    setError(null);
  };
  const submit = async () => {
    const a = address.trim();
    if (!isValidNanoAddress(a)) {
      setError(t('error_text_address'));
      return;
    }
    if (!(await confirmAlert(t('change_rep'), t('change_rep_message'), t('change'), t('cancel')))) return;
    setBusy(true);
    try {
      updateSettings({ defaultNanoRep: a });
      await w.changeRep(a);
      // reset whenever the representative changed
      updateSettings({ shouldShowRepWarning: true });
      await showAlert({ title: t('successful'), content: t('change_rep_successful'), right: t('ok') });
    } catch (e) {
      await showAlert({ title: t('error'), content: (e as Error).message, right: t('ok') });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Page title={t('change_rep')} legacy id="change_rep_page" footer={<Button id="change_rep_button" loading={busy} onClick={() => void submit()}>{t('change')}</Button>}>
      <div class="col" style={{ paddingBottom: '24px' }}>
        <Field
          value={address}
          onInput={onInput}
          placeholder={t('widgets_address')}
          error={error}
          multiline
          rows={2}
          mono
          id="change_rep_address"
          suffix={
            <span class="rowx" style={{ gap: '8px' }}>
              <button type="button" class="ficon" aria-label={t('paste')} onClick={async () => { try { onInput((await navigator.clipboard.readText()).trim()); } catch { /* clipboard blocked */ } }}><Icon src="paste.svg" size={20} /></button>
              <button type="button" class="ficon" aria-label={t('scan')} onClick={async () => { const v = await nav.pushForResult<string>('/scan', { mode: 'address' }); if (v) onInput(parsePaymentRequest(v).address); }}><Icon src="scan.svg" size={20} /></button>
            </span>
          }
        />
        <div style={{ marginTop: '12px', fontSize: '16px', fontWeight: 700, textAlign: 'center' }}>{t('nano_current_rep')}</div>
        <RepTile rep={currentNode} total={total} />
        {reps.length > 0 && (
          <>
            <div style={{ height: '1px', background: 'var(--outline-variant)', margin: '10px 0' }} />
            <div style={{ marginTop: '12px', fontSize: '16px', fontWeight: 700, textAlign: 'center' }}>{t('nano_pick_new_rep')}</div>
            <div style={{ height: '1px', background: 'var(--outline-variant)', margin: '10px 0' }} />
          </>
        )}
        <div id="rep_list">
          {listed.map((r, i) => (
            <RepTile rep={r} total={total} divider={i > 0} onClick={() => onInput(r.account)} />
          ))}
        </div>
      </div>
    </Page>
  );
}

registerRoute(Routes.changeRep, ChangeRepPage);
