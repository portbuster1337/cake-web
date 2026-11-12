// Cake Wallet themes (lib/themes/**): Light, Dark and Black (6 accents, each
// also in OLED mode). Colors are Material 3 ColorScheme roles plus Cake's
// custom colors, exposed to CSS as variables (--primary, --surface, …).

import { signal } from '@preact/signals';

export interface Palette {
  primary: string; onPrimary: string; primaryContainer: string; onPrimaryContainer: string;
  secondary: string; onSecondary: string; secondaryContainer: string; onSecondaryContainer: string;
  tertiary: string; onTertiary: string; tertiaryContainer: string; onTertiaryContainer: string;
  error: string; onError: string; errorContainer: string; onErrorContainer: string;
  surface: string; surfaceDim: string; onSurface: string; onSurfaceVariant: string;
  surfaceContainerLowest: string; surfaceContainerLow: string; surfaceContainer: string; surfaceContainerHigh: string; surfaceContainerHighest: string;
  outline: string; outlineVariant: string; onInverseSurface: string;
  warningContainer: string; warningOutline: string; backgroundGradient: string; cardGradientPrimary: string; cardGradientSecondary: string;
  toggleKnob: string; toggleOff: string;
  isDark: boolean;
}

const DARK: Palette = {
  primary: '#91B0FF', onPrimary: '#002860', primaryContainer: '#004C9E', onPrimaryContainer: '#FFF3F0',
  secondary: '#A1B9FF', onSecondary: '#0C1C58', secondaryContainer: '#1A3C6C', onSecondaryContainer: '#BACBFF',
  tertiary: '#162028', onTertiary: '#2B373F', tertiaryContainer: '#1F2832', onTertiaryContainer: '#A8B3C6',
  error: '#FFB4AB', onError: '#B71919', errorContainer: '#C53636', onErrorContainer: '#FFDAD6',
  surface: '#1B284A', surfaceDim: '#0F1A36', onSurface: '#D7E2F7', onSurfaceVariant: '#8C9FBB',
  surfaceContainerLowest: '#171C30', surfaceContainerLow: '#2D385C', surfaceContainer: '#24335B', surfaceContainerHigh: '#2A3E73', surfaceContainerHighest: '#334C8C',
  outline: '#9EACC1', outlineVariant: '#2A3E73', onInverseSurface: '#1B284A',
  warningContainer: '#8E5800', warningOutline: '#FFB84E', backgroundGradient: '#0F1A36', cardGradientPrimary: '#2B3A67', cardGradientSecondary: '#1C2A4F',
  toggleKnob: '#FFFFFF', toggleOff: '#3A4F88',
  isDark: true,
};

const LIGHT: Palette = {
  primary: '#2D9EFA', onPrimary: '#FFFFFF', primaryContainer: '#403747', onPrimaryContainer: '#D5C8DC',
  secondary: '#625C64', onSecondary: '#FFFFFF', secondaryContainer: '#E1E4EA', onSecondaryContainer: '#4C474E',
  tertiary: '#BFCBDE', onTertiary: '#FFFFFF', tertiaryContainer: '#35404A', onTertiaryContainer: '#C5D7E5',
  error: '#F9434C', onError: '#FFFFFF', errorContainer: 'rgba(249,67,76,0.18)', onErrorContainer: '#E43D3D',
  surface: '#EDEDFA', surfaceDim: '#E7E7FD', onSurface: '#28222E', onSurfaceVariant: '#857D8D',
  surfaceContainerLowest: '#D5D5EB', surfaceContainerLow: '#D5D5EB', surfaceContainer: '#FFFFFF', surfaceContainerHigh: '#F2F2FC', surfaceContainerHighest: '#DADAED',
  outline: '#7B757C', outlineVariant: '#EDEDF6', onInverseSurface: '#FAFAFA',
  warningContainer: '#FFCC00', warningOutline: '#312938', backgroundGradient: '#EDEDFA', cardGradientPrimary: '#FFFFFF', cardGradientSecondary: '#F3F3FF',
  toggleKnob: '#FFFFFF', toggleOff: '#CACAE7',
  isDark: false,
};

