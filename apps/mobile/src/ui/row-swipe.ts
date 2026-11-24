/**
 * SWIPE ON A MAIL ROW: the arithmetic is the shared one (`@ohmail/app-logic/touch/row-swipe`), taken here as
 * `body-pages.ts` takes the long-text bound. What stays is the read slot's face, the old screens' own rule.
 */
export {
  SWIPE_CLAIM_DX,
  SWIPE_CLAIM_RATIO,
  SWIPE_FIRE_DX,
  SWIPE_MAX_DX,
  swipeClaims,
  swipeOffset,
  swipeVerbFor,
  type SwipeVerb,
} from "@ohmail/app-logic/touch/row-swipe";

/**
 * Which face the read slot is wearing for this row — the reader's own three-way rule
 * (`MessageActions.tsx`'s `readFace`), restated NOWHERE ELSE: both callers take it from here, so
 * the swipe cannot press a verb whose label the sheet is not showing.
 */
export type ReadFace = "done" | "markRead" | "markUnread";

export function readFaceOf(row: { pile: string | null; unread: boolean }): ReadFace {
  if (row.pile === "resurfaced") return "done";
  return row.unread ? "markRead" : "markUnread";
}
