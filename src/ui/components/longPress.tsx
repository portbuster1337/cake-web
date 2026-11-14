// Cake's long-press popup (lib/new-ui/widgets/long_press_menu/*): the pressed item drawn again in place
// over a darkened, blurred screen, a translucent menu under it (aligned with its left or right edge by
// the half of the screen it is on), and an optional note at the bottom. Also the long-press gesture.

import { signal } from '@preact/signals';
import type { VNode } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './core.tsx';

export interface LongPressMenuItem {
  label: string;
  /** an SVG asset, tinted with the item's color */
  icon: string;
  /** given the popup's close: an item that does not call it leaves the popup open */
  onSelected: (close: () => void) => void;
  /** a CSS color (on-surface otherwise) */
  color?: string;
  id?: string;
}

interface PopupEntry {
  id: number;
  /** the pressed item's box, relative to the app */
  rect: { left: number; top: number; width: number; height: number };
  appWidth: number;
  appHeight: number;
  child: () => VNode;
  items: LongPressMenuItem[];
  footer?: string;
  spacing: number;
  closing?: boolean;
  resolve: () => void;
}

let seq = 0;
const popups = signal<PopupEntry[]>([]);

/** LongPressPopupBuilder._showMenu: `child` draws the pressed item again (inert) where `anchor` is */
export function showLongPressMenu(anchor: Element, o: { child: () => VNode; items: LongPressMenuItem[]; footer?: string; spacing?: number }): Promise<void> {
  const app = (document.getElementById('app') ?? document.body).getBoundingClientRect();
  const r = anchor.getBoundingClientRect();
  return new Promise((resolve) => {
    popups.value = [
      ...popups.value,
      {
        id: ++seq,
        rect: { left: r.left - app.left, top: r.top - app.top, width: r.width, height: r.height },
        appWidth: app.width,
        appHeight: app.height,
        child: o.child,
        items: o.items,
        footer: o.footer,
        spacing: o.spacing ?? 8,
        resolve,
      },
    ];
  });
}

function closePopup(id: number) {
  const p = popups.value.find((x) => x.id === id);
  if (!p || p.closing) return;
  popups.value = popups.value.map((x) => (x.id === id ? { ...x, closing: true } : x));
  setTimeout(() => {
    popups.value = popups.value.filter((x) => x.id !== id);
    p.resolve();
  }, 150);
}

function Popup({ p }: { p: PopupEntry }) {
  const menu = useRef<HTMLDivElement>(null);
  const below = p.rect.top + p.rect.height + p.spacing;
  const [top, setTop] = useState(below);
  // a press that began before the popup opened does not close it
  const downOnBackdrop = useRef(false);
  const close = () => closePopup(p.id);
  // Cake leaves a menu that runs off the bottom of the screen cut off; this one goes above the item instead
  useLayoutEffect(() => {
    const h = menu.current?.scrollHeight ?? 0;
    const above = p.rect.top - p.spacing - h;
    if (below + h > p.appHeight - 8 && above >= 8) setTop(above);
  }, []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', key);
    (menu.current?.querySelector('button') as HTMLButtonElement | null)?.focus({ preventScroll: true });
    return () => window.removeEventListener('keydown', key);
  }, []);
  const onRight = p.rect.left + p.rect.width / 2 > p.appWidth / 2;
  return (
    <div
      class={`lp-popup${p.closing ? ' closing' : ''}`}
      onPointerDown={(e) => (downOnBackdrop.current = e.target === e.currentTarget)}
      onClick={(e) => {
        if (e.target === e.currentTarget && downOnBackdrop.current) close();
      }}
    >
      <div class="lp-copy" aria-hidden="true" style={{ left: `${p.rect.left}px`, top: `${p.rect.top}px`, width: `${p.rect.width}px`, height: `${p.rect.height}px` }}>
        {p.child()}
      </div>
      <div ref={menu} class="lp-menu" role="menu" style={{ top: `${top}px`, ...(onRight ? { right: `${p.appWidth - (p.rect.left + p.rect.width)}px` } : { left: `${p.rect.left}px` }) }}>
        {p.items.map((it) => (
          <button type="button" role="menuitem" id={it.id} class="lp-item" style={{ color: it.color ?? 'var(--on-surface)' }} onClick={() => it.onSelected(close)}>
            <Icon src={it.icon} size={20} />
            <span>{it.label}</span>
          </button>
        ))}
      </div>
      {p.footer && (
        <div class="lp-footer" role="note">
          <div>
            <Icon src="info.svg" size={18} color="var(--on-surface-variant)" />
            <span>{p.footer}</span>
          </div>
        </div>
      )}
    </div>
  );
}

