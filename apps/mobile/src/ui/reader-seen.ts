import { THREAD_TOP_LINES, type ThreadPanel, type ThreadRead } from "@ohmail/client-engine";

/* The reader's one door to the shared rule: its record and the fade constants the tint runs on. */
export {
  THREAD_READ_FADE_MS, THREAD_READ_HOLD_MS, THREAD_TOP_LINES, THREAD_UNREAD_BACK_MS, createThreadRead, type ThreadRead,
} from "@ohmail/client-engine";

/**
 * THE THREAD-READ RULE IN THE PHONE'S READER — the engine's `createThreadRead` over React Native's
 * layout and scroll events, in content coordinates. The reader reports the opened message's section
 * (its sender row, where its body starts and its own end marker), each member panel's place in the
 * group drawn above or below the opened message, its header row, where its body starts and its end
 * marker, the enclosing offsets, the scroll view's height, what of the bottom chrome stands over it,
 * and every scroll. A message turns read once its TOP — its sender row and its body's first lines
 * (`THREAD_TOP_LINES` of them, `lines(id)` px, or the body to its end where it is shorter) — has been
 * in view for the dwell; its end is not needed. One look per frame, and one when a dwell under way
 * is due; what turned read goes out at once (`onRead`). The record is entered at the reader's mount:
 * a phone reader is an open. Nothing is looked at while the app is not in the foreground, and every
 * dwell starts over then.
 */

export type PhoneGroup = "above" | "below";

export interface PhoneThreadRead {
  /** The scroll view's own height, and what of the bottom chrome stands OVER it (0 where it stands below). */
  viewport: (height: number) => void;
  chrome: (overlap: number) => void;
  /**
   * An enclosing view's y inside its parent: `padded` (the reader's column in the scroll content);
   * inside it `opened` (the opened message's section), `above` and `below` (the members' lists).
   */
  offset: (which: "padded" | "opened" | PhoneGroup, y: number) => void;
  /** The opened message's sender row (y, height), where its body starts, and its end marker, in its section. */
  openedFrom: (y: number, height: number) => void;
  openedBody: (y: number) => void;
  openedEnd: (y: number) => void;
  /** A member panel's y in its group's list and its height; its header row, body start and end marker inside it. */
  panel: (id: string, group: PhoneGroup, y: number, height: number) => void;
  panelHeader: (id: string, y: number, height: number) => void;
  panelBody: (id: string, y: number) => void;
  panelEnd: (id: string, y: number) => void;
  /** Where the scroll view stands: every scroll event, the end of a drag or a fling, the app's own jump. */
  onScroll: (offsetY: number) => void;
  /** Look again in the next frame (a read state or a body changed, the app came back). */
  poke: () => void;
  /** Every panel laid out, top to bottom, the opened message (`openedId`) among them: the reader's place reads it. */
  layout: (openedId: string) => { id: string; top: number; height: number }[];
  /** Where a panel's top sits in the scroll content, for a jump to it; `null` before its layout. */
  topOf: (id: string) => number | null;
  dispose: () => void;
}

export interface PhoneThreadReadOptions {
  record: ThreadRead;
  /** The opened message's id where the rule reads it too (the Ohbox), else `null`. Asked per look. */
  openedId: () => string | null;
  /** Is this id unread now, and is its body final — the mirror's answers at the moment. */
  unread: (id: string) => boolean;
  ready: (id: string) => boolean;
  onRead: (ids: string[]) => void;
  /** The first lines of this message's body, in dp: `THREAD_TOP_LINES` lines of its text. */
  lines?: (id: string) => number;
  /** Is the app in the foreground (`AppState` active)? Asked per look; absent, always. */
  active?: () => boolean;
  /** The panel most in view (its square's ring), each time it changes. */
  onHere?: (id: string | null) => void;
  /** The frame scheduler and the dwell's timer; tests run them by hand. */
  frame?: (run: () => void) => () => void;
  after?: (ms: number, run: () => void) => () => void;
  now?: () => number;
}

/** A line of body text where the reader names none: the stream body's, 14.5 at 1.7. */
const LINE_DP = 24.65;

interface Member { group: PhoneGroup; y: number; h: number; fromY: number | null; fromH: number; bodyY: number | null; endY: number | null }

const NOTHING: ReadonlySet<string> = new Set();

