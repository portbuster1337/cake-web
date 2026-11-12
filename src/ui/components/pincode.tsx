// PIN pad (lib/src/screens/pin_code/pin_code_widget.dart): title, dots,
// optional 4/6 length switcher, 3x4 keypad (blank, 0, delete).

import { useEffect, useState } from 'preact/hooks';
import { t } from '../../core/i18n.ts';

export interface PinCodeProps {
  title: string;
  length: number;
  onFull: (pin: string, api: PinApi) => void;
  hasLengthSwitcher?: boolean;
  onLengthChange?: (n: number) => void;
  error?: string | null;
  busy?: boolean;
}

export interface PinApi {
  clear: () => void;
}

export function PinCode({ title, length, onFull, hasLengthSwitcher, onLengthChange, error, busy }: PinCodeProps) {
  const [pin, setPin] = useState('');
  const [len, setLen] = useState(length);
  useEffect(() => setLen(length), [length]);

  const api: PinApi = { clear: () => setPin('') };

  const push = (d: number) => {
    if (busy) return;
    setPin((p) => {
      if (p.length >= len) return p;
      const n = p + String(d);
      if (n.length === len) setTimeout(() => onFull(n, api), 60);
      return n;
    });
  };
  const pop = () => setPin((p) => p.slice(0, -1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Backspace') pop();
      else if (/^\d$/.test(e.key)) push(Number(e.key));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div class="col" style={{ flex: 1, alignItems: 'center', padding: '0 44px 60px', background: 'var(--surface)' }}>
      <div style={{ flex: 2 }} />
      <div style={{ fontSize: '20px', fontWeight: 500, textAlign: 'center' }} id="pin-title">
        {title}
      </div>
      <div style={{ flex: 2, minHeight: '24px' }} />
      <div class="rowx" style={{ width: '180px', justifyContent: 'space-between' }} aria-label={`${pin.length}/${len}`}>
        {Array.from({ length: len }, (_, i) => (
          <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--primary)', opacity: i < pin.length ? 1 : 0.25 }} />
        ))}
      </div>
      <div style={{ minHeight: '24px', marginTop: '16px', color: 'var(--error)', textAlign: 'center' }} id="pin-error">
        {error}
      </div>
      <div style={{ flex: 3 }} />
      {hasLengthSwitcher && (
        <button
          type="button"
          class="link-btn"
          style={{ color: 'var(--secondary)', fontWeight: 400, minHeight: '36px' }}
          onClick={() => {
            const n = len === 4 ? 6 : 4;
            setLen(n);
            setPin('');
            onLengthChange?.(n);
          }}
        >
          {t('use')}
          {len === 4 ? 6 : 4}
          {t('digit_pin')}
        </button>
      )}
      <div style={{ flex: 1 }} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px 20px', width: '100%', maxWidth: '330px' }}>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9, -1, 0, -2].map((d) =>
          d === -1 ? (
            <span />
          ) : d === -2 ? (
            <button type="button" aria-label={t('delete')} onClick={pop} style={keyStyle}>
              <img src="./cake/images/delete_icon.png" alt="" style={{ width: '26px', filter: 'none' }} class="pin-del" />
            </button>
          ) : (
            <button type="button" id={`pin_code_button_${d}_key`} onClick={() => push(d)} style={{ ...keyStyle, fontSize: '30px', fontWeight: 600, color: 'var(--on-surface-variant)' }}>
              {d}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

const keyStyle = {
  aspectRatio: '1.1',
  borderRadius: '50%',
  border: 0,
  background: 'var(--surface-container)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  margin: '0 auto',
  width: '100%',
  maxWidth: '88px',
} as const;