interface DialogEntry {
  id: number;
  render: (close: (v?: unknown) => void) => VNode;
  closing?: boolean;
  resolve: (v: unknown) => void;
}

const dialogs = signal<DialogEntry[]>([]);

/** showPopUp of a BackdropFilter(blur 10) page (AddressLabelInputPopup, AddressInfoPopup): its content in the middle; a tap beside it closes */
export function showBlurDialog<T = unknown>(render: (close: (v?: T) => void) => VNode): Promise<T | undefined> {
  return new Promise((resolve) => {
    dialogs.value = [...dialogs.value, { id: ++seq, render: render as DialogEntry['render'], resolve: resolve as (v: unknown) => void }];
  });
}

function closeDialog(id: number, v?: unknown) {
  const d = dialogs.value.find((x) => x.id === id);
  if (!d || d.closing) return;
  dialogs.value = dialogs.value.map((x) => (x.id === id ? { ...x, closing: true } : x));
  setTimeout(() => {
    dialogs.value = dialogs.value.filter((x) => x.id !== id);
    d.resolve(v);
  }, 150);
}

function Dialog({ d }: { d: DialogEntry }) {
  const down = useRef(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && closeDialog(d.id);
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  return (
    <div
      class={`lp-popup lp-dialog${d.closing ? ' closing' : ''}`}
      role="dialog"
      aria-modal="true"
      onPointerDown={(e) => (down.current = e.target === e.currentTarget)}
      onClick={(e) => {
        if (e.target === e.currentTarget && down.current) closeDialog(d.id);
      }}
    >
      {d.render((v) => closeDialog(d.id, v))}
    </div>
  );
}

/** the open popups and dialogs (above sheets, below alerts) */
export function LongPressPopups() {
  return (
    <>
      {popups.value.map((p) => (
        <Popup key={p.id} p={p} />
      ))}
      {dialogs.value.map((d) => (
        <Dialog key={d.id} d={d} />
      ))}
    </>
  );
}

/**
 * GestureDetector.onLongPress: held 500 ms without moving 18 px (kTouchSlop), or a right click; the tap that ends a
 * long press is not a tap. Spread the handlers on the element (with class "lp-target", no text selection).
 */
export function useLongPress(onLongPress: (el: HTMLElement) => void, delay = 500) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    clearTimeout(timer.current);
    start.current = null;
  };
  useEffect(() => cancel, []);
  return {
    onPointerDown: (e: PointerEvent) => {
      fired.current = false;
      if (e.button !== 0) return;
      const el = e.currentTarget as HTMLElement;
      start.current = { x: e.clientX, y: e.clientY };
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        start.current = null;
        fired.current = true;
        onLongPress(el);
      }, delay);
    },
    onPointerMove: (e: PointerEvent) => {
      const s = start.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 18) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu: (e: MouseEvent) => {
      e.preventDefault();
      if (fired.current) return;
      cancel();
      fired.current = true;
      onLongPress(e.currentTarget as HTMLElement);
    },
    onClickCapture: (e: MouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      e.stopPropagation();
      e.preventDefault();
    },
  };
}