export function createPhoneThreadRead(o: PhoneThreadReadOptions): PhoneThreadRead {
  const frame = o.frame ?? ((run: () => void) => {
    const id = requestAnimationFrame(run);
    return () => cancelAnimationFrame(id);
  });
  const after = o.after ?? ((ms: number, run: () => void) => {
    const t = setTimeout(run, ms);
    return () => clearTimeout(t);
  });
  const now = o.now ?? Date.now;
  const lines = o.lines ?? (() => THREAD_TOP_LINES * LINE_DP);
  const offsets = { padded: 0, opened: 0, above: 0, below: 0 };
  const members = new Map<string, Member>();
  let height = 0;
  let chrome = 0;
  let y = 0;
  let from: { y: number; h: number } | null = null;
  let body: number | null = null;
  let end: number | null = null;
  let live = true;
  let pending: (() => void) | null = null;
  let dwell: (() => void) | null = null;
  let here: string | null = null;

  const member = (id: string): Member => {
    let m = members.get(id);
    if (!m) { m = { group: "below", y: 0, h: 0, fromY: null, fromH: 0, bodyY: null, endY: null }; members.set(id, m); }
    return m;
  };
  const topOfMember = (m: Member): number => offsets.padded + offsets[m.group] + m.y;
  /** The body's first lines, from where it starts to `lines` down or to its end where that comes first. */
  const leadOf = (id: string, top: number, bodyY: number | null, endY: number | null) =>
    bodyY !== null && endY !== null
      ? { top: top + bodyY, bottom: top + Math.max(bodyY, Math.min(bodyY + lines(id), endY)) }
      : null;
  const listed = (group: PhoneGroup) =>
    [...members].filter(([, m]) => m.group === group).sort((a, b) => a[1].y - b[1].y);
  /** The panels in the order they are drawn: the members above, the opened message, the members below. */
  const panels = (): { panel: ThreadPanel; top: number; bottom: number }[] => {
    const out: { panel: ThreadPanel; top: number; bottom: number }[] = [];
    const push = ([id, m]: [string, Member]) => {
      const top = topOfMember(m);
      out.push({
        panel: {
          id,
          ready: o.ready(id),
          height: m.h,
          first: m.fromY !== null && m.fromH > 0 ? { top: top + m.fromY, bottom: top + m.fromY + m.fromH } : null,
          lead: leadOf(id, top, m.bodyY, m.endY),
        },
        top,
        bottom: top + m.h,
      });
    };
    listed("above").forEach(push);
    const opened = o.openedId();
    if (opened !== null) {
      const top = offsets.padded + offsets.opened;
      out.push({
        panel: {
          id: opened,
          ready: o.ready(opened),
          height: end ?? 0,
          first: from ? { top: top + from.y, bottom: top + from.y + from.h } : null,
          lead: leadOf(opened, top, body, end),
        },
        top,
        bottom: top + (end ?? 0),
      });
    }
    listed("below").forEach(push);
    return out;
  };
  /** A dwell under way is looked at again when it is done. */
  const schedule = (): void => {
    dwell?.();
    dwell = null;
    const due = o.record.due;
    if (due === null || !live) return;
    dwell = after(Math.max(0, due - now()) + 1, () => { dwell = null; poke(); });
  };
  const look = (): void => {
    pending = null;
    if (!live) return;
    const t = now();
    if (height <= 0 || o.active?.() === false) {
      // Nobody can be seeing this (the app is away, nothing is laid out): every dwell starts over.
      o.record.observe([], null, NOTHING, t);
      schedule();
      return;
    }
    const all = panels();
    const unread = new Set(all.filter((p) => o.unread(p.panel.id)).map((p) => p.panel.id));
    const view = { top: y, bottom: y + height - chrome };
    const ids = o.record.observe(all.map((p) => p.panel), view, unread, t);
    if (ids.length > 0) o.onRead(ids);
    schedule();
    /* The ring: the panel with the most of itself in view, a tie to the later one. */
    let best: string | null = null;
    let most = 0;
    for (const p of all) {
      const px = Math.min(p.bottom, view.bottom) - Math.max(p.top, view.top);
      if (px > 0 && px >= most) { most = px; best = p.panel.id; }
    }
    if (best !== here) { here = best; o.onHere?.(best); }
  };
  const poke = (): void => {
    if (!live || pending) return;
    pending = frame(look);
  };
  return {
    viewport: (h) => { height = h; poke(); },
    chrome: (overlap) => { chrome = Math.max(0, overlap); poke(); },
    offset: (which, v) => { offsets[which] = v; poke(); },
    openedFrom: (fy, fh) => { from = { y: fy, h: fh }; poke(); },
    openedBody: (by) => { body = by; poke(); },
    openedEnd: (ey) => { end = ey; poke(); },
    panel: (id, group, py, h) => { const m = member(id); m.group = group; m.y = py; m.h = h; poke(); },
    panelHeader: (id, hy, hh) => { const m = member(id); m.fromY = hy; m.fromH = hh; poke(); },
    panelBody: (id, by) => { member(id).bodyY = by; poke(); },
    panelEnd: (id, ey) => { member(id).endY = ey; poke(); },
    onScroll: (offsetY) => { y = offsetY; poke(); },
    poke,
    layout: (openedId) => {
      const boxes = (group: PhoneGroup) => listed(group).map(([id, m]) => ({ id, top: topOfMember(m), height: m.h }));
      return [...boxes("above"), { id: openedId, top: offsets.padded + offsets.opened, height: end ?? 0 }, ...boxes("below")];
    },
    topOf: (id) => {
      if (id === o.openedId()) return offsets.padded + offsets.opened;
      const m = members.get(id);
      return m ? topOfMember(m) : null;
    },
    dispose: () => {
      live = false;
      pending?.();
      pending = null;
      dwell?.();
      dwell = null;
    },
  };
}
