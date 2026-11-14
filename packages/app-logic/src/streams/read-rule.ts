/**
 * THE READ RULE OF A STREAM (News and Receipts): what a person's hand carries through is read at once, the item the
 * stream comes to rest on after 0.6 s, and nothing before the person has moved the stream. Pure: the caller measures,
 * keeps the clock and fires `rest` STREAM_REST_MS after the last scroll; the rule only answers which ids to write.
 *
 * 1. Nothing before `driven` (a hand, a press in the stream, or `j`/`k`).
 * 2. An item is shown once its first lines (the smaller of its height and 96 px) stood wholly in view at an attended
 *    look, or a downward sweep by hand covered it. A look in a flight (End, a far jump) shows nothing: what it
 *    carries past was not seen, and what stands where it lands is seen at the rest.
 * 3. By hand only: going down, a shown item whose foot is at or above the top plus 90 px is read; going up, one whose
 *    start is at or below the foot less 90 px; at the end the stream is going to, every shown item.
 * 4. The resting item is read after 600 ms if it is shown, the stream is driven and the item is not kept.
 * 5. A stream that fits whole reads what stands in it on a hand that tries to carry it on.
 * 6. Arrows, `j` and `k` are never a hand: they drive the stream, so only the rest reads after them.
 * 7. `keepUnread` holds for the visit.
 * 8. A look that is not attended (a hidden tab) reads and shows nothing; an item whose body is not in is never read
 *    live, only by the leave.
 */

/** How long the stream rests on an item before it is read. */
export const STREAM_REST_MS = 600;
/** The first lines of an item that must stand wholly in view for it to count as shown. */
export const STREAM_FIRST_LINES_PX = 96;
/** How far past the top (going down) or the foot (going up) an item must be carried. */
export const STREAM_READING_LINE_PX = 90;
/** How near an end the stream must stand to be at it, and how much overflow a stream that fits whole may have. */
export const STREAM_END_SLACK_PX = 2;
/** How long after the last wheel step or key a scroll is still the hand's; a finger's momentum runs longer. */
export const STREAM_HAND_MS = 450;
export const STREAM_TOUCH_HAND_MS = 1500;

export interface StreamItemBox {
  readonly id: string;
  /** From the top of the stream's content, in CSS px. */
  readonly top: number;
  readonly height: number;
  readonly unread: boolean;
  /** Its body is in: an item drawn as a placeholder is never read live. */
  readonly ready: boolean;
}
export interface StreamLook {
  readonly scrollTop: number;
  readonly viewHeight: number;
  readonly scrollHeight: number;
  /** The mounted items, measured. */
  readonly items: readonly StreamItemBox[];
  /** The clock of the look, in ms (the caller's). */
  readonly at: number;
}
export type StreamHand = "wheel" | "touch" | "key";

export interface StreamReadRule {
  /** A press in the stream or on a row, an arrow, `j`, `k` or a jump to an end: the stream is driven, and the scroll that follows is not the hand's. */
  enter(at: number): void;
  /** A wheel step, a finger on the stream (`touching` while it is down), or Space, Page Up, Page Down. */
  hand(kind: StreamHand, at: number, touching?: boolean): void;
  /** A scroll was seen: what it carried through, read now. `flight`: a jump of many screens. */
  look(l: StreamLook, attended: boolean, flight: boolean): readonly string[];
  /** A hand on a stream that fits whole: what stands in it, read now (nothing where the stream overflows). */
  still(l: StreamLook, by: StreamHand): readonly string[];
  /** Fired STREAM_REST_MS after the last scroll: the item the stream rests on, read now. */
  rest(l: StreamLook, restingId: string | null): readonly string[];
  keepUnread(id: string): void;
  shown(id: string): boolean;
  /** This visit read it, live or by the rule while its body was not in, and it was not marked unread since: the leave flips it. */
  read(id: string): boolean;
  readonly driven: boolean;
}

