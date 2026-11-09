/**
 * The sender page's two size rules, as data the suite drives without a renderer. AT COMPACT HEIGHT
 * (under 480 dp), and on a window under 740 dp tall (the iPhone SE), the decision panel is one sideways row of capsules, the scope control at its end
 * (a whole-domain scope only when the whole row fits, else on a second row, never scrolled off), a
 * shorter top padding, and no explainer (the
 * capsules carry it as their hint): wrapped, it stood ~230 dp tall on the cover held sideways. THE NAME takes the reader's title role (29) on a pane of 480 dp or more, the
 * view title (22) below, three lines at most; the type scale holds no 28, and React Native has no
 * hyphenation, so one word longer than the pane still breaks.
 */
import type { SizeClass } from "./posture/derive";

export interface DecisionPanelShape {
  /** `scroll`: one sideways row; `wrap`: the capsules wrap onto as many rows as they need. */
  row: "scroll" | "wrap";
  /** The scope control ends the capsules' row instead of standing on its own. */
  scopeInRow: boolean;
  /** The "files every message from …" sentence under the controls. */
  explainer: boolean;
  /** The panel's top padding, dp. */
  padTop: number;
}

/** Under this window height the wrapped panel stood ~55 % of the iPhone SE (667): it takes the row too. */
export const DECISION_PANEL_ROW_BELOW = 740;

export function decisionPanelShape(heightClass: SizeClass, windowHeight: number): DecisionPanelShape {
  return heightClass === "compact" || windowHeight < DECISION_PANEL_ROW_BELOW
    ? { row: "scroll", scopeInRow: true, explainer: false, padTop: 8 }
    : { row: "wrap", scopeInRow: false, explainer: true, padTop: 14 };
}

/** The capsule row's side padding and gap, dp — what `scopeFitsRow` adds up. */
export const DECISION_ROW_PAD = 14;
export const DECISION_ROW_GAP = 8;

/**
 * Whether the scope control can end the capsules' row: the row holds the capsules, a gap and the
 * control with nothing scrolled. Unmeasured (any 0) answers false, so the control starts on its
 * own row and can never stand off screen while a person's earlier "whole domain" is in force.
 */
export function scopeFitsRow(rowWidth: number, capsulesWidth: number, scopeWidth: number): boolean {
  if (!(rowWidth > 0) || !(capsulesWidth > 0) || !(scopeWidth > 0)) return false;
  return 2 * DECISION_ROW_PAD + capsulesWidth + DECISION_ROW_GAP + scopeWidth <= rowWidth;
}

/**
 * Where the scrolling row opens: 0, or far enough that the suggested capsule (at `capsuleX` in the
 * capsules' strip, which starts after the row's padding) stands whole with the padding to its right,
 * never past its own left edge. Unmeasured answers 0.
 */
export function suggestedRowOffset(rowWidth: number, capsuleX: number, capsuleWidth: number): number {
  if (!(rowWidth > 0) || !(capsuleWidth > 0)) return 0;
  const left = DECISION_ROW_PAD + capsuleX;
  const past = left + capsuleWidth + DECISION_ROW_PAD - rowWidth;
  return past > 0 ? Math.max(0, Math.min(past, left - DECISION_ROW_PAD)) : 0;
}

/**
 * Whether the scope control ends the scrolling row. The sender-only scope does whatever the row's
 * width: off screen it changes nothing a press files. A whole-domain scope in force keeps the fit
 * gate, so what widens a press is never scrolled off.
 */
export function scopeEndsRow(
  shape: DecisionPanelShape,
  scope: "sender" | "domain",
  rowWidth: number,
  capsulesWidth: number,
  scopeWidth: number,
): boolean {
  return shape.scopeInRow && (scope === "sender" || scopeFitsRow(rowWidth, capsulesWidth, scopeWidth));
}

export const SENDER_TITLE_WIDE_PANE = 480;

/** The name's type role at a measured pane width; an unmeasured pane (null) takes the narrow one. */
export function senderTitleVariant(paneWidth: number | null): "readerTitle" | "h1" {
  return paneWidth !== null && paneWidth >= SENDER_TITLE_WIDE_PANE ? "readerTitle" : "h1";
}

export const SENDER_TITLE_LINES = 3;
