/**
 * THE THREAD-READ RULE, one copy for the web reader and the phone's (`apps/webapp/app/shell/reader-seen.ts`,
 * `apps/mobile/src/ui/reader-seen.ts`). Pure: each adapter hands in its panels' line boxes and the
 * view in one coordinate system, at a moment, and gets back the ids that turned read.
 *
 * An unread message turns read once its TOP — its sender line and the first lines of its body (about
 * `THREAD_TOP_LINES` lines, or the whole body when it is shorter; a framed body's top, about the same
 * height) — has been wholly inside the view, without a break, for `THREAD_READ_HOLD_MS` of a visit the
 * person ENTERED (an open, a press or a hand scroll in the reader). Its last line is not needed: having
 * seen the top of a message is reading it (owner ruling 2026-10-23). One dwell for every message, the newest
 * and a reply that arrives into the open visit included, and the id is returned only once it is done.
 * Never counted: a preview (before `enter`), a look nobody can see (`view` null: the tab hidden, the
 * window away — every dwell starts over), a panel whose body is not ready, an id kept unread for the
 * visit (`u`, Mark unread, or any read-to-unread turn the record sees), and a dwell across a change of
 * the panel's height by more than 1px (the layout moved: what was on screen was not this top).
 */

/** The dwell: a message's top this long on screen reads it. The tint settles once the read lands. */
export const THREAD_READ_HOLD_MS = 700;
/** The unread tint settling to the panel. */
export const THREAD_READ_FADE_MS = 850;
/** The tint coming back on a turn to unread. */
export const THREAD_UNREAD_BACK_MS = 320;
/** The web's hand-scroll evidence: a scroll counts when the person's input precedes it by at most this. */
export const EVIDENCE_WINDOW_MS = 1000;
/** A message's top: its sender line and about this many lines of its body. */
export const THREAD_TOP_LINES = 3;

/** A line's box, top and bottom, in the view's coordinates. */
export interface LineBox {
  top: number;
  bottom: number;
}

export interface ThreadPanel {
  id: string;
  /** The body is in a terminal state (full, withheld or protected) and laid out as such. */
  ready: boolean;
  /** The panel's own height: a change past 1px starts its dwell over. */
  height: number;
  /** The sender line, or `null` where none is laid out. */
  first: LineBox | null;
  /**
   * The first lines of its body: from the body's top to about `THREAD_TOP_LINES` lines down, or to the
   * body's end when it is shorter (a framed body: the frame's top, the same height). `null` where none
   * is laid out.
   */
  lead: LineBox | null;
}

/** The visible part of the scroller, `bottom` already above the sticky bar or the reply dock. */
export interface ThreadView {
  top: number;
  bottom: number;
}

export interface ThreadRead {
  /** The person entered the conversation; the first call stamps the moment. */
  enter(now: number): void;
  readonly entered: boolean;
  /** When the visit was entered, or `-Infinity` before it. */
  readonly enteredAt: number;
  /** This id stays unread for the visit. */
  keepUnread(id: string): void;
  /** A deliberate read: the keep is let go. */
  release(id: string): void;
  /**
   * One look at `now`: the ids whose top has now been in view for the whole dwell, each once, in
   * panel order. `view` null is a look nobody can see: every dwell under way starts over.
   */
  observe(panels: readonly ThreadPanel[], view: ThreadView | null, unreadNow: ReadonlySet<string>, now: number): string[];
  /** When the earliest dwell under way is done (the adapter looks again then), or `null` when none is. */
  readonly due: number | null;
}

/** Half a pixel of rounding either way; a line cut by a whole pixel is not in view. */
const EDGE = 0.5;
/** A height change past this means the body moved: the dwell starts over. */
const HEIGHT_SLACK = 1;

const inside = (line: LineBox | null, view: ThreadView): boolean =>
  line !== null && line.top >= view.top - EDGE && line.bottom <= view.bottom + EDGE;

/** One record per conversation open. */
export function createThreadRead(): ThreadRead {
  let enteredAt = Number.NEGATIVE_INFINITY;
  const kept = new Set<string>();
  const returned = new Set<string>();
  /** When each top came into view, unbroken since. */
  const since = new Map<string, number>();
  const heights = new Map<string, number>();
  /** Each id's read state at the last observe: a turn to unread is kept. */
  const wasUnread = new Map<string, boolean>();

  return {
    enter(now) {
      if (enteredAt === Number.NEGATIVE_INFINITY) enteredAt = now;
    },
    get entered() {
      return enteredAt !== Number.NEGATIVE_INFINITY;
    },
    get enteredAt() {
      return enteredAt;
    },
    keepUnread(id) {
      kept.add(id);
      since.delete(id);
    },
    release(id) {
      kept.delete(id);
    },
    observe(panels, view, unreadNow, now) {
      const out: string[] = [];
      const entered = enteredAt !== Number.NEGATIVE_INFINITY;
      const present = new Set<string>();
      for (const p of panels) {
        present.add(p.id);
        const unread = unreadNow.has(p.id);
        if (unread && wasUnread.get(p.id) === false) kept.add(p.id);
        wasUnread.set(p.id, unread);
        const h = heights.get(p.id);
        heights.set(p.id, p.height);
        if (h !== undefined && Math.abs(p.height - h) > HEIGHT_SLACK) since.delete(p.id);
        const shown = view !== null && entered && p.ready && unread && !kept.has(p.id) && !returned.has(p.id)
          && inside(p.first, view) && inside(p.lead, view);
        if (!shown) {
          since.delete(p.id);
          continue;
        }
        const from = since.get(p.id);
        if (from === undefined) {
          since.set(p.id, now);
          continue;
        }
        if (now - from >= THREAD_READ_HOLD_MS) {
          since.delete(p.id);
          returned.add(p.id);
          out.push(p.id);
        }
      }
      for (const id of [...since.keys()]) if (!present.has(id)) since.delete(id);
      return out;
    },
    get due() {
      let first = Number.POSITIVE_INFINITY;
      for (const t of since.values()) first = Math.min(first, t);
      return first === Number.POSITIVE_INFINITY ? null : first + THREAD_READ_HOLD_MS;
    },
  };
}
