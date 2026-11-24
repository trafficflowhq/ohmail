/**
 * WHERE THE READ RULE FINDS THE COLUMN'S PARTS. The letter's wrapper carries the panel's facts (`data-conv-id`,
 * `data-unseen`, `data-body-ready`), its text stands in `data-read-body`, the action panel's wrapper is the stop, and
 * the column's root is where the stop is looked for (it floats beside the scroller).
 *
 * Three readings of the kit's markup live here and nowhere else, each until the kit hands the part out: the sender
 * line is its head's sender button (asked of the kit: the head marks it), the scroller is its reading sheet's
 * scrolling box (asked of the kit: the sheet hands it out), and the reading head is what stays over that box's top
 * (asked of the kit: the head says so).
 */
import type { ThreadDomNames } from "@ohmail/app-logic/reading";

export const READER_DOM: ThreadDomNames = {
  from: ".oh-messagehead-sender",
  body: "[data-read-body]",
  stops: "[data-read-stop]",
  stopsRoot: "[data-read-column]",
  head: ".oh-readinghead",
};

/** The reading sheet's scrolling box under the column's root. */
export function scrollerOf(root: Element | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>(".oh-sheet-scroll") ?? null;
}
