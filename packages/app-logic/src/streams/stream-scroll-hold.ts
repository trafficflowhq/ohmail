/**
 * THE ANCHOR HOLD, carried over from the web shell's `StreamShell`: a card that changes height above the reader moves
 * the scroll by the same amount in the same frame. The on-screen card is the anchor; each frame its offset is
 * predicted from the scroll since it was read, and any difference is content that moved on its own, absorbed at once
 * (drift under half a pixel is carried, not dropped). The loop runs inside a window opened by anything that can move
 * the content (a DOM edit, a scroll, a transition, an image's load, a resize, the tab shown) and closed
 * STREAM_HOLD_QUIET_MS after the last; never while the document is hidden. The card the reader opened is its own
 * anchor while it grows.
 */
import { cssRect } from "../geometry/index.js";
import type { StreamScrollCore } from "./stream-scroll-core.js";

/** How long the anchor-hold loop keeps running after the last thing that could move the content. */
export const STREAM_HOLD_QUIET_MS = 1000;

type Opened = { sid: string; until: number; h: number } | null;

/** The hold on one scroller; returns what lets it go. */
export function attachHold(core: StreamScrollCore, el: HTMLElement): () => void {
  if (typeof requestAnimationFrame === "undefined") return () => {};
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  const state = { opened: null as Opened, activeUntil: 0 };
  const hidden = (): boolean => doc.hidden;
  const pending = (c: Element | null | undefined): boolean =>
    !!c?.classList.contains(core.inputs.card.pending);

  /** The topmost card that has fully entered the scrollport; the opened card while it grows and straddles the top. */
  const pick = (rootTop: number): HTMLElement | null => {
    const opened = state.opened;
    if (opened) {
      const c = core.one(el, opened.sid);
      const r = c ? cssRect(c) : undefined;
      const live = Date.now() <= opened.until || pending(c);
      if (live && c && r && r.top < rootTop - 0.5 && r.bottom > rootTop) return c;
    }
    for (const c of core.all(el)) {
      if (cssRect(c).top >= rootTop - 0.5) return c;
    }
    return null;
  };
  const remember = (rootTop: number): void => {
    const c = pick(rootTop);
    core.holdAt = c ? { sid: core.idOf(c), offset: cssRect(c).top - rootTop, scrollTop: el.scrollTop } : null;
  };

  const frame = (): void => {
    if (hidden() || Date.now() > state.activeUntil) {
      core.holdRaf = 0;
      return;
    }
    core.holdRaf = requestAnimationFrame(frame);
    const rootRect = cssRect(el);
    if (rootRect.height <= 0) return; // detached, or a hidden tab: nothing to hold
    const held = core.holdAt;
    const card = held ? core.one(el, held.sid) : null;
    /* No anchor yet, or it left the pile or unmounted under the sliding window: take a new one. */
    if (core.inputs.seam?.edgeLanding?.() || !held || !card) {
      core.holdAcc = 0;
      remember(rootRect.top);
      return;
    }
    const offset = cssRect(card).top - rootRect.top;
    const drift = offset - (held.offset - (el.scrollTop - held.scrollTop));
    // A landing in flight re-measures its own card: drift it saw is not spent after it.
    core.holdAcc = core.jump ? 0 : core.holdAcc + drift;
    if (Math.abs(core.holdAcc) > 0.5) {
      const by = core.holdAcc;
      core.holdAt = { ...held, offset: held.offset + drift };
      core.holdAcc = 0;
      core.own(() => el.scrollTo({ top: el.scrollTop + by, behavior: "instant" }));
    }
    followOpened();
    /* Re-anchor every frame, from the state after any correction. */
    remember(rootRect.top);
  };
  const followOpened = (): void => {
    const opened = state.opened;
    if (!opened) return;
    const oc = core.one(el, opened.sid);
    const oh = oc ? cssRect(oc).height : -1;
    if (Math.abs(oh - opened.h) > 0.5)
      state.opened = { ...opened, h: oh, until: Date.now() + STREAM_HOLD_QUIET_MS };
    else if (Date.now() > opened.until && !pending(oc)) state.opened = null;
  };

  const arm = (): void => {
    if (hidden()) return;
    state.activeUntil = Date.now() + STREAM_HOLD_QUIET_MS;
    if (!core.holdRaf) core.holdRaf = requestAnimationFrame(frame);
  };
  const observer = typeof MutationObserver === "function" ? new MutationObserver(arm) : null;
  observer?.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
  const onEl = ["scroll", "transitionrun", "transitionend", "animationend"] as const;
  for (const kind of onEl) el.addEventListener(kind, arm, kind === "scroll" ? { passive: true } : undefined);
  el.addEventListener("load", arm, true);
  view?.addEventListener("resize", arm);
  doc.addEventListener("visibilitychange", arm);
  arm(); // mounting is a change: the first cards are arriving as this runs.
  /* The press, before its commit: the anchor is taken now, from the geometry the change moves away from. */
  core.toggledFn = (sid, open) => {
    const rootRect = cssRect(el);
    if (rootRect.height <= 0) return;
    if (open) {
      const c = core.one(el, sid);
      state.opened = { sid, until: Date.now() + STREAM_HOLD_QUIET_MS, h: c ? cssRect(c).height : -1 };
    } else if (state.opened?.sid === sid) {
      state.opened = null;
    }
    core.holdAcc = 0;
    remember(rootRect.top);
    arm();
  };

  return () => {
    if (core.holdRaf) cancelAnimationFrame(core.holdRaf);
    core.holdRaf = 0;
    state.activeUntil = 0;
    observer?.disconnect();
    for (const kind of onEl) el.removeEventListener(kind, arm);
    el.removeEventListener("load", arm, true);
    view?.removeEventListener("resize", arm);
    doc.removeEventListener("visibilitychange", arm);
    core.toggledFn = () => {};
    state.opened = null;
    core.holdAt = null;
    core.holdAcc = 0;
  };
}
