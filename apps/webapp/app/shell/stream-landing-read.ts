"use client";

import { EVIDENCE_WINDOW_MS, THREAD_TOP_LINES, createThreadRead, type LineBox, type ThreadPanel, type ThreadRead } from "@ohmail/client-engine";
import { cssRect } from "@ohmail/ui";
import { lineHeightOf, nextFrame, threadReadTime } from "./reader-seen";

/**
 * A News or Receipts letter opened from a search or address hit is read by the thread-read rule from
 * its landing, as an open in the Ohbox is: its first lines on screen for the dwell, and its sender
 * line (or the end of its text) seen. Only that card, written as a glance; the stream's own rules
 * keep the rest. Nothing counts while the tab is hidden or the window is not focused.
 */

export interface LandedCardOptions {
  scroller: HTMLElement;
  id: string;
  onRead: (id: string) => void;
  now?: () => number;
  frame?: (run: () => void) => () => void;
  after?: (ms: number, run: () => void) => () => void;
  documentFocused?: () => boolean;
  visible?: () => boolean;
}

const box = (el: Element | null): LineBox | null => {
  if (!el) return null;
  const r = cssRect(el);
  return r.height > 0 ? { top: r.top, bottom: r.bottom } : null;
};

/** A stream card as the rule reads it: the sender line, the clip's first lines and its foot. */
function cardPanel(card: HTMLElement, id: string): ThreadPanel {
  const clip = card.querySelector(".sc-clip");
  const c = clip ? cssRect(clip) : null;
  const laid = clip !== null && c !== null && c.height > 0;
  const lines = laid ? THREAD_TOP_LINES * lineHeightOf(card.querySelector(".sc-body, .sc-viewer") ?? clip) : 0;
  return {
    id,
    ready: !card.classList.contains("pend"),
    height: cssRect(card).height,
    first: box(card.querySelector(".sc-line")),
    lead: laid ? { top: c.top, bottom: Math.min(c.top + lines, c.bottom) } : null,
    end: laid ? { top: c.bottom, bottom: c.bottom } : null,
  };
}

/** Watch the landed card `id` until it turns read (`onRead`, once) or is read elsewhere. Returns the stop. */
export function readLandedCard(o: LandedCardOptions): () => void {
  const { scroller, id } = o;
  const doc = scroller.ownerDocument;
  const win = doc.defaultView ?? window;
  const now = o.now ?? (() => threadReadTime.now());
  const frame = o.frame ?? ((run: () => void) => nextFrame(win, run));
  const after = o.after ?? ((ms: number, run: () => void) => threadReadTime.after(ms, run));
  const documentFocused = o.documentFocused ?? (() => doc.hasFocus());
  const visible = o.visible ?? (() => doc.visibilityState !== "hidden");
  const record = createThreadRead();
  record.enter(now());
  let live = true;
  let pending: (() => void) | null = null;
  let dwell: (() => void) | null = null;
  const poke = (): void => {
    if (live && !pending) pending = frame(look);
  };
  // The body landing after the open scrolls nothing: its arrival (`.pend` gone) is a look of its own.
  const changes = typeof MutationObserver === "undefined" ? null : new MutationObserver(poke);
  const stop = (): void => {
    live = false;
    pending?.();
    dwell?.();
    changes?.disconnect();
    scroller.removeEventListener("scroll", poke);
    doc.removeEventListener("visibilitychange", poke);
    win.removeEventListener("focus", poke);
    win.removeEventListener("blur", poke);
  };
  function look(): void {
    pending = null;
    if (!live) return;
    const t = now();
    const card = [...scroller.querySelectorAll<HTMLElement>(".scast[data-sid]")].find((el) => el.dataset.sid === id);
    if (card && !card.hasAttribute("data-unseen")) return stop();
    const top = cssRect(scroller).top;
    const seen = visible() && documentFocused() && scroller.clientHeight > 0;
    const view = seen ? { top, bottom: top + scroller.clientHeight } : null;
    if (record.observe(card ? [cardPanel(card, id)] : [], view, new Set(card ? [id] : []), t).includes(id)) {
      stop();
      o.onRead(id);
      return;
    }
    dwell?.();
    dwell = null;
    const due = record.due;
    if (due !== null) dwell = after(Math.max(0, due - now()) + 1, () => { dwell = null; poke(); });
  }
  changes?.observe(scroller, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "data-unseen"] });
  scroller.addEventListener("scroll", poke, { passive: true });
  doc.addEventListener("visibilitychange", poke);
  win.addEventListener("focus", poke);
  win.addEventListener("blur", poke);
  poke();
  return stop;
}

