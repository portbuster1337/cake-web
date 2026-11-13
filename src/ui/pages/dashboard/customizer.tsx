// Card customizer (lib/new-ui/pages/card_customizer.dart, viewmodels/card_customizer/*):
// card style (gradient only / icon / the coin's own design), icon style, color.

import { useState } from 'preact/hooks';
import { t } from '../../../core/i18n.ts';
import { Field, Img, TopBar } from '../../components/core.tsx';
import { registerRoute, Routes } from '../../routes.ts';
import { nav } from '../../nav.ts';
import { currentWallet } from '../../../app/app.ts';
import { settings, updateSettings } from '../../../app/settings.ts';
import { currentPalette } from '../../theme/themes.ts';
import { availableGradients, BalanceCard, CardArtwork, cardStyleKey, designFromStyle, GRADIENT_ONLY_DESIGN, iconDesign, iconPaths, isCardStyle, preferredCombo, specialDesign, withGradient, withGradientAndCombo, withIcon, type CardDesign } from './cards.tsx';

function MiniCard({ design }: { design: CardDesign }) {
  return (
    <span style={{ position: 'relative', display: 'block', width: '96px', height: `${96 * 0.62}px`, borderRadius: '10px', overflow: 'hidden', border: '1px solid rgba(255,255,255,.27)', background: `linear-gradient(to bottom, ${design.from}, ${design.to})` }}>
      <CardArtwork design={design} />
    </span>
  );
}

