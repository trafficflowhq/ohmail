"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  EVIDENCE_WINDOW_MS, THREAD_TOP_LINES, createThreadRead,
  type EngineMessage, type LineBox, type ThreadPanel, type ThreadRead, type ThreadView,
} from "@ohmail/client-engine";
import { SCROLL_KEYS, cssRect } from "@ohmail/ui";
import { pageModal } from "./modal-gate";
import { stampLive } from "./programmatic-scroll";
import type { ThreadWalkChannel } from "./thread-walk-channel";

/**
 * THE THREAD-READ RULE IN THE READER — the DOM adapter over the engine's `createThreadRead`. Each
 * panel is a `[data-conv-id]` element: its sender line is `.msg-from`, its first lines the top of its
 * body block (`.msg-body`, `.pm-body`; a framed body's frame) down about `THREAD_TOP_LINES` lines of
 * the body's own line height, or to the body's end where it is shorter, and the end of its text is that
 * end (a framed body's frame foot, else `[data-own-end]`, else the block's foot); it is ready while it
 * carries `data-body-ready`, unread while it carries `data-unseen`. The view is the scroller's box above
 * the sticky bar or the reply dock. One observe per frame, on scroll, resize, a panel's size or
 * attributes changing, the window coming back, and when a dwell under way is due. The rule (the
 * engine's header): "A message turns read once its first lines have stayed on screen for 0.7 s and its
 * sender line has been fully on screen or the end of its text has been on screen (a preview counts), in
 * either order. Nothing that was never on screen turns read; Mark unread starts it over."
 *
 * A look counts only while the person can be reading: the tab visible, and the window focused or
 * scrolled by the person's own hand within the evidence window (a wheel over a window beside another
 * app). Any other look starts every dwell over. A look whose layout moved since the previous one
 * counts nothing and looks again: between a body landing and the thread anchor's correction the view
 * is one no one saw. A framed body is ready only once its frame was measured (its end marker drawn),
 * and a body that still stands in for its frame (`data-body-pending`) is not ready.
 *
 * The evidence code only ENTERS a preview: a press or touch on a message's own panel or on the
 * scroller's box (never on a verb, a menu or a field: `pressEnters`), a wheel, and a scroll the person made (a free scroll key, or the frame clause: pointer on a framed body, the
 * document focused, no key, focus or selection move just before). A stamped app scroll, one while
 * the geometry moved, or one within a second of a resize never enters. A landing given `restMs` is
 * also entered once the cursor rests on it ({@link LANDING_REST_MS}).
 */

export { EVIDENCE_WINDOW_MS };

/**
 * A LANDING THE PERSON RESTS ON IS ENTERED: the Ohbox's j/k, a verb's advance or an Undo, or ↓/↑
 * (j/k in History) in a reader off the Ohbox, put the cursor here, and it stayed this long with the
 * window in front, no page modal over it and no command since. With the 0.7 s dwell, a message on
 * screen reads 2 s after the cursor stopped.
 */
export const LANDING_REST_MS = 1300;

/**
 * The rule's clock and its dwell timer. Production reads the wall clock; a test that lays the reader
 * out passes the dwell by hand (`test/fixtures/thread-layout.ts`) rather than waiting it out.
 */
export const threadReadTime = {
  now: (): number => Date.now(),
  after: (ms: number, run: () => void): (() => void) => {
    const t = setTimeout(run, ms);
    return () => clearTimeout(t);
  },
};

export interface ThreadReadDomOptions {
  scroller: HTMLElement;
  record: ThreadRead;
  /** Ids that turned read in one look — one write per look. */
  onRead: (ids: string[]) => void;
  /** The person showed they are reading here: the visit is entered. */
  onEnter: () => void;
  /** Every hand scroll — the thread anchor's handover rides the same authority. */
  onHumanScroll?: () => void;
  /** Is a framed body under the pointer? Injected in tests (jsdom has no `:hover`). */
  frameHovered?: () => boolean;
  documentFocused?: () => boolean;
  visible?: () => boolean;
  now?: () => number;
  /** The frame scheduler; tests run it by hand. */
  frame?: (run: () => void) => () => void;
  /** The dwell's timer: run once `ms` from now. */
  after?: (ms: number, run: () => void) => () => void;
  /** A landing: an unentered visit is entered after this long attended, unless a command came first. */
  restMs?: number;
  /** What the rest calls (default `onEnter`). */
  onRest?: () => void;
  /** The cursor stayed `restMs` on this landing, whatever came in between (its pictures may load). */
  onStay?: () => void;
}

