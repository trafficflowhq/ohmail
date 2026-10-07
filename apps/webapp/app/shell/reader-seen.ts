"use client";

import { useEffect, useRef, type RefObject } from "react";
import { DWELL_MS, EVIDENCE_WINDOW_MS, READING_LINE, atScrollEnd, dwellCommits } from "@ohmail/client-engine";
import { SCROLL_KEYS } from "@ohmail/ui";
import { stampLive } from "./programmatic-scroll";

/**
 * SCROLL-TO-READ IN THE READER — a sibling panel carrying `data-unseen` is read only when the PERSON
 * scrolls through it: rule A, a downward pass (its bottom was below the reading line at an earlier
 * scan of this open and an evidenced scroll carries it above); rule B, the dwell (`dwellCommits`:
 * the panel spanning the line, and at the scroll end every panel wholly in view). A scroll counts
 * only with EVIDENCE within a second before it (`evidenced`), voided by a later key, focus or
 * selection move: a wheel, touch or pointer press on the scroller, a scroll key the app did not
 * take, or a framed body under the pointer with no such move just before. A stamped app scroll, a
 * scroll while the geometry moved, or one in the second after a resize never counts. One per open.
 */

export { DWELL_MS, EVIDENCE_WINDOW_MS, READING_LINE };

export interface ReaderSeenOptions {
  scroller: HTMLElement;
  /** The opened message: never committed here. */
  openedId: string;
  onSeen: (id: string) => void;
  /** Every evidenced scroll — the thread anchor's handover rides the same authority. */
  onHumanScroll?: () => void;
  /** Is a framed body under the pointer? Injected in tests (jsdom has no `:hover`). */
  frameHovered?: () => boolean;
  /** Does this document hold focus, and is it on screen? Injected in tests. */
  documentFocused?: () => boolean;
  visible?: () => boolean;
  now?: () => number;
  line?: number;
  dwellMs?: number;
}

export interface ReaderSeen {
  readonly scroller: HTMLElement;
  dispose: () => void;
}

/**
 * THE FRAME CLAUSE'S POINTER. A wheel over a sandboxed mail frame reaches the frame's document, not
 * ours, and that document gets no listener (it runs no scripts); what reaches us is the scroller's
 * own `scroll`. The pointer resting on a frame is the only sign of the person there.
 */
export function frameEngaged(scroller: HTMLElement): boolean {
  try {
    return scroller.querySelector("iframe.mb-frame:hover") !== null;
  } catch {
    return false; // an engine without `:hover` in selectors answers no
  }
}

/** The scrollers a live core listens on — what a test asks to prove WHICH element is read. */
const live = new Set<HTMLElement>();
export const liveReaderSeenScrollers = (): HTMLElement[] => [...live];

const editable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT");

