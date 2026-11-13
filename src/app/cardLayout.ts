// The order and visibility of a wallet's account cards (cw_core/lib/balance_card_layout.dart,
// BalanceCardStyleSettings.cardOrder / hidden): visible cards by their stored
// position (the front card last), new accounts after them by index; archived
// cards apart, by index.

export interface StoredCardLayout {
  /** the visible accounts, back to front */
  order?: number[];
  /** archived accounts */
  hidden?: number[];
}

export interface CardLayout {
  visible: number[];
  hidden: number[];
}

/** BalanceCardLayout.resolve */
export function resolveCardLayout(accountIndices: number[], stored: StoredCardLayout | undefined): CardLayout {
  const accounts = [...new Set(accountIndices)];
  const hiddenSet = new Set(stored?.hidden ?? []);
  const hidden = accounts.filter((a) => hiddenSet.has(a)).sort((a, b) => a - b);
  const pos = new Map((stored?.order ?? []).map((a, i) => [a, i]));
  const visible = accounts
    .filter((a) => !hiddenSet.has(a))
    .sort((a, b) => {
      const pa = pos.get(a);
      const pb = pos.get(b);
      if (pa !== pb) {
        if (pa === undefined) return 1;
        if (pb === undefined) return -1;
        return pa - pb;
      }
      return a - b;
    });
  return { visible, hidden };
}

/** a card moved from one place of the deck to another (ReorderableListView's onReorder) */
export function moveCard(order: number[], from: number, to: number): number[] {
  const out = [...order];
  const [card] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, card);
  return out;
}

/** BalanceCardLayout.unhiding: back among the visible cards, in front */
export function unhideCard(layout: CardLayout, account: number): CardLayout {
  if (!layout.hidden.includes(account)) return layout;
  return { visible: [...layout.visible, account], hidden: layout.hidden.filter((a) => a !== account) };
}

/** AccountHidden */
export function hideCard(layout: CardLayout, account: number): CardLayout {
  if (layout.hidden.includes(account)) return layout;
  return { visible: layout.visible.filter((a) => a !== account), hidden: [...layout.hidden, account].sort((a, b) => a - b) };
}