export interface ThreadReadDom {
  readonly scroller: HTMLElement;
  /** Look again in the next frame (the record was entered, a body landed). */
  poke: () => void;
  dispose: () => void;
}

/** Is a framed mail body under the pointer — the one sign of the person a wheel over it leaves us. */
export function frameEngaged(scroller: HTMLElement): boolean {
  try {
    return scroller.querySelector("iframe.mb-frame:hover") !== null;
  } catch {
    return false; // an engine without `:hover` in selectors answers no
  }
}

/**
 * The next frame, or a short timer where no frame comes (a tab the browser throttles, a test on
 * fake timers): whichever is first runs, once.
 */
export function nextFrame(win: Window, run: () => void): () => void {
  let done = false;
  const go = (): void => {
    if (done) return;
    done = true;
    run();
  };
  const raf = win.requestAnimationFrame ? win.requestAnimationFrame(go) : null;
  const timer = win.setTimeout(go, 16);
  return () => {
    done = true;
    if (raf !== null) win.cancelAnimationFrame?.(raf);
    win.clearTimeout(timer);
  };
}

const box = (el: Element | null): LineBox | null => {
  if (!el) return null;
  const r = cssRect(el);
  return { top: r.top, bottom: r.bottom };
};

/** A line where the body says nothing usable about its own (jsdom, an engine answering `normal` without a size). */
export const TOP_LINE_FALLBACK_PX = 24;

/** One line of this body's text, in CSS px: its resolved line height, `normal` taken as 1.2 of the font. */
export function lineHeightOf(el: Element): number {
  const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
  const raw = cs?.lineHeight ?? "";
  const size = Number.parseFloat(cs?.fontSize ?? "");
  const n = Number.parseFloat(raw);
  if (raw.endsWith("px") && n > 0) return n;
  if (Number.isFinite(n) && n > 0 && /^[\d.]+$/.test(raw.trim()) && size > 0) return n * size;
  if (raw === "normal" && size > 0) return 1.2 * size;
  return TOP_LINE_FALLBACK_PX;
}

/** The panels inside a scroller, in document order, as the rule reads them. */
export function panelsOf(scroller: HTMLElement): ThreadPanel[] {
  return [...scroller.querySelectorAll<HTMLElement>("[data-conv-id]")].map((el) => {
    const from = el.querySelector(".msg-from");
    const first = from && cssRect(from).height > 0 ? box(from) : null;
    const mark = el.querySelector("[data-own-end]");
    const frame = el.querySelector("iframe.mb-frame");
    // A frame draws its end marker only once measured (until then its foot is the 150px default);
    // a body still standing in for its frame says so.
    const unmeasured = (!mark && frame !== null) || el.querySelector("[data-body-pending]") !== null;
    const block = el.querySelector(".msg-body, .pm-body");
    let lead: LineBox | null = null;
    let end: LineBox | null = null;
    if (block) {
      // THE FIRST LINES: from the body's top (a framed body's, the frame's) about three lines down, or
      // to its end where it is shorter — the whole of a short body is its top.
      const b = cssRect(block);
      const f = frame ? cssRect(frame) : null;
      const top = f ? f.top : b.top;
      const foot = f ? f.bottom : mark ? cssRect(mark).top : b.bottom;
      const lines = THREAD_TOP_LINES * lineHeightOf(block);
      lead = { top, bottom: Math.max(top, Math.min(top + lines, foot)) };
      const at = Math.max(top, foot);
      end = { top: at, bottom: at };
    }
    return {
      id: el.dataset.convId!,
      ready: el.hasAttribute("data-body-ready") && !unmeasured,
      height: cssRect(el).height,
      first,
      lead,
      end,
    };
  });
}