/**
 * The same rule over every card of a News or Receipts visit, as the Ohbox reads a conversation: once the
 * reader has scrolled the stream (`driven`), pressed in it or opened a card, a card whose first lines stood
 * the dwell on screen, with its sender line or its end, turns read. Only cards on screen are measured
 * (an off-screen one would force its `content-visibility` layout); nothing counts unattended or while
 * `hold` says the frame is a flight. Fetches nothing.
 */
export interface StreamReadOptions {
  scroller: HTMLElement;
  record: ThreadRead;
  /** Has the reader scrolled the stream themselves (wheel, touch, a scroll key, a judged scroll)? */
  driven: () => boolean;
  /** "blind": nobody reads this frame (a flight); "again": look on the next frame instead. */
  hold?: () => "blind" | "again" | null;
  onRead: (ids: string[]) => void;
  /** Cards whose body is not in (`.pend`) that met the rule as if it were: never written live, read by the leave. */
  onReadPending?: (ids: string[]) => void;
  /** A card turned unread during the visit. */
  onUnread?: (id: string) => void;
  now?: () => number;
  frame?: (run: () => void) => () => void;
  after?: (ms: number, run: () => void) => () => void;
  documentFocused?: () => boolean;
  visible?: () => boolean;
}
export interface StreamRead {
  /** The reader opened a card by keyboard: the visit is entered. */
  enter: () => void;
  /** Have this card's first lines been wholly on screen at a look someone could see, this visit? */
  shown: (id: string) => boolean;
  stop: () => void;
}

const inView = (line: LineBox | null, view: { top: number; bottom: number }): boolean =>
  line !== null && line.top >= view.top - 0.5 && line.bottom <= view.bottom + 0.5;

/** A press here is a verb, not reading: the card's actions, notices, files, links, fields and menus. */
const VERB = ".msg-actions, .sc-notice, .sc-files, .sc-lead, a[href], input, textarea, select, [contenteditable], [role='menu'], [role='menuitem']";
function pressReads(scroller: HTMLElement, t: EventTarget | null): boolean {
  if (t === scroller) return true;
  if (!(t instanceof Element) || !scroller.contains(t)) return false;
  const verb = t.closest(VERB);
  if (verb && scroller.contains(verb)) return false;
  return t.closest(".scast[data-sid]") !== null;
}