export function createStreamReadRule(): StreamReadRule {
  let driven = false;
  let handAt = Number.NEGATIVE_INFINITY;
  let handKind: StreamHand = "wheel";
  let touching = false;
  let pos: number | null = null;
  const shownIds = new Set<string>();
  const kept = new Set<string>();
  const said = new Set<string>();
  /** Read by the rule while its body was not in: never written live, flipped by the leave. */
  const owed = new Set<string>();

  const byHand = (at: number): boolean =>
    touching || at - handAt < (handKind === "touch" ? STREAM_TOUCH_HAND_MS : STREAM_HAND_MS);
  const firstLinesIn = (item: StreamItemBox, top: number, foot: number): boolean =>
    item.top >= top - 4 && item.top + Math.min(item.height, STREAM_FIRST_LINES_PX) <= foot;
  const readable = (item: StreamItemBox): boolean => {
    if (!item.unread || !shownIds.has(item.id) || kept.has(item.id) || said.has(item.id)) return false;
    if (item.ready) return true;
    owed.add(item.id);
    return false;
  };
  const write = (ids: string[]): readonly string[] => {
    for (const id of ids) said.add(id);
    return ids;
  };

  return {
    get driven() {
      return driven;
    },
    enter() {
      driven = true;
      /* What a press scrolls to is the press's landing, not the hand's. */
      handAt = Number.NEGATIVE_INFINITY;
      touching = false;
    },
    hand(kind, at, isTouching) {
      driven = true;
      handKind = kind;
      handAt = at;
      if (kind === "touch") touching = isTouching === true;
    },
    look(l, attended, flight) {
      const prev = pos ?? l.scrollTop;
      const top = l.scrollTop;
      pos = top;
      if (!attended) return [];
      const foot = top + l.viewHeight;
      const hand = byHand(l.at);
      const up = top < prev;
      const lo = Math.min(prev, top);
      const hi = Math.max(prev, top) + l.viewHeight;
      /* A flight shows nothing: what crosses the view on its animated frames was never seen at rest. */
      for (const item of flight ? [] : l.items) {
        const end = item.top + item.height;
        if (firstLinesIn(item, top, foot)) shownIds.add(item.id);
        else if (hand && !up && end > lo && item.top < hi) shownIds.add(item.id);
      }
      if (!driven || !hand) return [];
      const atEnd = up
        ? top <= STREAM_END_SLACK_PX
        : top >= l.scrollHeight - l.viewHeight - STREAM_END_SLACK_PX;
      const past: string[] = [];
      for (const item of l.items) {
        if (!readable(item)) continue;
        const through = up
          ? item.top >= foot - STREAM_READING_LINE_PX
          : item.top + item.height <= top + STREAM_READING_LINE_PX;
        if (atEnd || through) past.push(item.id);
      }
      return write(past);
    },
    still(l) {
      if (l.scrollHeight - l.viewHeight > STREAM_END_SLACK_PX) return [];
      driven = true;
      const foot = l.scrollTop + l.viewHeight;
      const past: string[] = [];
      for (const item of l.items) {
        if (item.top + Math.min(item.height, STREAM_FIRST_LINES_PX) > foot) continue;
        shownIds.add(item.id);
        if (readable(item)) past.push(item.id);
      }
      return write(past);
    },
    rest(l, restingId) {
      const foot = l.scrollTop + l.viewHeight;
      for (const item of l.items) if (firstLinesIn(item, l.scrollTop, foot)) shownIds.add(item.id);
      if (!driven || restingId === null) return [];
      const item = l.items.find((i) => i.id === restingId);
      return item && readable(item) ? write([item.id]) : [];
    },
    keepUnread(id) {
      kept.add(id);
    },
    shown(id) {
      return shownIds.has(id);
    },
    read(id) {
      return !kept.has(id) && (said.has(id) || owed.has(id));
    },
  };
}