function CardCustomizerPage({ args }: { args?: { account?: number } }) {
  const w = currentWallet.value;
  const s = settings.value;
  const cur = w?.currency.key ?? '';
  const account = args?.account;
  const isAccount = account !== undefined;
  const key = w ? (isAccount ? `${w.id}:${account}` : cardStyleKey(w)) : '';
  const [name, setName] = useState(() => (isAccount ? w?.accounts.value.find((a) => a.index === account)?.label ?? '' : ''));
  const stored = s.cardDesigns[key];
  const current = designFromStyle(stored, cur);
  const special = specialDesign(cur);
  const designs: CardDesign[] = [GRADIENT_ONLY_DESIGN, iconDesign(cur), ...(special ? [special] : [])];
  const colors = availableGradients(cur);
  const icons = iconPaths(cur);
  const [designIdx, setDesignIdx] = useState(() => Math.min(designs.length - 1, current.type === 'gradientOnly' ? 0 : current.type === 'svgIcon' ? 1 : 2));
  const [colorIdx, setColorIdx] = useState(() => Math.max(0, colors.findIndex((g) => g.from.toLowerCase() === current.from.toLowerCase() && g.to.toLowerCase() === current.to.toLowerCase())));
  const [iconIdx, setIconIdx] = useState(() => (isCardStyle(stored) && stored.iconStyleIndex < icons.length ? stored.iconStyleIndex : 0));
  if (!w) return null;
  const dark = currentPalette().isDark;
  const acc = isAccount ? w.accounts.value.find((a) => a.index === account) : undefined;
  const close = async () => {
    const label = name.trim();
    if (isAccount && acc && label !== acc.label) await (w as { renameAccount?: (i: number, l: string) => Promise<void> }).renameAccount?.(account!, label).catch(() => {});
    nav.pop();
  };
  /** CardCustomizerState.selectedDesign */
  const designAt = (i: number, color = colorIdx, icon = iconIdx): CardDesign => {
    const g = colors[color] ?? colors[0];
    const base = designs[i];
    let d = preferredCombo(g) ? withGradient(base, g) : withGradientAndCombo(base, g, (designs.length > 2 ? designs[designs.length - 1] : base).combo);
    if (d.type === 'svgIcon' && icons.length) d = withIcon(d, icons[icon]);
    return d;
  };
  const save = (design: number, color: number, icon: number) => {
    updateSettings((x) => ({ cardDesigns: { ...x.cardDesigns, [key]: { gradientIndex: color, useSpecialDesign: designs[design].type === 'svgFull', iconStyleIndex: icon, isGradientOnly: designs[design].type === 'gradientOnly' } } }));
  };
  const pickDesign = (i: number) => {
    setDesignIdx(i);
    save(i, colorIdx, iconIdx);
  };
  const pickColor = (i: number) => {
    setColorIdx(i);
    save(designIdx, i, iconIdx);
  };
  const pickIcon = (i: number) => {
    setIconIdx(i);
    save(designIdx, colorIdx, i);
  };
  const selected = designAt(designIdx);
  const showIcons = selected.type === 'svgIcon' && icons.length > 0;
  return (
    <div class="page solid" id="card_customizer_page">
      <TopBar title={isAccount ? t('edit_account') : t('edit_card')} subtitle={isAccount ? `#${account! + 1}` : undefined} onClose={isAccount ? undefined : () => void close()} onBack={isAccount ? () => void close() : undefined} />
      <div class="page-body" style={{ padding: '0 0 32px' }}>
        <div class="col" style={{ gap: '25px' }}>
          <div class="col" style={{ alignItems: 'center', padding: '0 6.5%' }}>
            <BalanceCard design={selected} label={isAccount ? `${account! + 1}. ${name.trim() || t('unnamed_account')}` : ''} amount={isAccount ? '' : '0.00'} asset={isAccount ? '' : w.currency.title.toUpperCase()} fiat={s.fiatApiMode === 'disabled' ? undefined : ''} width={768} />
          </div>
          {isAccount && (
            <div class="col" style={{ padding: '0 18px', gap: '8px' }}>
              <div>{t('account_name')}</div>
              <Field value={name} onInput={setName} maxLength={32} id="account_name_field" />
            </div>
          )}
          <div style={{ padding: '0 18px' }}>
            <div style={{ background: 'var(--surface-container)', borderRadius: '16px', overflow: 'hidden' }}>
              <div style={{ padding: '12px' }}>
                <div>{t('card_style')}</div>
                <div class="rowx" style={{ gap: '8px', marginTop: '8px', height: '63px', overflowX: 'auto' }}>
                  {designs.map((_, i) => (
                    <button type="button" id={`card_style_${i}`} aria-pressed={i === designIdx} onClick={() => pickDesign(i)} style={{ padding: 0, border: i === designIdx ? '1px solid var(--on-surface)' : '1px solid transparent', borderRadius: '12px', background: 'none', cursor: 'pointer', flex: 'none' }}>
                      <span style={{ display: 'block', transform: i === designIdx ? 'scale(0.94)' : undefined, transition: 'transform 200ms' }}><MiniCard design={designAt(i)} /></span>
                    </button>
                  ))}
                </div>
              </div>
              {showIcons && (
                <div style={{ padding: '0 12px' }}>
                  <div>{t('icon_style')}</div>
                  <div class="rowx" style={{ gap: '8px', marginTop: '8px', height: '48px', overflowX: 'auto' }}>
                    {icons.map((ic, i) => (
                      <button type="button" id={`icon_style_${i}`} aria-pressed={i === iconIdx} onClick={() => pickIcon(i)} style={{ width: '48px', height: '48px', flex: 'none', borderRadius: '18px', padding: '10px', cursor: 'pointer', background: dark ? 'var(--surface-container-high)' : 'color-mix(in srgb, var(--on-surface-variant) 25%, transparent)', border: i === iconIdx ? '2px solid var(--on-surface)' : '2px solid transparent', boxSizing: 'border-box' }}>
                        <Img src={ic.path} size={24} style={{ width: '100%', height: '100%' }} />
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ margin: '8px 12px 12px', background: 'var(--surface-container-high)', borderRadius: '16px', padding: '12px' }}>
                <div>{t('color')}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 4px', marginTop: '8px' }}>
                  {colors.map((g, i) => (
                    <button type="button" id={`card_color_${i}`} aria-pressed={i === colorIdx} onClick={() => pickColor(i)} style={{ width: '32px', height: '32px', borderRadius: '50%', padding: 0, cursor: 'pointer', background: 'none', border: i === colorIdx ? '1px solid var(--on-surface)' : '1px solid transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <span style={{ display: 'block', width: '100%', height: '100%', borderRadius: '50%', background: `linear-gradient(to bottom, ${g.from}, ${g.to})`, transform: i === colorIdx ? 'scale(0.8)' : undefined, transition: 'transform 200ms' }} />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

registerRoute(Routes.cardCustomizer, CardCustomizerPage);
