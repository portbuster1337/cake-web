// Sheets (iOS/Material bottom sheets), alerts (showPopUp / BaseAlertDialog)
// and toasts (showBar), rendered above the page stack.

import { signal } from '@preact/signals';
import type { ComponentChildren, VNode } from 'preact';
import { t } from '../../core/i18n.ts';

interface SheetEntry {
  id: number;
  render: (close: (v?: unknown) => void) => VNode;
  full?: boolean;
  gradient?: boolean;
  dismissible?: boolean;
  resolve: (v: unknown) => void;
  closing?: boolean;
}

interface AlertEntry {
  id: number;
  title?: string;
  content?: ComponentChildren;
  left?: string;
  right?: string;
  error?: boolean;
  dismissible?: boolean;
  resolve: (v: boolean | null) => void;
}

let seq = 0;
export const sheets = signal<SheetEntry[]>([]);
export const alerts = signal<AlertEntry[]>([]);
export const toastMsg = signal<{ id: number; text: string } | null>(null);

export function showSheet<T = unknown>(render: (close: (v?: T) => void) => VNode, opts: { full?: boolean; gradient?: boolean; dismissible?: boolean } = {}): Promise<T | undefined> {
  return new Promise((resolve) => {
    const id = ++seq;
    sheets.value = [...sheets.value, { id, render: render as SheetEntry['render'], ...opts, dismissible: opts.dismissible ?? true, resolve: resolve as (v: unknown) => void }];
  });
}

export function closeSheet(id: number, v?: unknown) {
  const s = sheets.value.find((x) => x.id === id);
  if (!s || s.closing) return;
  sheets.value = sheets.value.map((x) => (x.id === id ? { ...x, closing: true } : x));
  setTimeout(() => {
    sheets.value = sheets.value.filter((x) => x.id !== id);
    s.resolve(v);
  }, 200);
}

export function closeAllSheets() {
  for (const s of sheets.value) closeSheet(s.id);
}

/** showPopUp(AlertWithTwoActions / AlertWithOneAction). Resolves true for the right (primary) action. */
export function showAlert(o: { title?: string; content?: ComponentChildren; left?: string; right?: string; error?: boolean; dismissible?: boolean }): Promise<boolean | null> {
  return new Promise((resolve) => {
    const id = ++seq;
    alerts.value = [...alerts.value, { id, ...o, right: o.right ?? t('ok'), dismissible: o.dismissible ?? true, resolve }];
  });
}

export function confirmAlert(title: string, content: ComponentChildren, right = t('confirm'), left = t('cancel')): Promise<boolean> {
  return showAlert({ title, content, left, right }).then((v) => v === true);
}

export function errorAlert(e: unknown, title = t('error')): Promise<boolean | null> {
  const msg = e instanceof Error ? e.message : String(e);
  return showAlert({ title, content: msg, right: t('ok') });
}

function closeAlert(id: number, v: boolean | null) {
  const a = alerts.value.find((x) => x.id === id);
  alerts.value = alerts.value.filter((x) => x.id !== id);
  a?.resolve(v);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** showBar: a short message at the top */
export function toast(text: string, ms = 1500) {
  const id = ++seq;
  toastMsg.value = { id, text };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (toastMsg.value?.id === id) toastMsg.value = null;
  }, ms);
}

export function Overlays() {
  return (
    <>
      {sheets.value.map((s) => (
        <div class={`overlay${s.closing ? ' closing' : ''}`} key={s.id}>
          <div class="veil" onClick={() => s.dismissible && closeSheet(s.id)} />
          <div class={`sheet${s.full ? ' full' : ''}${s.gradient ? ' gradient' : ''}${s.closing ? ' closing' : ''}`} role="dialog" aria-modal="true">
            {s.render((v) => closeSheet(s.id, v))}
          </div>
        </div>
      ))}
      {alerts.value.map((a) => (
        <div class="alert-wrap" key={a.id} onClick={(e) => e.target === e.currentTarget && a.dismissible && closeAlert(a.id, null)}>
          <div class="alert" role="alertdialog">
            {a.title && <h3>{a.title}</h3>}
            {a.content !== undefined && <div class="content">{a.content}</div>}
            <div class="acts">
              {a.left && (
                <button type="button" class="sec" onClick={() => closeAlert(a.id, false)}>
                  {a.left}
                </button>
              )}
              <button type="button" class={a.error ? 'err' : ''} onClick={() => closeAlert(a.id, true)}>
                {a.right}
              </button>
            </div>
          </div>
        </div>
      ))}
      {toastMsg.value && (
        <div class="toast" role="status" key={toastMsg.value.id}>
          {toastMsg.value.text}
        </div>
      )}
    </>
  );
}
