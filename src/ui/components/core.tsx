// Core UI components modelled on Cake Wallet's new-UI widgets
// (ModernButton, NewPrimaryButton, ModalTopBar, ListItem* rows, StandardSwitch…).

import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../core/i18n.ts';
import { nav } from '../nav.ts';
import { toast } from './overlays.tsx';

export function asset(path: string): string {
  if (path.startsWith('./') || path.startsWith('http') || path.startsWith('data:') || path.startsWith('blob:')) return path;
  if (path.startsWith('assets/new-ui/')) return `./cake/new-ui/${path.slice(14)}`;
  if (path.startsWith('assets/images/')) return `./cake/images/${path.slice(14)}`;
  if (path.startsWith('new-ui/')) return `./cake/${path}`;
  return `./cake/new-ui/${path}`;
}

/** Tinted SVG icon (CakeImageWidget with a srcIn color filter). */
export function Icon({ src, size = 24, w, h, color, style, class: cls }: { src: string; size?: number; w?: number; h?: number; color?: string; style?: JSX.CSSProperties; class?: string }) {
  // the mask URL must be absolute: url() inside a stylesheet rule would resolve against the CSS file
  const url = typeof document !== 'undefined' ? new URL(asset(src), document.baseURI).href : asset(src);
  const m = `url("${url}")`;
  return <span class={`icon ${cls ?? ''}`} aria-hidden="true" style={{ width: `${w ?? size}px`, height: `${h ?? size}px`, WebkitMaskImage: m, maskImage: m, color, ...style } as JSX.CSSProperties} />;
}

/** Untinted image (pre-colored SVG/PNG). */
export function Img({ src, size = 24, w, h, round, style, alt = '' }: { src?: string; size?: number; w?: number; h?: number; round?: boolean; style?: JSX.CSSProperties; alt?: string }) {
  if (!src) return <span style={{ width: `${w ?? size}px`, height: `${h ?? size}px`, display: 'inline-block', flex: 'none' }} />;
  return <img class="img" src={asset(src)} alt={alt} draggable={false} style={{ width: `${w ?? size}px`, height: `${h ?? size}px`, borderRadius: round ? '50%' : undefined, ...style }} />;
}

// Material icons used by Cake (Icons.close, arrow_back_ios_new, …) as inline SVG paths.
const MI: Record<string, string> = {
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  back: 'M17.77 3.77 16 2 6 12l10 10 1.77-1.77L9.54 12z',
  check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
  chevronRight: 'M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
  chevronDown: 'M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z',
  copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
  share: 'M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z',
  add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
  delete: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  search: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
  lock: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zM9 6c0-1.66 1.34-3 3-3s3 1.34 3 3v2H9V6zm9 14H6V10h12v10zm-6-3c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2z',
  backspace: 'M22 3H7c-.69 0-1.23.35-1.59.88L0 12l5.41 8.11c.36.53.9.89 1.59.89h15c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H7.07L2.4 12l4.66-7H22v14zm-11.59-2L14 13.41 17.59 17 19 15.59 15.41 12 19 8.41 17.59 7 14 10.59 10.41 7 9 8.41 12.59 12 9 15.59z',
  refresh: 'M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  info: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
  warning: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
  language: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zm6.93 6h-2.95a15.65 15.65 0 0 0-1.38-3.56A8.03 8.03 0 0 1 18.92 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2s.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56A7.99 7.99 0 0 1 5.08 16zm2.95-8H5.08a7.99 7.99 0 0 1 4.33-3.56A15.65 15.65 0 0 0 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2s.07-1.35.16-2h4.68c.09.65.16 1.32.16 2s-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2s-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z',
  account_balance_wallet_outlined: 'M21 7.28V5c0-1.1-.9-2-2-2H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-2.28c.59-.35 1-.98 1-1.72V9c0-.74-.41-1.37-1-1.72zM20 9v6h-7V9h7zM5 19V5h14v2h-6c-1.1 0-2 .9-2 2v6c0 1.1.9 2 2 2h6v2H5zM16 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 1 0 0-3z',
  arrow_forward: 'M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z',
  history: 'M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z',
  error_outline: 'M11 15h2v2h-2zm0-8h2v6h-2zm.99-5C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z',
  warning_amber: 'M12 5.99 19.53 19H4.47L12 5.99M12 2 1 21h22L12 2zm1 14h-2v2h2v-2zm0-6h-2v4h2v-4z',
  arrowDown: 'M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z',
  arrowUp: 'M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z',
  swap: 'M6.99 11 3 15l3.99 4v-3H14v-2H6.99v-3zM21 9l-3.99-4v3H10v2h7.01v3L21 9z',
  eye: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z',
  eyeOff: 'M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46A11.804 11.804 0 0 0 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2z',
  qr: 'M3 11h8V3H3v8zm2-6h4v4H5V5zM3 21h8v-8H3v8zm2-6h4v4H5v-4zM13 3v8h8V3h-8zm6 6h-4V5h4v4zM13 13h2v2h-2zM15 15h2v2h-2zM13 17h2v2h-2zM17 17h2v2h-2zM19 19h2v2h-2zM15 19h2v2h-2zM17 13h2v2h-2zM19 15h2v2h-2z',
  globe: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm6.93 6h-2.95a15.65 15.65 0 0 0-1.38-3.56A8.03 8.03 0 0 1 18.93 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14C4.1 13.36 4 12.69 4 12s.1-1.36.26-2h3.38c-.08.66-.14 1.32-.14 2s.06 1.34.14 2H4.26zm.82 2h2.95c.32 1.25.78 2.45 1.38 3.56A7.987 7.987 0 0 1 5.08 16zm2.95-8H5.08a7.987 7.987 0 0 1 4.33-3.56A15.65 15.65 0 0 0 8.03 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82c-.43 1.43-1.08 2.76-1.91 3.96zM14.34 14H9.66c-.09-.66-.16-1.32-.16-2s.07-1.35.16-2h4.68c.09.65.16 1.32.16 2s-.07 1.34-.16 2zm.25 5.56c.6-1.11 1.06-2.31 1.38-3.56h2.95a8.03 8.03 0 0 1-4.33 3.56zM16.36 14c.08-.66.14-1.32.14-2s-.06-1.34-.14-2h3.38c.16.64.26 1.31.26 2s-.1 1.36-.26 2h-3.38z',
};

