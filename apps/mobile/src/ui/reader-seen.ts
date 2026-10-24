import { THREAD_TOP_LINES, threadWalk, type ThreadPanel, type ThreadRead, type Walk } from "@ohmail/client-engine";

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
 *
 * The ring (`onHere`) is the engine's walk (`threadWalk`, the web's too): the last message whose top
 * has crossed the reading line, the first at the top and the last at the very end. Its geometry — the
 * tops, the scroll's range, the reading height — is rebuilt after a layout report, never on a scroll;
 * a scroll gives it the offset only. A pin (a square pressed, the open's landing) holds the ring
 * until the person scrolls: their drag (`pin(null)`), or any scroll the app did not make — a report
 * away from the offset the app last asked for (`asked`) while no app scroll is on its way, which is
 * how a screen reader's scroll, a status-bar tap or a wheel arrives (no drag begins for those).
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
  /** The scroll content's height (`onContentSizeChange`): the scroll's range is it less the view. */
  content: (height: number) => void;
  /**
   * Where the scroll view stands: every scroll event, the end of a drag or a fling, the app's own jump.
   * `appMoving`: an app scroll is on its way (the open anchor aiming, an animated jump), so the report is the app's.
   */
  onScroll: (offsetY: number, appMoving?: boolean) => void;
  /** The app scrolls the view to this offset (the anchor's aim, a square's jump): a report there is the app's. */
  asked: (y: number) => void;
  /** A square pressed or the open's landing: that message is the ring until the person scrolls (`pin(null)`, `onScroll`). */
  pin: (id: string | null) => void;
  /** The scroll that puts this message's top on the walk's reading line; `null` before its layout. */
  scrollFor: (id: string) => number | null;
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
  /** Where the scroll view starts: the offset the app asked for until it asks another. */
  start?: number;
  /** The current message (its square's ring, the walk's answer), each time it changes. */
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
  let contentH = 0;
  let pinned: string | null = null;
  let asked = o.start ?? 0;
  /** The walk over the last layout; `null` once a layout report changed it. */
  let walk: { ids: string[]; opened: string | null; w: Walk } | null = null;

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
  /** The walk over the panels as laid out now, in drawing order (the Ohbox's time order). */
  const walkNow = (): { ids: string[]; w: Walk } => {
    const opened = o.openedId();
    if (walk !== null && walk.opened === opened) return walk;
    const all = panels();
    const ids = all.map((p) => p.panel.id);
    walk = {
      ids,
      opened,
      w: threadWalk({
        tops: all.map((p) => p.top),
        max: Math.max(0, contentH - height),
        view: height - chrome,
        opened: opened === null ? -1 : ids.indexOf(opened),
      }),
    };
    return walk;
  };
  /** The ring: the pin while one holds, else the walk at the scroll; no answer keeps the last. */
  const ring = (): void => {
    const { ids, w } = walkNow();
    const at = pinned === null ? -1 : ids.indexOf(pinned);
    const i = w.current(y, at >= 0 ? { index: at } : null);
    if (i < 0) return;
    const id = ids[i] ?? null;
    if (id !== here) { here = id; o.onHere?.(id); }
  };
  /** A layout report: the walk is measured again at the next look. */
  const moved = (): void => { walk = null; poke(); };
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
      ring();
      return;
    }
    const all = panels();
    const unread = new Set(all.filter((p) => o.unread(p.panel.id)).map((p) => p.panel.id));
    const view = { top: y, bottom: y + height - chrome };
    const ids = o.record.observe(all.map((p) => p.panel), view, unread, t);
    if (ids.length > 0) o.onRead(ids);
    schedule();
    ring();
  };
  function poke(): void {
    if (!live || pending) return;
    pending = frame(look);
  }
  return {
    viewport: (h) => { height = h; moved(); },
    chrome: (overlap) => { chrome = Math.max(0, overlap); moved(); },
    offset: (which, v) => { offsets[which] = v; moved(); },
    openedFrom: (fy, fh) => { from = { y: fy, h: fh }; poke(); },
    openedBody: (by) => { body = by; poke(); },
    openedEnd: (ey) => { end = ey; poke(); },
    panel: (id, group, py, h) => { const m = member(id); m.group = group; m.y = py; m.h = h; moved(); },
    panelHeader: (id, hy, hh) => { const m = member(id); m.fromY = hy; m.fromH = hh; moved(); },
    panelBody: (id, by) => { member(id).bodyY = by; poke(); },
    panelEnd: (id, ey) => { member(id).endY = ey; poke(); },
    content: (h) => { contentH = h; moved(); },
    onScroll: (offsetY, appMoving = false) => {
      y = offsetY;
      if (pinned !== null && !appMoving && Math.abs(offsetY - asked) > 1) pinned = null;
      poke();
    },
    asked: (ay) => { asked = ay; },
    pin: (id) => { pinned = id; poke(); },
    scrollFor: (id) => {
      if (height <= 0 || contentH <= 0) return null;
      const { ids, w } = walkNow();
      const i = ids.indexOf(id);
      return i < 0 ? null : w.scrollFor(i);
    },
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