/** The scroller's visible box, its bottom above the sticky action bar or the reply dock. */
export function viewOf(scroller: HTMLElement): ThreadView {
  const top = cssRect(scroller).top;
  let bottom = top + scroller.clientHeight;
  for (const el of scroller.querySelectorAll(".msg-actions, .reply-dock")) {
    const r = cssRect(el);
    if (r.height > 0 && r.top > top && r.top < bottom) bottom = r.top;
  }
  return { top, bottom };
}

const unreadIn = (scroller: HTMLElement): Set<string> =>
  new Set([...scroller.querySelectorAll<HTMLElement>("[data-conv-id][data-unseen]")].map((el) => el.dataset.convId!));

const editable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");

const NOTHING: ReadonlySet<string> = new Set();

/** A verb, not reading: the bar, the reply dock, a menu, any button or field. */
const PRESS_CONTROL =
  ".msg-actions, .reply-dock, [role='menu'], button, [role='button'], [role='menuitem'], input, textarea, select, [contenteditable]";

/** Does a press here enter the visit: on a message's own panel (not a control in it), or on the scroller's own box (its scrollbar)? */
export function pressEnters(scroller: HTMLElement, target: EventTarget | null): boolean {
  if (target === scroller) return true;
  if (!(target instanceof Element) || !scroller.contains(target)) return false;
  const control = target.closest(PRESS_CONTROL);
  if (control !== null && scroller.contains(control)) return false;
  const panel = target.closest("[data-conv-id]");
  return panel !== null && scroller.contains(panel);
}

