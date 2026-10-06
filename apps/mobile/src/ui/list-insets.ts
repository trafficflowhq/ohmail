/**
 * The scroll content's insets every list screen pays — the side gutter and the clearance under
 * the flying nav plus the OS bottom inset — as ONE function, so `Scroller` and `MailList` cannot
 * read two rules. Dependency-free on purpose (`safe-area.ts`'s reason): a node test drives it at
 * real insets without a renderer; the hook over the live inset is `useListInsets` in `base.tsx`,
 * and `test/list-insets-shared.test.ts` refuses a list primitive that spells the padding itself.
 */
export interface ListInsets {
  paddingLeft: number;
  paddingRight: number;
  paddingBottom: number;
}

/**
 * What the flying nav leaves for the list — `scaffold/plan.ts`'s `listNavClearance`, passed in
 * rather than read here so this stays dependency-free and a node test can drive every posture.
 * A rail takes a SIDE, so the gutter is not the same on both edges and a single
 * `paddingHorizontal` cannot say it; a dock takes the foot.
 */
export interface ListNav {
  bottom: number;
  left: number;
  right: number;
}

export interface ListSpace {
  /** The phone's deck gutter, `space.deckCompact`. */
  deckCompact: number;
  /** The clearance under the tab bar / dock so a panel's full shadow falloff is never clipped. */
  tabClearance: number;
}

/**
 * The gap a list keeps above a floating bar at scroll end — the dock, the reader's verb bar. The
 * bars are glass over the content and carry no scrim, so the last row or paragraph must REST clear
 * of them: the bar's height plus 16 dp (it was the toast's 12, and the last line sat on the bar).
 */
export const CHROME_GAP = 16;

/**
 * The gutters are the deck's alone: a one-pane rail's side is paid by `Screen` for every screen at
 * once, and the two-pane surfaces pay their own. The foot clears the nav's own clearance plus the
 * inset, or the tallest chrome standing there (`useBottomChromeExtent`: the reader's bar, the dock)
 * plus the gap — whichever reaches higher, so the last line of a message stops above the bar.
 */
export function listInsets(space: ListSpace, insetBottom: number, nav: ListNav, chromeExtent = 0): ListInsets {
  return {
    paddingLeft: space.deckCompact,
    paddingRight: space.deckCompact,
    paddingBottom: Math.max(nav.bottom + insetBottom, chromeExtent > 0 ? chromeExtent + CHROME_GAP : 0),
  };
}
