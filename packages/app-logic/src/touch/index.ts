/** The door of `touch`: a finger's arithmetic, pure. The phone's swipe as it shipped, and what tracks it. */
export {
  SWIPE_CLAIM_DX,
  SWIPE_CLAIM_RATIO,
  SWIPE_FIRE_DX,
  SWIPE_MAX_DX,
  swipeClaims,
  swipeOffset,
  swipeVerbFor,
  type SwipeVerb,
} from "./row-swipe.js";
export {
  swipeDrawn,
  swipeEnd,
  swipeMove,
  swipeStart,
  type SwipeSides,
  type SwipeTrack,
} from "./row-swipe-track.js";
export {
  PULL_FIRE,
  PULL_HOLD,
  PULL_HOLD_CAP_MS,
  PULL_MAX,
  PULL_RATE,
  PULL_SLOP,
  pullClaims,
  pullEnd,
  pullFires,
  pullMove,
  pullOffset,
  pullStart,
  type PullTrack,
} from "./pull-down.js";
export {
  BOOK_SIDE_MIN,
  FOLD_KEEP,
  FOLD_LIST_MIN,
  foldLineOf,
  type FoldLine,
  type FoldShape,
} from "./fold.js";
