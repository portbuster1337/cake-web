// Localization with Cake Wallet's own strings (res/values/strings_XX.arb,
// imported to public/locales/XX.json). English is bundled; other languages
// are loaded on demand from this site. Placeholders use the .arb syntax:
// "Page ${current} of ${total}".

import { signal, computed } from '@preact/signals';
import en from './strings_en.json';

export type StringKey = keyof typeof en;

/** lib/entities/language_service.dart: supportedLocales (same order and names) */
export const SUPPORTED_LOCALES: Record<string, string> = {
  en: 'English',
  de: 'Deutsch (German)',
  es: 'Español (Spanish)',
  fa: 'فارسی (Persian)',
  fr: 'Français (French)',
  hi: 'हिंदी (Hindi)',
  ja: '日本 (Japanese)',
  ko: '한국어 (Korean)',
  nl: 'Nederlands (Dutch)',
  pl: 'Polski (Polish)',
  pt: 'Português (Portuguese)',
  pt_BR: 'Português Brasileiro (Brazilian Portuguese)',
  ru: 'Русский (Russian)',
  uk: 'Українська (Ukrainian)',
  zh: '简体中文 (Chinese Simplified)',
  hr: 'Hrvatski (Croatian)',
  it: 'Italiano (Italian)',
  th: 'ภาษาไทย (Thai)',
  ar: 'العربية (Arabic)',
  tr: 'Türkçe (Turkish)',
  my: 'မြန်မာ (Burmese)',
  bg: 'Български (Bulgarian)',
  cs: 'čeština (Czech)',
  ur: 'اردو (Urdu)',
  id: 'Bahasa Indonesia (Indonesian)',
  yo: 'Yorùbá (Yoruba)',
  ha: 'Hausa Najeriya (Nigeria)',
  tl: 'Filipino (Tagalog)',
  hy: 'Հայերեն (Armenian)',
  vi: 'Tiếng Việt (Vietnamese)',
};

/** language -> flag (assets/images/flags/<code>.png) */
export const LOCALE_COUNTRY: Record<string, string> = {
  en: 'usa', de: 'deu', es: 'esp', fa: 'irn', fr: 'fra', gn: 'grn', hi: 'ind', ja: 'jpn', ko: 'kor', nl: 'nld', pl: 'pol', pt: 'prt',
  pt_BR: 'bra', ru: 'rus', uk: 'ukr', zh: 'chn', hr: 'hrv', it: 'ita', th: 'tha', ar: 'sau', tr: 'tur', my: 'mmr', bg: 'bgr', cs: 'czk',
  ur: 'pak', id: 'idn', yo: 'nga', ha: 'hau', tl: 'phl', hy: 'arm', vi: 'vnm',
};

const RTL = new Set(['ar', 'fa', 'ur']);

export const language = signal<string>('en');
const tables = signal<Record<string, Record<string, string>>>({ en });

export const isRtl = computed(() => RTL.has(language.value));

export async function setLanguage(code: string): Promise<void> {
  if (!SUPPORTED_LOCALES[code] && code !== 'en') code = 'en';
  if (!tables.value[code]) {
    try {
      const res = await fetch(`./locales/${code}.json`, { credentials: 'same-origin' });
      if (res.ok) tables.value = { ...tables.value, [code]: await res.json() };
    } catch { /* fall back to English */ }
  }
  language.value = code;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = code.replace('_', '-');
    document.documentElement.dir = RTL.has(code) ? 'rtl' : 'ltr';
  }
}

/** The best supported language for the browser's preferences (Cake picks the device locale the same way). */
export function detectLanguage(): string {
  const prefs = typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : [];
  for (const p of prefs) {
    const [l, r] = p.split('-');
    if (r && SUPPORTED_LOCALES[`${l}_${r.toUpperCase()}`]) return `${l}_${r.toUpperCase()}`;
    if (SUPPORTED_LOCALES[l]) return l;
  }
  return 'en';
}

export function fill(s: string, args?: Record<string, string | number>): string {
  if (!args) return s;
  return s.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => {
    const k = a ?? b;
    return k in args ? String(args[k]) : m;
  });
}

/** S.of(context).key — reads the current language (reactive inside components). */
export function t(key: StringKey | string, args?: Record<string, string | number>): string {
  const table = tables.value[language.value];
  const s = table?.[key] ?? (en as Record<string, string>)[key] ?? key;
  return fill(s, args);
}

export function hasString(key: string): boolean {
  return key in en;
}
