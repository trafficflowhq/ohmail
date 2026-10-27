"use client";

import { THREAD_TOP_LINES, createThreadRead, type LineBox, type ThreadPanel } from "@ohmail/client-engine";
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
