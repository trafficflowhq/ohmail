/**
 * HOW THE COMPOSER FITS A SHORT WINDOW — the composer's three heights as data, so a node test drives
 * them without a renderer. The letter scrolls; the sentences that answer a press stand pinned over
 * the buttons up to a bound and scroll with the letter past it; only the Send / Cancel row is always
 * pinned. A cover screen held sideways is ~403 dp before a keyboard takes its half.
 */
import type { SizeClass } from "./posture/derive";

/** The writing area's floor, dp: the full editor, about three lines at compact height, one line beside the picker. */
export const COMPOSE_BODY_MIN = 120;
export const COMPOSE_BODY_MIN_COMPACT = 84;
export const COMPOSE_BODY_MIN_LATER = 44;

export function composeBodyMin(laterOpen: boolean, heightClass: SizeClass): number {
  if (laterOpen) return COMPOSE_BODY_MIN_LATER;
  return heightClass === "compact" ? COMPOSE_BODY_MIN_COMPACT : COMPOSE_BODY_MIN;
}

/** The pinned sentences' bound, dp: a fifth of the window, never more than 96 (about four caption lines). */
export const PINNED_NOTES_CEILING = 96;

export function pinnedNotesMax(windowHeight: number): number {
  return Math.min(PINNED_NOTES_CEILING, Math.round(windowHeight * 0.2));
}

/** Pinned until measured taller than the bound; unmeasured is pinned, so a first sentence lands by the buttons. */
export function notesPinned(measured: number | null, max: number): boolean {
  return measured === null || measured <= max;
}
