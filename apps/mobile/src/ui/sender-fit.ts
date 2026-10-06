/**
 * The sender page's two size rules, as data so the suite drives them without a renderer.
 *
 * THE DECISION PANEL AT COMPACT HEIGHT (under 480 dp: a foldable's cover or a phone held sideways):
 * one row of destination capsules that scrolls sideways, the sender / whole-domain control at its
 * end, and no explainer sentence (the capsules carry it as their hint). At 905 x 403 dp the wrapped
 * panel stood ~230 dp tall and left the held message a 173 dp strip.
 *
 * THE SENDER'S NAME: the reader's title role (29) at a pane of 480 dp or more, the view title (22)
 * below, three lines at most; the type scale holds no 28. React Native has no hyphenation, so a
 * single word longer than the pane still breaks.
 */
import type { SizeClass } from "./posture/derive";

export interface DecisionPanelShape {
  /** `scroll`: one sideways row; `wrap`: the capsules wrap onto as many rows as they need. */
  row: "scroll" | "wrap";
  /** The scope control ends the capsules' row instead of standing on its own. */
  scopeInRow: boolean;
  /** The "files every message from …" sentence under the controls. */
  explainer: boolean;
}

export function decisionPanelShape(heightClass: SizeClass): DecisionPanelShape {
  return heightClass === "compact"
    ? { row: "scroll", scopeInRow: true, explainer: false }
    : { row: "wrap", scopeInRow: false, explainer: true };
}

export const SENDER_TITLE_WIDE_PANE = 480;

/** The name's type role at a measured pane width; an unmeasured pane (null) takes the narrow one. */
export function senderTitleVariant(paneWidth: number | null): "readerTitle" | "h1" {
  return paneWidth !== null && paneWidth >= SENDER_TITLE_WIDE_PANE ? "readerTitle" : "h1";
}

export const SENDER_TITLE_LINES = 3;