export const BLACK_ACCENTS: Record<string, { name: string; color: string }> = {
  cakePrimary: { name: 'Cake Primary', color: '#52B6F0' },
  bchGreen: { name: 'BCH Green', color: '#44BA52' },
  bitcoinYellow: { name: 'Bitcoin Yellow', color: '#FFC107' },
  moneroOrange: { name: 'Monero Orange', color: '#FF6600' },
  tronRed: { name: 'Tron Red', color: '#FF4242' },
  frostingPurple: { name: 'Frosting Purple', color: '#BABAF3' },
};

function black(accent: string, oled: boolean): Palette {
  return {
    primary: accent, onPrimary: '#352D3C', primaryContainer: '#28212F', onPrimaryContainer: '#B7ABBE',
    secondary: '#CCC4CD', onSecondary: '#332F36', secondaryContainer: '#454148', onSecondaryContainer: '#DFD6DF',
    tertiary: '#DEBFC5', onTertiary: '#3F2B30', tertiaryContainer: '#321F24', onTertiaryContainer: '#C6A8AE',
    error: '#FFB4AB', onError: '#B71919', errorContainer: '#C53636', onErrorContainer: '#FFDAD6',
    surface: oled ? '#000000' : '#131314', surfaceDim: '#000000', onSurface: '#E6E1E3', onSurfaceVariant: '#B4B4B4',
    surfaceContainerLowest: oled ? '#000000' : '#0F0E0F', surfaceContainerLow: '#1C1B1C', surfaceContainer: '#211F20', surfaceContainerHigh: '#2B292B', surfaceContainerHighest: '#363435',
    outline: '#958F95', outlineVariant: '#2F2D2F', onInverseSurface: oled ? '#000000' : '#131314',
    warningContainer: '#8E5800', warningOutline: '#FFB84E', backgroundGradient: '#000000', cardGradientPrimary: '#202023', cardGradientSecondary: '#181819',
    toggleKnob: '#FFFFFF', toggleOff: '#2B292B',
    isDark: true,
  };
}

/** lib/themes/utils/theme_list.dart: raw ids */
export interface ThemeDef {
  raw: number;
  id: string;
  title: string;
  palette: Palette;
}

export const THEMES: ThemeDef[] = [
  { raw: 0, id: 'light', title: 'Light Theme', palette: LIGHT },
  { raw: 1, id: 'dark', title: 'Dark Theme', palette: DARK },
  ...Object.entries(BLACK_ACCENTS).flatMap(([key, a], i) => [
    { raw: 12 + i, id: `black-${key}`, title: `Black Theme (${a.name})`, palette: black(a.color, false) },
    { raw: 112 + i, id: `black-${key}-oled`, title: `Black Theme (${a.name}) OLED`, palette: black(a.color, true) },
  ]),
];

export type ThemeMode = 'system' | 'light' | 'dark';

export const themeRaw = signal<number | null>(null);

function cssName(k: string): string {
  return `--${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
}

export function resolveTheme(raw: number | null): ThemeDef {
  if (raw === null || raw === undefined) {
    const light = typeof matchMedia !== 'undefined' && matchMedia('(prefers-color-scheme: light)').matches;
    return THEMES[light ? 0 : 1];
  }
  return THEMES.find((t) => t.raw === raw) ?? THEMES.find((t) => t.raw === 12)!;
}

export function applyTheme(raw: number | null): ThemeDef {
  const th = resolveTheme(raw);
  themeRaw.value = raw;
  if (typeof document === 'undefined') return th;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(th.palette)) if (typeof v === 'string') root.style.setProperty(cssName(k), v);
  root.dataset.theme = th.palette.isDark ? 'dark' : 'light';
  root.style.colorScheme = th.palette.isDark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', th.palette.surface);
  try {
    if (raw === null) localStorage.removeItem('cw-theme');
    else localStorage.setItem('cw-theme', String(raw));
  } catch { /* storage disabled */ }
  return th;
}

export function currentPalette(): Palette {
  return resolveTheme(themeRaw.value).palette;
}
