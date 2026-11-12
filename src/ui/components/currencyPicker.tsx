// Currency picker (lib/src/widgets/currency_picker / new-ui currency_picker): searchable list.

import { useState } from 'preact/hooks';
import { t } from '../../core/i18n.ts';
import { showSheet } from './overlays.tsx';
import { Img, MIcon, TopBar } from './core.tsx';
import type { Currency } from '../../coins/types.ts';

export function pickCurrency(list: Currency[], opts: { title?: string; selected?: string } = {}): Promise<Currency | undefined> {
  return showSheet<Currency>((close) => <CurrencyPicker list={list} title={opts.title ?? t('please_select')} selected={opts.selected} close={close} />, { full: true });
}

function CurrencyPicker({ list, title, selected, close }: { list: Currency[]; title: string; selected?: string; close: (c?: Currency) => void }) {
  const [q, setQ] = useState('');
  const ql = q.trim().toLowerCase();
  const filtered = ql ? list.filter((c) => c.title.toLowerCase().includes(ql) || (c.fullName ?? '').toLowerCase().includes(ql) || (c.tag ?? '').toLowerCase().includes(ql)) : list;
  return (
    <div class="col" style={{ height: '100%', background: 'var(--surface)' }} id="currency_picker">
      <TopBar title={title} onClose={() => close()} />
      <div style={{ padding: '0 18px 12px' }}>
        <div class="search">
          <MIcon name="search" size={20} color="var(--on-surface-variant)" />
          <input placeholder={t('search_currency')} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} autoFocus id="currency_search" />
        </div>
      </div>
      <div class="page-body" style={{ padding: '0 18px 24px' }}>
        <div class="list">
          {filtered.map((c) => (
            <button type="button" class="row tap has-icon" onClick={() => close(c)} id={`currency_${c.key}`}>
              <Img src={c.iconPath ?? undefined} size={28} round />
              <span class="lbl">
                <span>
                  {c.title}
                  {c.tag && <span class="pill sm" style={{ marginLeft: '6px', cursor: 'default' }}>{c.tag}</span>}
                </span>
                {c.fullName && <span class="sub">{c.fullName}</span>}
              </span>
              {selected === c.key && <MIcon name="check" color="var(--primary)" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
