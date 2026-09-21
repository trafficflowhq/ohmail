/**
 * The scroll content's insets every list screen pays — the side gutter and the clearance under
 * the flying nav plus the OS bottom inset — as ONE function, so `Scroller` and `MailList` cannot
 * read two rules. Dependency-free on purpose (`safe-area.ts`'s reason): a node test drives it at
 * real insets without a renderer; the hook over the live inset is `useListInsets` in `base.tsx`,
 * and `test/list-insets-shared.test.ts` refuses a list primitive that spells the padding itself.
 */
export interface ListInsets {
  paddingHorizontal: number;
  paddingBottom: number;
}

export interface ListSpace {
  /** The phone's deck gutter, `space.deckCompact`. */
  deckCompact: number;
  /** The clearance under the tab bar / dock so a panel's full shadow falloff is never clipped. */
  tabClearance: number;
}

export function listInsets(space: ListSpace, insetBottom: number): ListInsets {
  return { paddingHorizontal: space.deckCompact, paddingBottom: space.tabClearance + insetBottom };
}
