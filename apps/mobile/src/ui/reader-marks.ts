/**
 * THE PHONE'S SQUARES, as data — what the reader's rail and a list row draw, the order the reader
 * draws a conversation in, and when a message's ⋯ offers Mark unread. Pure, so the phone's
 * thread-read guard reads them without a renderer.
 */
import { clock, fullDateTime, weekdayDateClock, zonedDayNumber, zonedFields } from "./reader-seen";
import type { WorldAttachment, WorldEarlier, WorldMail } from "../state/live";
import { MIN_SLOP } from "../theme/tokens";

export type MarkKind = "unread" | "read" | "mine";

export interface RailItem {
  id: string;
  kind: MarkKind;
  sender: string;
  /** What a held square's sheet says beside the name: the message's date, its first line, a file. */
  at?: string | null;
  line?: string;
  file?: true;
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
type RailSource = Pick<WorldMail, "id" | "unread" | "ownMail" | "from" | "earlier"> & Partial<Pick<WorldMail, "date" | "body" | "snippet" | "attachments">>;

export function railItemsOf(m: RailSource): RailItem[] {
  if (m.earlier.length === 0) return [];
  const { above, below } = readerGroups(m, true);
  const facts = (x: { date?: string | null; body?: string; snippet?: string; attachments?: readonly WorldAttachment[] }) => {
    const line = markLine(x.body) || markLine(x.snippet);
    return {
      ...(x.date !== undefined ? { at: x.date } : {}),
      ...(line !== "" ? { line } : {}),
      ...(hasFile(x) ? { file: true as const } : {}),
    };
  };
  const member = (h: WorldEarlier): RailItem =>
    ({ id: h.id, kind: !h.seen ? "unread" : h.mine ? "mine" : "read", sender: h.sender ?? "", ...facts(h) });
  return [
    ...above.map(member),
    { id: m.id, kind: m.unread ? "unread" : m.ownMail ? "mine" : "read", sender: m.from.name, ...facts(m) },
    ...below.map(member),
  ];
}

const hasFile = (x: { attachments?: readonly WorldAttachment[] }): boolean => x.attachments?.some((a) => !a.inline) === true;

/** What {@link railItemsOf} reads of a message, flat: the same facts answer the same array. */
function railFacts(m: RailSource): unknown[] {
  const out: unknown[] = [m.id, m.unread, m.ownMail, m.from.name, m.date, m.body, m.snippet, hasFile(m)];
  for (const h of m.earlier) out.push(h.id, h.seen, h.mine, h.later, h.sender, h.date, h.body, hasFile(h));
  return out;
}

/**
 * {@link railItemsOf} for one reader: asked again only when a fact it reads moved (a body, a file, a
 * mark), so a render that changed none of them keeps the same array and nothing downstream re-runs.
 */
export function railItemsMemo(): (m: RailSource) => RailItem[] {
  let last: { facts: unknown[]; items: RailItem[] } | null = null;
  return (m) => {
    const facts = railFacts(m);
    if (last !== null && last.facts.length === facts.length && last.facts.every((f, i) => Object.is(f, facts[i]))) return last.items;
    last = { facts, items: railItemsOf(m) };
    return last.items;
  };
}

/** A finger held this long on a square shows its sheet, and presses nothing. */
export const MARK_HOLD_MS = 380;
/** The sheet stays this long after the finger lifts. */
export const MARK_HOLD_KEEP_MS = 1100;

/**
 * A held square's date, the web chip's words: today 09:12 · yesterday 17:40 · Wed 21 Oct, 14:05,
 * the year outside this one; "" with no date.
 */
export function markWhen(
  at: string | null | undefined, now: Date, zone: string, locale: string, words: { today: string; yesterday: string },
): string {
  const d = at ? new Date(at) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  const ago = zonedDayNumber(now, zone) - zonedDayNumber(d, zone);
  if (ago === 0) return `${words.today} ${clock(d, zone)}`;
  if (ago === 1) return `${words.yesterday} ${clock(d, zone)}`;
  if (zonedFields(d, zone).year !== zonedFields(now, zone).year) return fullDateTime(d, zone, locale);
  return weekdayDateClock(d, zone, locale);
}

/** A message's first line for the sheet: its first line with words, cut at a word near 64 characters. */
export function markLine(text: string | null | undefined): string {
  const s = text ?? "";
  let line = "";
  /* Line by line up to the first with words only: a long quoted history is never read past it. */
  for (let from = 0; from < s.length && line === "";) {
    const nl = s.indexOf("\n", from);
    const to = nl < 0 ? s.length : nl;
    line = s.slice(from, to).replace(/\s+/g, " ").trim();
    from = to + 1;
  }
  if (line.length <= 64) return line;
  const cut = line.slice(0, 64);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > 40 ? cut.slice(0, sp) : cut).trimEnd()}\u2026`;
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
/** A square's touch target: its own pitch high, so the squares tile the rail without overlap (`Tap`'s default slop overlapped them). */
export const RAIL_HIT_SLOP = { top: 0, bottom: 0, left: MIN_SLOP, right: MIN_SLOP } as const;

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

/** A list row's strip of the reader's squares: 20dp a square, its face 5dp in (the row's text at 14 over 9 of air). */
export const STRIP_SLOT = 20;
export const STRIP_START = 9;
export const STRIP_END = 14;
/** Its presses reach down over its air, never up into the row above them nor into a neighbour. */
export const STRIP_HIT_SLOP = { top: 4, bottom: 10, left: 0, right: 0 } as const;

/** Where a strip that scrolls stands so square `index` is in view, centred where it can be. */
export function stripOffsetFor(index: number, n: number, room: number): number {
  const content = STRIP_START + n * STRIP_SLOT + STRIP_END;
  const max = Math.max(0, content - room);
  const centre = STRIP_START + index * STRIP_SLOT + STRIP_SLOT / 2 - room / 2;
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
