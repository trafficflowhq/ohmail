/**
 * THE ONE DOOR FOR AN EVENT'S WORDS INTO A NOTICE. A title is written by whoever made the event,
 * on a shared calendar or in an invitation by somebody else, and a notice shows it on a locked
 * screen: so it passes here, as one clean line, or not at all.
 */
import type { EventLabel } from "./kinds.js";

/** The longest title a notice shows, in code points. */
export const NOTICE_TEXT_MAX = 80;

/** White space of every kind, the line and paragraph separators among it: each becomes one space. */
function isSpace(cp: number): boolean {
  return cp === 0x20 || (cp >= 0x09 && cp <= 0x0d) || cp === 0x85 || cp === 0xa0 || cp === 0x1680
    || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 || cp === 0x202f || cp === 0x205f || cp === 0x3000;
}

/**
 * What never reaches a notice: the control characters, the marks that turn the reading direction,
 * the characters with no width or no mark of their own (the tag characters, the variation
 * selectors, the grapheme joiner, the Hangul fillers, the blank Braille pattern), and half of a
 * surrogate pair. The desktop's shell drops the same (`notice.rs`): one table holds both
 * (`test/notice-text-dropped.json`).
 */
function isDropped(cp: number): boolean {
  return cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)
    || cp === 0x61c || cp === 0x200e || cp === 0x200f || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)
    || cp === 0xad || cp === 0x180e || (cp >= 0x200b && cp <= 0x200d) || (cp >= 0x2060 && cp <= 0x2064) || cp === 0xfeff
    || cp === 0x34f || cp === 0x115f || cp === 0x1160 || cp === 0x3164 || cp === 0xffa0 || cp === 0x2800
    || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0000 && cp <= 0xe007f) || (cp >= 0xe0100 && cp <= 0xe01ef)
    || (cp >= 0xd800 && cp <= 0xdfff);
}

/** `raw` as one line of at most {@link NOTICE_TEXT_MAX} code points, or `null` when nothing is left. */
export function cleanNoticeText(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let out = "";
  let kept = 0;
  let gap = false;
  for (const ch of raw) {
    const cp = ch.codePointAt(0)!;
    if (isSpace(cp)) { gap = kept > 0; continue; }
    if (isDropped(cp)) continue;
    // A gap is written only before a character that follows it, so the line never ends on one.
    const room = NOTICE_TEXT_MAX - kept - (gap ? 1 : 0);
    if (room < 1) break;
    if (gap) { out += " "; kept += 1; gap = false; }
    out += ch;
    kept += 1;
  }
  return kept === 0 ? null : out;
}

/**
 * How `event` is named in a notice. `null` for an invitation not yet shown on the calendar: it makes
 * no notice at all. `Busy` for a private event whatever the switch says. `Event` where the person
 * hides titles, or where nothing of the title is left.
 */
export function eventLabel(
  event: { readonly title: string; readonly private: boolean; readonly heldBack: boolean },
  showTitles: boolean,
): EventLabel | null {
  if (event.heldBack !== false) return null;
  if (event.private !== false) return { as: "busy" };
  if (showTitles !== true) return { as: "event" };
  const text = cleanNoticeText(event.title);
  return text === null ? { as: "event" } : { as: "title", text };
}