export function readStreamCards(o: StreamReadOptions): StreamRead {
  const { scroller, record } = o;
  const doc = scroller.ownerDocument;
  const win = doc.defaultView ?? window;
  const now = o.now ?? (() => threadReadTime.now());
  const frame = o.frame ?? ((run: () => void) => nextFrame(win, run));
  const after = o.after ?? ((ms: number, run: () => void) => threadReadTime.after(ms, run));
  const documentFocused = o.documentFocused ?? (() => doc.hasFocus());
  const visible = o.visible ?? (() => doc.visibilityState !== "hidden");
  let live = true;
  let pending: (() => void) | null = null;
  let dwell: (() => void) | null = null;
  let lastHand = Number.NEGATIVE_INFINITY;
  const pend = createThreadRead();
  const firstShown = new Set<string>();
  // Nothing is looked at before the visit is entered: an idle stream queues no frame.
  const poke = (): void => {
    if (live && !pending && (record.entered || o.driven())) pending = frame(look);
  };
  const enter = (): void => {
    lastHand = now();
    record.enter(lastHand);
    pend.enter(lastHand);
    poke();
  };
  const schedule = (): void => {
    dwell?.();
    dwell = null;
    const due = Math.min(record.due ?? Infinity, pend.due ?? Infinity);
    if (due !== Infinity && live) dwell = after(Math.max(0, due - now()) + 1, () => { dwell = null; poke(); });
  };
  function look(): void {
    pending = null;
    if (!live) return;
    const held = o.hold?.() ?? null;
    const t = now();
    record.enter(t); // a drive enters the visit at its first look
    pend.enter(t);
    // A flight, or a frame the stream is about to put back: nobody reads it; look again on the next one.
    if (held !== null) {
      if (held === "blind") for (const r of [record, pend]) r.observe([], null, new Set(), t);
      poke();
      return;
    }
    const attended = visible() && (documentFocused() || t - lastHand <= EVIDENCE_WINDOW_MS) && scroller.clientHeight > 0;
    if (!attended) {
      for (const r of [record, pend]) r.observe([], null, new Set(), t);
      schedule();
      return;
    }
    const top = cssRect(scroller).top;
    const view = { top, bottom: top + scroller.clientHeight };
    const panels: ThreadPanel[] = [];
    const unread = new Set<string>();
    for (const card of scroller.querySelectorAll<HTMLElement>(".scast[data-sid]")) {
      const r = cssRect(card);
      if (r.bottom <= view.top || r.top >= view.bottom) continue;
      const id = card.dataset.sid!;
      const p = cardPanel(card, id);
      panels.push(p);
      if (inView(p.lead, view)) firstShown.add(id);
      if (card.hasAttribute("data-unseen")) unread.add(id);
    }
    const ids = record.observe(panels, view, unread, t);
    if (ids.length > 0) o.onRead(ids);
    const waiting = pend.observe(panels.filter((p) => !p.ready).map((p) => ({ ...p, ready: true })), view, unread, t);
    if (waiting.length > 0) o.onReadPending?.(waiting);
    schedule();
  }
  const onPress = (e: Event): void => { if (pressReads(scroller, e.target)) enter(); };
  // Enter or Space on a card's pill: a keyboard open (a script's click is not trusted).
  const onClick = (e: Event): void => { if (e.isTrusted && pressReads(scroller, e.target)) enter(); };
  // A press or Tab into a letter stays in the letter's document; the window only loses focus to it.
  const onBlur = (): void => {
    const a = doc.activeElement;
    if (a?.tagName === "IFRAME" && scroller.contains(a)) enter();
    else poke();
  };
  const onHand = (): void => { lastHand = now(); poke(); };
  // A card turned unread is kept unread for the visit, also before the visit is entered (no look yet).
  const onChange = (records: MutationRecord[]): void => {
    for (const r of records) {
      const card = r.target as HTMLElement;
      if (r.attributeName === "data-unseen" && r.oldValue === null && card.hasAttribute("data-unseen") && card.matches(".scast[data-sid]")) {
        record.keepUnread(card.dataset.sid!);
        pend.keepUnread(card.dataset.sid!);
        o.onUnread?.(card.dataset.sid!);
      }
    }
    poke();
  };
  const changes = typeof MutationObserver === "undefined" ? null : new MutationObserver(onChange);
  changes?.observe(scroller, { subtree: true, childList: true, attributes: true, attributeOldValue: true, attributeFilter: ["class", "data-unseen"] });
  scroller.addEventListener("scroll", poke, { passive: true });
  scroller.addEventListener("pointerdown", onPress, { passive: true });
  scroller.addEventListener("click", onClick);
  scroller.addEventListener("wheel", onHand, { passive: true });
  scroller.addEventListener("touchstart", onHand, { passive: true });
  doc.addEventListener("visibilitychange", poke);
  win.addEventListener("focus", poke);
  win.addEventListener("blur", onBlur);
  const stop = (): void => {
    live = false;
    pending?.();
    dwell?.();
    changes?.disconnect();
    scroller.removeEventListener("scroll", poke);
    scroller.removeEventListener("pointerdown", onPress);
    scroller.removeEventListener("click", onClick);
    scroller.removeEventListener("wheel", onHand);
    scroller.removeEventListener("touchstart", onHand);
    doc.removeEventListener("visibilitychange", poke);
    win.removeEventListener("focus", poke);
    win.removeEventListener("blur", onBlur);
  };
  return { enter, shown: (id) => firstShown.has(id), stop };
}