export function createThreadReadDom(o: ThreadReadDomOptions): ThreadReadDom {
  const { scroller, record } = o;
  const doc = scroller.ownerDocument;
  const win = doc.defaultView ?? window;
  const now = o.now ?? (() => threadReadTime.now());
  const frameHovered = o.frameHovered ?? (() => frameEngaged(scroller));
  const documentFocused = o.documentFocused ?? (() => doc.hasFocus());
  const visible = o.visible ?? (() => doc.visibilityState !== "hidden");
  const frame = o.frame ?? ((run: () => void) => nextFrame(win, run));
  const after = o.after ?? ((ms: number, run: () => void) => threadReadTime.after(ms, run));
  let live = true;
  let pending: (() => void) | null = null;
  let dwell: (() => void) | null = null;

  const never = Number.NEGATIVE_INFINITY;
  /** The person's own last input in the reader: a wheel, a touch, a press, a scroll of theirs. */
  let lastHand = never;
  /** Can the person be reading: the tab shown, and the window focused or under their hand just now. */
  const attended = (t: number): boolean => visible() && (documentFocused() || t - lastHand <= EVIDENCE_WINDOW_MS);

  const shapeOf = (panels: readonly ThreadPanel[]): string =>
    [scroller.scrollHeight, scroller.clientHeight, scroller.clientWidth, ...panels.map((p) => p.height)].join(",");
  /** The layout the previous look saw (the mount's, first); a look that finds it moved counts nothing. */
  let shape: string | null = shapeOf(panelsOf(scroller));
  /** A dwell under way is looked at again when it is done. */
  const schedule = (): void => {
    dwell?.();
    dwell = null;
    const due = record.due;
    if (due === null || !live) return;
    dwell = after(Math.max(0, due - now()) + 1, () => { dwell = null; poke(); });
  };
  const look = (): void => {
    pending = null;
    if (!live) return;
    const t = now();
    const view = attended(t) ? viewOf(scroller) : null;
    if (view === null || view.bottom - view.top <= 0) {
      // Nobody can be seeing this (or nothing is laid out): every dwell starts over.
      record.observe([], null, NOTHING, t);
      schedule();
      return;
    }
    const panels = panelsOf(scroller);
    const laid = shapeOf(panels);
    if (laid !== shape) {
      shape = laid;
      poke();
      return;
    }
    const ids = record.observe(panels, view, unreadIn(scroller), t);
    if (ids.length > 0) o.onRead(ids);
    schedule();
  };
  const poke = (): void => {
    if (!live || pending) return;
    pending = frame(look);
  };
  const enter = (): void => {
    lastHand = now();
    o.onEnter();
    poke();
  };

  /* THE REST (`restMs`): a landing looked at and not acted on is entered. A command — a key the app
     took, a press on a control — ends it for this landing; the window going away starts it over; a
     page modal standing over it (the palette, a dialog) keeps it from entering. */
  let resting = o.restMs !== undefined;
  let rest: (() => void) | null = null;
  const restable = (): boolean =>
    resting && live && !record.entered && visible() && documentFocused() && pageModal(doc) === null;
  /* The rest's and the stay's own timer, the wall clock's: never the dwell's (`after`), which a test passes by hand. */
  const wait = (ms: number, run: () => void): (() => void) => {
    const t = setTimeout(run, ms);
    return () => clearTimeout(t);
  };
  const armRest = (): void => {
    rest?.();
    rest = null;
    if (!restable()) return;
    rest = wait(o.restMs!, () => {
      rest = null;
      const v = viewOf(scroller);
      if (!restable() || v.bottom - v.top <= 0) return;
      resting = false;
      (o.onRest ?? o.onEnter)();
      poke();
    });
  };
  const endRest = (): void => {
    resting = false;
    rest?.();
    rest = null;
  };

  let lastEvidence = never;
  let lastFocus = never;
  let lastSelection = never;
  let lastKey = never;
  const geometry = (): readonly number[] => [scroller.scrollHeight, scroller.clientHeight, scroller.clientWidth];
  let geo = geometry();
  let lastResize = never;

  /** Was this scroll the person's? See the header. */
  const evidenced = (t: number, steady: boolean): boolean => {
    if (stampLive(scroller)) return false;
    if (t - lastResize <= EVIDENCE_WINDOW_MS || !steady) return false;
    if (t - lastEvidence <= EVIDENCE_WINDOW_MS) return true;
    const quiet = t - Math.max(lastFocus, lastSelection, lastKey) > EVIDENCE_WINDOW_MS;
    return quiet && frameHovered() && documentFocused();
  };
  const onHand = (): void => {
    lastEvidence = now();
    enter();
  };
  /* Bubbling on the window, after the app's own key map: a key it took is not a native scroll. */
  const onKeyFree = (e: KeyboardEvent): void => {
    // Only a key this adapter saw begin: the key that made the landing renders it mid-dispatch.
    if (e.defaultPrevented) { if (began.has(e)) endRest(); }
    else if (SCROLL_KEYS.has(e.key) && !editable(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) lastEvidence = now();
  };
  /* A key, a focus move or a selection change voids the evidence: what scrolls next may be theirs. */
  const began = new WeakSet<Event>();
  const onKeyAny = (e: Event): void => { began.add(e); lastKey = now(); lastEvidence = never; poke(); };
  const onFocus = (e: FocusEvent): void => {
    if (e.target === scroller) return;
    lastFocus = now();
    lastEvidence = never;
  };
  const selection = (): readonly unknown[] => {
    const sel = doc.getSelection();
    return sel ? [sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset] : [];
  };
  let lastSel = selection();
  const selectionMoved = (): boolean => {
    const next = selection();
    const moved = next.length !== lastSel.length || next.some((v, i) => v !== lastSel[i]);
    lastSel = next;
    return moved;
  };
  const onSelection = (): void => { lastSelection = now(); lastSel = selection(); lastEvidence = never; };
  const onResize = (): void => { lastResize = now(); poke(); };
  const onVisibility = (): void => { armRest(); poke(); };
  const onWindowFocus = (): void => { armRest(); poke(); };
  const onScroll = (): void => {
    const t = now();
    if (selectionMoved()) { lastSelection = t; lastEvidence = never; }
    const g = geometry();
    const human = evidenced(t, g.every((v, i) => v === geo[i]));
    geo = g;
    if (human) {
      o.onHumanScroll?.();
      enter();
    }
    poke();
  };

  const onPress = (e: Event): void => { if (pressEnters(scroller, e.target)) enter(); };
  const onTouch = (e: Event): void => { if (pressEnters(scroller, e.target)) onHand(); };
  /* A press on a control in the reader, or anywhere outside it (the list, a drag, the rail), ends the rest. */
  const onAnyPress = (e: Event): void => {
    const t = e.target;
    const inside = t instanceof Node && scroller.contains(t);
    if (!inside || (t instanceof Element && t.closest(PRESS_CONTROL) !== null)) endRest();
  };
  /* A drag enters through the scroll it makes, so a tap's jitter on the bar enters nothing. */
  const onDrag = (): void => { lastEvidence = now(); };

  const passive = { passive: true } as const;
  scroller.addEventListener("wheel", onHand, passive);
  scroller.addEventListener("touchstart", onTouch, passive);
  scroller.addEventListener("touchmove", onDrag, passive);
  scroller.addEventListener("pointerdown", onPress, passive);
  scroller.addEventListener("scroll", onScroll, passive);
  win.addEventListener("keydown", onKeyFree);
  win.addEventListener("keydown", onKeyAny, true);
  doc.addEventListener("pointerdown", onAnyPress, true);
  doc.addEventListener("touchstart", onAnyPress, true);
  doc.addEventListener("focusin", onFocus, true);
  doc.addEventListener("selectionchange", onSelection);
  doc.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("focus", onWindowFocus);
  win.addEventListener("blur", onWindowFocus);
  win.addEventListener("resize", onResize);
  const resized = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(poke);
  resized?.observe(scroller);
  for (const child of scroller.children) resized?.observe(child);
  const mutated = typeof MutationObserver === "undefined" ? null : new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n instanceof Element && n.parentElement === scroller) resized?.observe(n);
    poke();
  });
  mutated?.observe(scroller, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-unseen", "data-body-ready"] });
  armRest();
  let stay = o.restMs === undefined || !o.onStay ? null : wait(o.restMs, () => { stay = null; o.onStay!(); });
  poke();

  return {
    scroller,
    poke,
    dispose: () => {
      live = false;
      pending?.();
      pending = null;
      dwell?.();
      dwell = null;
      rest?.();
      rest = null;
      stay?.();
      stay = null;
      resized?.disconnect();
      mutated?.disconnect();
      scroller.removeEventListener("wheel", onHand);
      scroller.removeEventListener("touchstart", onTouch);
      scroller.removeEventListener("touchmove", onDrag);
      scroller.removeEventListener("pointerdown", onPress);
      scroller.removeEventListener("scroll", onScroll);
      win.removeEventListener("keydown", onKeyFree);
      win.removeEventListener("keydown", onKeyAny, true);
      doc.removeEventListener("pointerdown", onAnyPress, true);
      doc.removeEventListener("touchstart", onAnyPress, true);
      doc.removeEventListener("focusin", onFocus, true);
      doc.removeEventListener("selectionchange", onSelection);
      doc.removeEventListener("visibilitychange", onVisibility);
      win.removeEventListener("focus", onWindowFocus);
      win.removeEventListener("blur", onWindowFocus);
      win.removeEventListener("resize", onResize);
    },
  };
}

