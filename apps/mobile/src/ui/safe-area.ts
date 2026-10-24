/**
 * The top padding of a strip that draws under the status bar — the OS inset plus the design's
 * own gap, never the gap alone. `Screen` is a plain view and `Scroller` pays only the bottom
 * inset, so a strip at the top of a route owes its own top inset; a fixed `paddingTop: 28` once
 * put the wordmark on an iPhone's clock at every launch. One function, so a route cannot express
 * the wrong arithmetic; the hook over the live inset is `useTopPad` in `base.tsx`, and
 * `test/safe-area-census.test.ts` refuses a route that spells the padding itself.
 * Dependency-free on purpose — a module importing react-native is one a node test cannot load.
 */
export function topPad(insetTop: number, gap: number): number {
  return insetTop + gap;
}

/**
 * The side margins of a card drawn above the screens (`Gated`'s account notices), outside the
 * `Screen` that pays the side insets and the rail: past each side inset and the rail's column on its
 * side (`listNavClearance`), and never closer to the edge than the card's own gutter.
 */
export function cardSides(
  inset: { left: number; right: number }, rail: { left: number; right: number }, gap: number,
): { marginLeft: number; marginRight: number } {
  return { marginLeft: inset.left + Math.max(gap, rail.left), marginRight: inset.right + Math.max(gap, rail.right) };
}