export function createReaderSeen(o: ReaderSeenOptions): ReaderSeen {
  const { scroller, openedId, onSeen } = o;
  const doc = scroller.ownerDocument;
  const win = doc.defaultView ?? window;
  const now = o.now ?? Date.now;
  const line = o.line ?? READING_LINE;
  const dwellMs = o.dwellMs ?? DWELL_MS;
  const frameHovered = o.frameHovered ?? (() => frameEngaged(scroller));
  const documentFocused = o.documentFocused ?? (() => doc.hasFocus());
  const visible = o.visible ?? (() => doc.visibilityState !== "hidden");
  /** Panels whose bottom a scan of this open found below the line — rule A's precondition. */
  const seenBelow = new Set<string>();
  const never = Number.NEGATIVE_INFINITY;
  /** The person's input on the scroller or a free scroll key; and the moves that end the frame clause. */
  let lastEvidence = never;
  let lastFocus = never;
  let lastSelection = never;
  let lastKey = never;
  /** The geometry at the last scroll: content height and the viewport's own size. */
  const geometry = (): readonly number[] => [scroller.scrollHeight, scroller.clientHeight, scroller.clientWidth];
  let geo = geometry();
  let lastResize = never;
  let dwell: ReturnType<typeof setTimeout> | null = null;

  const view = (): { top: number; bottom: number; line: number } => {
    const top = scroller.getBoundingClientRect().top;
    return { top, bottom: top + scroller.clientHeight, line: top + line * scroller.clientHeight };
  };
  const unseen = (): HTMLElement[] =>
    [...scroller.querySelectorAll<HTMLElement>("[data-conv-id][data-unseen]")]
      .filter((el) => el.dataset.convId !== openedId);

  /** Record what is below the line; on an evidenced scroll commit what it carried above (rule A). */
  const scan = (human: boolean): void => {
    const y = view().line;
    for (const el of unseen()) {
      const id = el.dataset.convId!;
      if (el.getBoundingClientRect().bottom > y) {
        seenBelow.add(id);
        continue;
      }
      if (human && seenBelow.has(id)) onSeen(id);
      seenBelow.delete(id);
    }
  };

  const cancelDwell = (): void => {
    if (dwell !== null) clearTimeout(dwell);
    dwell = null;
  };
  const armDwell = (): void => {
    cancelDwell();
    dwell = setTimeout(() => {
      dwell = null;
      if (!visible()) return;
      const boxes = unseen().map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.dataset.convId!, top: r.top, bottom: r.bottom };
      });
      const end = atScrollEnd(scroller.scrollTop, scroller.clientHeight, scroller.scrollHeight);
      for (const id of dwellCommits(boxes, view(), end)) onSeen(id);
    }, dwellMs);
  };

  /**
   * Was this scroll the person's? Never a stamped app write, never in the second after a window
   * resize, never while the geometry moved (content height or the viewport's size: a window
   * growing at the scroll end clamps the scroll with no input); then evidence or the frame clause.
   */
  const evidenced = (t: number, steady: boolean): boolean => {
    if (stampLive(scroller)) return false;
    if (t - lastResize <= EVIDENCE_WINDOW_MS || !steady) return false;
    if (t - lastEvidence <= EVIDENCE_WINDOW_MS) return true;
    const quiet = t - Math.max(lastFocus, lastSelection, lastKey) > EVIDENCE_WINDOW_MS;
    return quiet && frameHovered() && documentFocused();
  };

  const onInput = (): void => { lastEvidence = now(); };
  const onPointer = (e: PointerEvent): void => { if (e.target === scroller) lastEvidence = now(); };
  /* Bubbling on the window, after the app's own key map: a key it took is not a native scroll. */
  const onKeyFree = (e: KeyboardEvent): void => {
    if (!e.defaultPrevented && SCROLL_KEYS.has(e.key) && !editable(e.target) && !e.ctrlKey && !e.metaKey && !e.altKey) lastEvidence = now();
  };
  /* A key, a focus move or a selection change after the evidence voids it: what scrolls next may
     be theirs (Tab, a bare focus(), find). Focus landing on the scroller itself moves nothing. */
  const onKeyAny = (): void => { lastKey = now(); lastEvidence = never; };
  const onFocus = (e: FocusEvent): void => {
    if (e.target === scroller) return;
    lastFocus = now();
    lastEvidence = never;
  };
  /* The selection as it stands: WebKit's find can scroll before its `selectionchange` is dispatched,
     so each scroll also compares the selection itself with the last one seen. */
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
  const onVisibility = (): void => { if (!visible()) cancelDwell(); };
  const onResize = (): void => { lastResize = now(); cancelDwell(); };
  const onScroll = (): void => {
    const t = now();
    if (selectionMoved()) { lastSelection = t; lastEvidence = never; }
    const g = geometry();
    const human = evidenced(t, g.every((v, i) => v === geo[i]));
    geo = g;
    if (human) {
      o.onHumanScroll?.();
      armDwell();
    } else {
      cancelDwell();
    }
    scan(human);
  };

  const passive = { passive: true } as const;
  scroller.addEventListener("wheel", onInput, passive);
  scroller.addEventListener("touchstart", onInput, passive);
  scroller.addEventListener("touchmove", onInput, passive);
  scroller.addEventListener("pointerdown", onPointer, passive);
  scroller.addEventListener("scroll", onScroll, passive);
  win.addEventListener("keydown", onKeyFree);
  win.addEventListener("keydown", onKeyAny, true);
  doc.addEventListener("focusin", onFocus, true);
  doc.addEventListener("selectionchange", onSelection);
  doc.addEventListener("visibilitychange", onVisibility);
  win.addEventListener("resize", onResize);
  live.add(scroller);
  // The baseline: what the open put below the line. Commits nothing.
  scan(false);

  return {
    scroller,
    dispose: () => {
      cancelDwell();
      live.delete(scroller);
      scroller.removeEventListener("wheel", onInput);
      scroller.removeEventListener("touchstart", onInput);
      scroller.removeEventListener("touchmove", onInput);
      scroller.removeEventListener("pointerdown", onPointer);
      scroller.removeEventListener("scroll", onScroll);
      win.removeEventListener("keydown", onKeyFree);
      win.removeEventListener("keydown", onKeyAny, true);
      doc.removeEventListener("focusin", onFocus, true);
      doc.removeEventListener("selectionchange", onSelection);
      doc.removeEventListener("visibilitychange", onVisibility);
      win.removeEventListener("resize", onResize);
    },
  };
}

/**
 * The core, mounted per OPEN: a new message disposes it, so neither the attribution nor a panel's
 * record outlives the message it was made for. Absent `scroller` or `onSeen` (every surface but
 * the Ohbox's reading column and its sheet) mounts nothing.
 */
export function useReaderSeen({
  scroller, openedId, active, onSeen, onHumanScroll,
}: {
  scroller?: RefObject<HTMLElement | null>;
  openedId: string;
  active: boolean;
  onSeen?: (id: string) => void;
  onHumanScroll?: () => void;
}): void {
  const seen = useRef(onSeen);
  seen.current = onSeen;
  const human = useRef(onHumanScroll);
  human.current = onHumanScroll;
  const wired = onSeen !== undefined;
  useEffect(() => {
    const el = scroller?.current;
    if (!active || !wired || !el) return;
    const core = createReaderSeen({
      scroller: el,
      openedId,
      onSeen: (id) => seen.current?.(id),
      onHumanScroll: () => human.current?.(),
    });
    return core.dispose;
  }, [scroller, openedId, active, wired]);
}