/** What a pane is handed where the rule runs: the visit's record and its two report-ups. */
export interface ThreadReadWiring {
  /** `"tint"`: the Ohbox's unread wash, squares and spoken "unread"; `"dot"`: the reader keeps its unread dot. */
  look: "tint" | "dot";
  record: ThreadRead;
  onRead: (ids: string[]) => void;
  onEnter: () => void;
  /** A panel's ⋯ Mark unread, by that panel's id. */
  onMarkUnread: (id: string) => void;
  /** The conversation's place, shared by the reader's squares and its list row's (`thread-walk-channel.ts`). */
  walk?: ThreadWalkChannel;
  /** A landing the rest may enter ({@link LANDING_REST_MS}); absent, only an open, a press or a hand scroll enters. */
  restMs?: number;
  /** A landing not entered yet: the panels ask for no embedded picture (a mailbox connection each). */
  previewing?: boolean;
  /** The cursor stayed the rest's length on this landing, entered or not. */
  onStay?: () => void;
}

/** The shell's `markSeen`, as a reader visit writes through it. */
export type ReaderMarkSeen = (ids: string[], unread: boolean, via?: "glance", readRow?: string) => unknown;

/**
 * THE VISIT OF A READER OFF THE OHBOX — Folder, History, a tag, the triage piles and the sheet over
 * them. One record per shown message, unentered until `enter` (an open, ↵, → into the column) or the
 * adapter's own press, wheel or hand scroll. `land` marks a visit a step key made (↓/↑, j/k): it is
 * entered once the cursor rests on it ({@link LANDING_REST_MS}). Any change of the shown id ends the
 * visit, its landing with it, and coming back starts over; an `enter` or a `land` for an id the next
 * commit does not show is dropped. Reads go out as glances naming the shown message as the row read
 * (`readRow`), so an Ohbox letter read here is an open read.
 */