export function MIcon({ name, size = 24, color, style }: { name: keyof typeof MI | string; size?: number; color?: string; style?: JSX.CSSProperties }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={color ?? 'currentColor'} aria-hidden="true" style={{ flex: 'none', ...style }}>
      <path d={MI[name] ?? MI.info} />
    </svg>
  );
}

/** ModernButton: round icon button with optional caption. */
export function ModernButton({ icon, svg, size = 36, iconSize, bg, color, label, caption, onClick, disabled, id }: { icon?: string; svg?: string; size?: number; iconSize?: number; bg?: string; color?: string; label?: string; caption?: string; onClick?: () => void; disabled?: boolean; id?: string }) {
  return (
    <button class="mbtn" onClick={onClick} disabled={disabled} aria-label={label ?? caption} id={id} type="button" style={{ opacity: disabled ? 0.5 : 1 }}>
      <span class="c" style={{ width: `${size}px`, height: `${size}px`, background: bg, color: color ?? 'var(--primary)' }}>
        {svg ? <Icon src={svg} size={iconSize ?? Math.round(size * 0.6)} /> : <MIcon name={icon ?? 'info'} size={iconSize ?? Math.round((size * 2) / 3)} />}
      </span>
      {caption && <span class="cap">{caption}</span>}
    </button>
  );
}

export function Button({ children, onClick, secondary, danger, warning, disabled, loading, small, id, style, type = 'button' }: { children: ComponentChildren; onClick?: () => unknown; secondary?: boolean; danger?: boolean; warning?: boolean; disabled?: boolean; loading?: boolean; small?: boolean; id?: string; style?: JSX.CSSProperties; type?: 'button' | 'submit' }) {
  const [busy, setBusy] = useState(false);
  const isLoading = loading || busy;
  return (
    <button
      id={id}
      type={type}
      class={`btn${secondary ? ' secondary' : ''}${danger ? ' danger' : ''}${warning ? ' warning' : ''}${small ? ' small' : ''}`}
      disabled={disabled || isLoading}
      style={style}
      onClick={async () => {
        if (!onClick) return;
        const r = onClick();
        if (r instanceof Promise) {
          setBusy(true);
          try {
            await r;
          } catch (e) {
            toast((e as Error).message);
          } finally {
            setBusy(false);
          }
        }
      }}
    >
      {isLoading ? <span class="spinner" /> : children}
    </button>
  );
}

