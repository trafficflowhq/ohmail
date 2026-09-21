/**
 * THE VERBS A MAIL ROW PUBLISHES TO A SCREEN READER — the list and the dispatch, pure and free of
 * React so the tests drive them as data (`row-swipe.ts`'s shape; the wiring in `MailRow.tsx` is
 * thin). A swipe is a gesture and a gesture is invisible to VoiceOver and TalkBack, so the row
 * publishes its verbs as actions on itself: the rotor and the actions menu reach them directly.
 * Every one dispatches through the world's own verb, which is what carries the sentence and its
 * Undo — nothing here schedules, holds or reverses anything.
 */
import { Copy } from "../copy";
import { moveTargetLabel } from "../state/live";
import type { ReadFace, SwipeVerb } from "./row-swipe";

/** The row's verbs: the swipe's two, and Junk, which has no gesture on any side. */
export type RowActionVerb = SwipeVerb | "junk";

export interface RowActionFacts {
  /** The read slot's face — `readFaceOf`, the one rule the reader's bar uses. */
  face: ReadFace;
  /** Whether this row admits the spam target (`moveTargetsFor`), the reader's own rule. */
  junkOffered: boolean;
}

export interface RowAction {
  /** The name React Native hands back in `onAccessibilityAction`. */
  name: string;
  label: string;
  verb: RowActionVerb;
}

/** The read slot's word, from its face — the sheet's own three labels, not a fourth spelling. */
export function faceLabel(face: ReadFace): string {
  return face === "done"
    ? Copy.actionDone
    : face === "markRead"
      ? Copy.actionMarkRead
      : Copy.actionMarkUnread;
}

/**
 * The actions the row publishes, in the order a rotor reads them: the read slot, Later, Junk.
 * Junk is ABSENT where the row cannot take it — a message already presented in Spam — for the
 * same reason the reader's rail leaves it out there: an advertised action that does nothing is
 * worse than no action at all.
 */
export function rowActions(f: RowActionFacts): RowAction[] {
  const actions: RowAction[] = [
    { name: "readSlot", label: faceLabel(f.face), verb: "read" },
    { name: "later", label: Copy.actionLater, verb: "later" },
  ];
  if (f.junkOffered) actions.push({ name: "junk", label: moveTargetLabel("spam"), verb: "junk" });
  return actions;
}

/**
 * Which verb an action name presses, or `null` for a name this row never published — derived
 * from the same list, so a name the row did not offer cannot dispatch through a stale menu.
 */
export function rowActionVerb(name: string, f: RowActionFacts): RowActionVerb | null {
  return rowActions(f).find((a) => a.name === name)?.verb ?? null;
}