export function useReaderVisit({ shown, markSeen }: {
  shown: EngineMessage | null;
  markSeen: ReaderMarkSeen;
}): { wiring: ThreadReadWiring | null; enter: (id: string) => void; land: (id: string) => void } {
  const records = useRef(new Map<string, ThreadRead>());
  const [, bump] = useState(0);
  const write = useRef(markSeen);
  write.current = markSeen;
  const shownId = shown?.id ?? null;
  const recordFor = (id: string): ThreadRead => {
    const r = records.current.get(id) ?? createThreadRead();
    records.current.set(id, r);
    return r;
  };
  useEffect(() => {
    for (const id of [...records.current.keys()]) if (id !== shownId) records.current.delete(id);
  });
  const enter = useCallback((id: string) => {
    const r = records.current.get(id) ?? createThreadRead();
    records.current.set(id, r);
    if (r.entered) return;
    r.enter(threadReadTime.now());
    bump((n) => n + 1);
  }, []);
  const landings = useRef(new WeakSet<ThreadRead>());
  const land = useCallback((id: string) => {
    const r = records.current.get(id) ?? createThreadRead();
    records.current.set(id, r);
    if (landings.current.has(r)) return;
    landings.current.add(r);
    bump((n) => n + 1);
  }, []);
  /** The landing the cursor stayed the rest's length on: its pictures load. */
  const [stayed, setStayed] = useState<ThreadRead | null>(null);
  const record = shownId === null ? null : recordFor(shownId);
  const landed = record !== null && landings.current.has(record);
  const entered = record?.entered ?? false;
  const wiring = useMemo<ThreadReadWiring | null>(() => (record === null || shownId === null ? null : {
    look: "dot",
    record,
    onEnter: () => enter(shownId),
    onRead: (ids) => { void write.current(ids, false, "glance", shownId); },
    onMarkUnread: (id) => {
      record.keepUnread(id);
      void write.current([id], true);
    },
    ...(landed ? { restMs: LANDING_REST_MS, previewing: !entered && stayed !== record, onStay: () => setStayed(record) } : {}),
  }), [record, shownId, enter, landed, entered, stayed]);
  return { wiring, enter, land };
}

/**
 * The adapter, mounted per record and scroller. Absent `wiring` (Trash, the Screener's preview, the
 * streams) mounts nothing. `entered` re-looks once the visit is entered from outside
 * (↵, a click on the row).
 */
export function useThreadRead({
  scroller, wiring, active, onHumanScroll,
}: {
  scroller?: RefObject<HTMLElement | null>;
  wiring?: ThreadReadWiring;
  active: boolean;
  onHumanScroll?: () => void;
}): void {
  const latest = useRef(wiring);
  latest.current = wiring;
  const human = useRef(onHumanScroll);
  human.current = onHumanScroll;
  const record = wiring?.record;
  const restMs = wiring?.restMs;
  const core = useRef<ThreadReadDom | null>(null);
  useEffect(() => {
    const el = scroller?.current;
    if (!active || !record || !el) return;
    const c = createThreadReadDom({
      scroller: el,
      record,
      onRead: (ids) => latest.current?.onRead(ids),
      onEnter: () => latest.current?.onEnter(),
      onHumanScroll: () => human.current?.(),
      restMs,
      onRest: () => { if (latest.current?.record === record) latest.current.onEnter(); },
      onStay: () => { if (latest.current?.record === record) latest.current.onStay?.(); },
    });
    core.current = c;
    return () => {
      if (core.current === c) core.current = null;
      c.dispose();
    };
  }, [scroller, record, active, restMs]);
  const entered = record?.entered ?? false;
  useEffect(() => {
    if (entered) core.current?.poke();
  }, [entered]);
}