/** ModalTopBar */
export function TopBar({ title, subtitle, bottomText, onBack, onClose, trailing, leading, titleLeading }: { title?: ComponentChildren; subtitle?: string; bottomText?: string; onBack?: () => void; onClose?: () => void; trailing?: ComponentChildren; leading?: ComponentChildren; titleLeading?: ComponentChildren }) {
  return (
    <div class="topbar">
      {leading ?? (onClose ? <ModernButton icon="close" size={36} color="var(--on-surface-variant)" label={t('close')} onClick={onClose} /> : onBack ? <ModernButton icon="back" size={36} iconSize={18} color="var(--on-surface-variant)" label={t('back')} onClick={onBack} /> : <span class="spacer" />)}
      <div class="t" style={bottomText ? { top: '20px', fontSize: '16px' } : undefined}>
        {titleLeading && <span style={{ marginRight: '12px', verticalAlign: 'middle', display: 'inline-flex' }}>{titleLeading}</span>}
        {title}
        {subtitle && <span class="sub">{subtitle}</span>}
        {bottomText && <small>{bottomText}</small>}
      </div>
      {trailing ?? <span class="spacer" />}
    </div>
  );
}

/** Page with Cake's gradient background and a ModalTopBar. */
export function Page({ title, subtitle, children, onBack, onClose, trailing, legacy, solid, bodyClass, footer, noBack, id }: { title?: ComponentChildren; subtitle?: string; children: ComponentChildren; onBack?: () => void; onClose?: () => void; trailing?: ComponentChildren; legacy?: boolean; solid?: boolean; bodyClass?: string; footer?: ComponentChildren; noBack?: boolean; id?: string }) {
  const back = noBack ? undefined : onBack ?? (nav.canPop() && !onClose ? () => nav.pop() : undefined);
  return (
    <div class={`page${legacy ? ' legacy' : ''}${solid ? ' solid' : ''}`} id={id}>
      {(title !== undefined || back || onClose || trailing) && <TopBar title={title} subtitle={subtitle} onBack={back} onClose={onClose} trailing={trailing} />}
      <div class={`page-body ${bodyClass ?? 'pad'}`}>{children}</div>
      {footer && <div class="bottom-actions">{footer}</div>}
    </div>
  );
}

export function Sections({ children }: { children: ComponentChildren }) {
  return <div class="sections">{children}</div>;
}

export function Section({ header, children }: { header?: string; children: ComponentChildren }) {
  return (
    <div>
      {header && <div class="section-header">{header}</div>}
      <div class="list">{children}</div>
    </div>
  );
}

export interface RowProps {
  label: ComponentChildren;
  secondary?: string;
  subtitle?: ComponentChildren;
  icon?: string;
  iconTint?: string | false;
  image?: string;
  trailing?: ComponentChildren;
  trailingText?: string;
  onClick?: () => void;
  arrow?: boolean;
  danger?: boolean;
  copy?: string;
  id?: string;
  disabled?: boolean;
}

/** ListItemRegularRow */
export function Row({ label, secondary, subtitle, icon, iconTint, image, trailing, trailingText, onClick, arrow, danger, copy, id, disabled }: RowProps) {
  const [flash, setFlash] = useState(false);
  const clickable = !!onClick || !!copy;
  const handle = () => {
    if (disabled) return;
    if (copy) {
      void copyText(copy);
      setFlash(true);
      setTimeout(() => setFlash(false), 1200);
    }
    onClick?.();
  };
  return (
    <button type="button" id={id} class={`row${clickable ? ' tap' : ''}${icon || image ? ' has-icon' : ''}${danger ? ' danger' : ''}${flash ? ' flash' : ''}`} onClick={clickable ? handle : undefined} style={{ opacity: disabled ? 0.5 : 1 }}>
      {icon && <Icon src={icon} size={24} color={iconTint === false ? undefined : iconTint ?? 'var(--primary)'} />}
      {image && <Img src={image} size={24} />}
      <span class="lbl">
        <span style={flash ? { color: 'var(--primary)' } : undefined}>
          {flash ? t('copied') : label}
          {secondary && <span class="sec"> {secondary}</span>}
        </span>
        {subtitle && <span class="sub wrap-any">{subtitle}</span>}
      </span>
      {trailingText && <span class="trail">{trailingText}</span>}
      {trailing}
      {(arrow ?? (!!onClick && !trailing)) && <Icon src="arrow_forward.svg" w={8} h={14} color="var(--on-surface-variant)" class="chev" />}
    </button>
  );
}

/** ListItemToggle */
export function ToggleRow({ label, subtitle, value, onChange, icon, id, disabled }: { label: ComponentChildren; subtitle?: ComponentChildren; value: boolean; onChange: (v: boolean) => void; icon?: string; id?: string; disabled?: boolean }) {
  return (
    <div class={`row tap${icon ? ' has-icon' : ''}`} onClick={() => !disabled && onChange(!value)} id={id} style={{ opacity: disabled ? 0.5 : 1 }}>
      {icon && <Icon src={icon} size={24} color="var(--primary)" />}
      <span class="lbl">
        <span>{label}</span>
        {subtitle && <span class="sub">{subtitle}</span>}
      </span>
      <Switch value={value} onChange={(v) => !disabled && onChange(v)} />
    </div>
  );
}

