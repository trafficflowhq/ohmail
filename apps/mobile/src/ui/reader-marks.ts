/**
 * THE PHONE'S SQUARES, as data — what the reader's rail and a list row draw, the order the reader
 * draws a conversation in, and when a message's ⋯ offers Mark unread. Pure, so the phone's
 * thread-read guard reads them without a renderer.
 */
import type { WorldEarlier, WorldMail } from "../state/live";

export type MarkKind = "unread" | "read" | "mine";

export interface RailItem {
  id: string;
  kind: MarkKind;
  sender: string;
}

/**
 * THE READER'S TIME ORDER. In the Ohbox the reader draws the conversation oldest first, newest at the
 * bottom, as the list row's squares run: the members older than the opened message `above` it, the
 * newer `below` (the reader opens at the opened message). Elsewhere it keeps its old shape: the opened
 * message first, every other member below it.
 */
export function readerGroups<H extends Pick<WorldEarlier, "later">>(
  m: { earlier: readonly H[] },
  timeOrder: boolean,
): { above: H[]; below: H[] } {
  if (!timeOrder) return { above: [], below: [...m.earlier] };
  return { above: m.earlier.filter((h) => h.later !== true), below: m.earlier.filter((h) => h.later === true) };
}

/**
 * The rail in TIME ORDER — the reader's order in the Ohbox and the list row's: oldest first, the
 * opened message in its own place, so a message has the same square everywhere and its spoken
 * position is its place in time. Empty for a single message.
 */
export function railItemsOf(m: Pick<WorldMail, "id" | "unread" | "ownMail" | "from" | "earlier">): RailItem[] {
  if (m.earlier.length === 0) return [];
  const { above, below } = readerGroups(m, true);
  const member = (h: WorldEarlier): RailItem =>
    ({ id: h.id, kind: !h.seen ? "unread" : h.mine ? "mine" : "read", sender: h.sender ?? "" });
  return [
    ...above.map(member),
    { id: m.id, kind: m.unread ? "unread" : m.ownMail ? "mine" : "read", sender: m.from.name },
    ...below.map(member),
  ];
}

/**
 * A REPLY THAT ARRIVES INTO THE OPEN READER is asked its text once. The members the open found were
 * asked by it (`openMessage`); one that synced in later stood at its snippet for the whole visit,
 * never ready, so the rule could never read it however long it was on screen. Each id is asked once
 * (`asked` keeps them); a member already final is only noted.
 */
export function arrivalsToAsk(members: readonly { id: string; ready?: true }[], asked: Set<string>): string[] {
  const out: string[] = [];
  for (const h of members) {
    if (asked.has(h.id)) continue;
    asked.add(h.id);
    if (h.ready !== true) out.push(h.id);
  }
  return out;
}

/** A message's ⋯ offers Mark unread only on a message that reads as read and is not the account's own. */
export function markUnreadOffered(x: { read: boolean; own: boolean }): boolean {
  return x.read && !x.own;
}

/** One square's step on a row: 8dp and a 3dp gap. */
export const ROW_MARK_STEP = 11;

/** The squares a row of `room` dp draws: all that fit, the oldest giving way first. */
export function marksShown<T>(marks: readonly T[], room: number | null): readonly T[] {
  if (room === null) return marks;
  const fit = Math.max(1, Math.floor((room + 3) / ROW_MARK_STEP));
  return marks.length > fit ? marks.slice(marks.length - fit) : marks;
}

/** The reader rail's pitch per square, its least before it scrolls, and the air above the first. */
export const RAIL_PITCH = 30;
export const RAIL_PITCH_MIN = 16;
export const RAIL_TOP = 6;

/**
 * THE RAIL FITS THE READER: `n` squares in `room` dp (the rail's height less the chrome standing over
 * it) at 30dp each, closer down to 16dp where that fits them all; past that the rail scrolls, so the
 * newest squares — often the unread ones — are never under the bar or off the screen.
 */
export function railFit(n: number, room: number | null): { pitch: number; scrolls: boolean } {
  if (room === null || room <= 0 || n <= 0) return { pitch: RAIL_PITCH, scrolls: false };
  const each = (room - RAIL_TOP) / n;
  if (each >= RAIL_PITCH) return { pitch: RAIL_PITCH, scrolls: false };
  if (each >= RAIL_PITCH_MIN) return { pitch: Math.floor(each), scrolls: false };
  return { pitch: RAIL_PITCH_MIN, scrolls: true };
}

/** Where a scrolling rail stands so square `index` is in view, centred where it can be. */
export function railOffsetFor(index: number, n: number, pitch: number, room: number): number {
  const content = RAIL_TOP + n * pitch;
  const max = Math.max(0, content - room);
  const centre = RAIL_TOP + index * pitch + pitch / 2 - room / 2;
  return Math.max(0, Math.min(max, centre));
}

/** A body's states the read rule takes as final: the text is all there is to show. */
const FINAL_BODY: ReadonlySet<string> = new Set(["full", "withheld"]);

/**
 * The opened message's body is final for the read rule: protected, withheld, or full — and when
 * the html part draws in the frame, only once the frame has its document's height (it stands at
 * the seed until then, and what shows under it is no top of this message at all).
 */
export function openedBodyFinal(
  m: { protected?: unknown; bodyState?: string },
  frame: { framed: boolean; final: boolean },
): boolean {
  if (m.protected != null) return true;
  if (!FINAL_BODY.has(m.bodyState ?? "")) return false;
  return m.bodyState !== "full" || !frame.framed || frame.final;
}

/**
 * WHAT OF THE BOTTOM CHROME STANDS OVER THE READER'S SCROLL VIEW: the pinned bar floats over it
 * (`bar`); the compact bar stands in the column below it and the rail at its side, so the scroll
 * view already ends above them. Taking the compact bar off again ended the read zone about 76dp
 * above the bar (a top on screen just over it did not count).
 */
export function readerChromeOverlap(mode: "compact" | "bar" | "rail", extent: number): number {
  return mode === "bar" ? Math.max(0, extent) : 0;
}