export function Switch({ value, onChange, id }: { value: boolean; onChange: (v: boolean) => void; id?: string }) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={value}
      class={`switch${value ? ' on' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!value);
      }}
    />
  );
}

export function Check({ on, onChange }: { on: boolean; onChange?: (v: boolean) => void }) {
  return (
    <span
      role="checkbox"
      aria-checked={on}
      class={`check${on ? ' on' : ''}`}
      onClick={(e) => {
        if (!onChange) return;
        e.stopPropagation();
        onChange(!on);
      }}
    >
      {on && <MIcon name="check" size={18} />}
    </span>
  );
}

/** ListItemCheckbox / NewPicker row */
export function CheckRow({ label, subtitle, on, onChange, icon, image }: { label: ComponentChildren; subtitle?: ComponentChildren; on: boolean; onChange: (v: boolean) => void; icon?: string; image?: string }) {
  return (
    <div class="row tap" onClick={() => onChange(!on)}>
      {icon && <Icon src={icon} size={26} color="var(--primary)" />}
      {image && <Img src={image} size={26} />}
      <span class="lbl">
        <span>{label}</span>
        {subtitle && <span class="sub">{subtitle}</span>}
      </span>
      <Check on={on} />
    </div>
  );
}

export function Segmented<T extends string | number>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div class="segmented" role="tablist">
      {options.map((o) => (
        <button type="button" role="tab" aria-selected={o.value === value} class={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export interface FieldProps {
  value: string;
  onInput: (v: string) => void;
  placeholder?: string;
  label?: string;
  error?: string | null;
  hint?: ComponentChildren;
  type?: string;
  multiline?: boolean;
  rows?: number;
  suffix?: ComponentChildren;
  prefix?: ComponentChildren;
  id?: string;
  autoFocus?: boolean;
  inputMode?: JSX.HTMLAttributes<HTMLInputElement>['inputMode'];
  maxLength?: number;
  readOnly?: boolean;
  mono?: boolean;
  onEnter?: () => void;
  autoComplete?: string;
}

export function Field({ value, onInput, placeholder, label, error, hint, type = 'text', multiline, rows = 3, suffix, prefix, id, autoFocus, inputMode, maxLength, readOnly, mono, onEnter, autoComplete = 'off' }: FieldProps) {
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, []);
  return (
    <div>
      {label && <div class="field-label">{label}</div>}
      <div class={`field${error ? ' error' : ''}`}>
        {prefix}
        {multiline ? (
          <textarea ref={ref} id={id} rows={rows} value={value} placeholder={placeholder} readOnly={readOnly} maxLength={maxLength} class={mono ? 'mono' : ''} spellcheck={false} autoComplete={autoComplete} onInput={(e) => onInput((e.target as HTMLTextAreaElement).value)} />
        ) : (
          <input ref={ref} id={id} type={type} value={value} placeholder={placeholder} readOnly={readOnly} maxLength={maxLength} inputMode={inputMode} class={mono ? 'mono' : ''} spellcheck={false} autoComplete={autoComplete} onInput={(e) => onInput((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === 'Enter' && onEnter?.()} />
        )}
        {suffix}
      </div>
      {error && <div class="field-error">{error}</div>}
      {!error && hint && <div class="field-hint">{hint}</div>}
    </div>
  );
}

export function Spinner({ large }: { large?: boolean }) {
  return <span class={`spinner${large ? ' lg' : ''}`} role="progressbar" />;
}

/** AddressFormatter.buildSegmentedAddress */
export function AddressText({ address, chunk = 4, truncate, style }: { address: string; chunk?: number; truncate?: boolean; style?: JSX.CSSProperties }) {
  if (!address) return null;
  if (address.includes('@')) return <span style={style}>{address}</span>;
  const a = address.replace(/^bitcoincash:/, '');
  const parts: string[] = [];
  for (let i = 0; i < a.length; i += chunk) parts.push(a.slice(i, i + chunk));
  const shown = truncate && parts.length > 3 ? [parts[0], parts[1], '...', parts[parts.length - 1]] : parts;
  return (
    <span class="address-seg wrap-any" style={style}>
      {shown.map((p) => (
        <span>{p}</span>
      ))}
    </span>
  );
}

export async function copyText(text: string, message?: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(message ?? t('copied_to_clipboard'));
}

export function CopyButton({ text, size = 20 }: { text: string; size?: number }) {
  return (
    <button type="button" class="ficon" aria-label={t('copy')} onClick={(e) => {
      e.stopPropagation();
      void copyText(text);
    }}>
      <Icon src="copy.svg" size={size} />
    </button>
  );
}
