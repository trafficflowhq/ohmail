"use client";

/**
 * ═══ DRAG-TO-FILE — a list row, dragged onto the rail ══════════════════════════════════════
 *
 * ONE SEMANTIC, NEW GESTURE. A drop dispatches exactly what the equivalent existing control
 * dispatches — the pill's Move / Later / Set aside / Resurface for one message, the bulk bar's
 * verbs for a selection, the tag picker's apply for a tag — through the very callbacks those
 * controls call. This module owns only the GESTURE: the movement threshold, the ghost, the
 * target highlight, the commit/cancel choreography. What a drop MEANS is the caller's, stated
 * once in `onDrop`, and nothing here mints a mutation of its own.
 *
 * ── POINTER EVENTS, NOT HTML5 DRAG-AND-DROP ────────────────────────────────────────────────
 *
 * The desktop shell runs this same file inside WKWebView and WebView2, where the HTML5 drag
 * events are unreliable (WKWebView in particular routes them through the OS drag machinery,
 * which a `WKWebView` without file-drop entitlements answers inconsistently). Pointer events
 * are plain input: they work identically in every browser this shell ships in, they give the
 * threshold test for free, and nothing here depends on an API a desktop WebView lacks —
 * `document.elementFromPoint` is the one lookup, and it is read optionally (absent means
 * "over nothing", which is also what a browser answers between targets).
 *
 * ── THE GESTURE MUST NOT TAX THE LIST ──────────────────────────────────────────────────────
 *
 * Until the pointer has really MOVED (`DRAG_SLOP_PX`), nothing happens: no preventDefault, no
 * state, no render — a press that ends inside the slop is a plain click and takes the row's
 * own path. Past the threshold the whole gesture lives outside React: the ghost is an
 * imperative DOM node moved by `transform`, the highlight is a class toggled on the rail row
 * under the pointer, and the ONLY React work is the final `onDrop`. j/k, the dwell, the seen
 * sweep and the stream window never see any of it.
 *
 * TOUCH IS EXCLUDED on purpose: with a finger, dragging a list is scrolling it, and the rail
 * is hidden behind a drawer at those widths anyway. Mouse and pen only.
 *
 * ── WHICH RAIL ROWS ARE TARGETS ────────────────────────────────────────────────────────────
 *
 * The places a message can be FILED, and nothing else: the three stream piles (the pill's
 * `move:` destinations that have a rail row), the three triage horizons (the pill's own "Not
 * now" verbs), and the tags (the picker's apply). The Screener row is deliberately not one —
 * screening is a consent decision about SENDERS with a confirm ceremony of its own, the same
 * reason `BulkAction` excludes it. History, Search, Drafts and Settings are not places mail
 * is filed. A row outside the map never lights and never accepts.
 *
 * Legality mirrors the existing controls' own enablement (`dropLegal`): the move panel
 * excludes the message's current folder, a horizon the message is already resting in is not
 * an answer, and a tag every dragged message already carries has nothing left to apply. Over
 * a set the question is "would this change anything at all" — the same rule the bulk move
 * and `bulkToggleTag` apply by skipping members that already agree.
 */

import { useCallback, useEffect, useRef } from "react";
import { FOLDER_OF_VIEW, type EngineMessage } from "@ohmail/client-engine";
import type { MoveTarget } from "./MessagePane";

/** How far the pointer must travel before a press becomes a drag. */
export const DRAG_SLOP_PX = 6;

/** How long the landed target keeps its confirmation before releasing. */
const DROP_HIT_MS = 360;

/** The spring-back's travel time — matches the row-settle register (`SETTLE_MS` is 280). */
const SPRING_MS = 220;

/**
 * A pile drop's action, in the EXISTING vocabulary: every member is both a `MessageAction`
 * and a `BulkAction`, which is the structural half of "one semantic, new gesture" — there is
 * no drop verb the pill and the bulk bar cannot already say.
 */
export type PileDropAction = "later" | "aside" | "resurface" | `move:${MoveTarget}`;

export type RailDropTarget =
  | { kind: "pile"; action: PileDropAction }
  | { kind: "tag"; tagId: string };

/** What travels with a drag: the messages it stands for, and what the ghost says. */
export interface DragSource {
  /** The message ids the drop will act on — the whole selection when the row is in it. */
  ids: string[];
  /** The same messages, for legality — folder, triage state, labels. */
  messages: EngineMessage[];
  /** The ghost's two lines — what the ROW shows, so the ghost is the row in hand. */
  label: { from: string; subject: string };
  /** True when `ids` is a live multi-select (the drop then also clears it). */
  selection: boolean;
}

/** The rail rows that file, and what filing there says. See the header for the exclusions. */
const PILE_ACTION_OF_RAIL: Record<string, PileDropAction> = {
  ohbox: "move:ohbox",
  reads: "move:reads",
  receipts: "move:receipts",
  triage: "later",
  "triage-aside": "aside",
  "triage-resurface": "resurface",
};

/** The triage state each horizon rests in — the pill's own mapping (`AppShell`). */
const TRIAGE_STATE_OF_ACTION: Record<"later" | "aside" | "resurface", string> = {
  later: "reply_later",
  aside: "set_aside",
  resurface: "bubbled_up",
};

/**
 * The drop target under `el`, or null for everything that is not one.
 *
 * Reads the rail's own `data-rail-id` (stamped by `RailNav` on every nav row) and
 * `data-rail-tag-id` (its tag rows), so the answer comes from the rendered rail rather than
 * from a second list of what the rail contains.
 */
export function railDropTargetOf(el: Element): { el: HTMLElement; target: RailDropTarget } | null {
  const hit = el.closest<HTMLElement>("[data-rail-id],[data-rail-tag-id]");
  if (!hit) return null;
  const tagId = hit.dataset.railTagId;
  if (tagId) return { el: hit, target: { kind: "tag", tagId } };
  const action = PILE_ACTION_OF_RAIL[hit.dataset.railId ?? ""];
  return action ? { el: hit, target: { kind: "pile", action } } : null;
}

/**
 * Would this drop change anything? — the existing controls' enablement, over a set.
 *
 * `some` and not `every`, because that is what the controls themselves do with a mixed set:
 * the bulk move dispatches for the members whose folder differs and skips the rest, and
 * `bulkToggleTag` applies to the members that lack the tag. A target where at least one
 * member would change is a real offer; one where none would is not.
 */
export function dropLegal(
  target: RailDropTarget,
  messages: ReadonlyArray<Pick<EngineMessage, "folder" | "triage" | "labels">>,
): boolean {
  if (messages.length === 0) return false;
  if (target.kind === "tag") {
    return messages.some((m) => !m.labels.includes(target.tagId));
  }
  const action = target.action;
  if (action.startsWith("move:")) {
    const folder = FOLDER_OF_VIEW[action.slice("move:".length) as MoveTarget];
    return folder != null && messages.some((m) => m.folder !== folder);
  }
  const state = TRIAGE_STATE_OF_ACTION[action as "later" | "aside" | "resurface"];
  return messages.some((m) => (m.triage?.state ?? null) !== state);
}

/* ── the gesture ──────────────────────────────────────────────────────────────────────── */

/** The minimal shape of a pointer event the gesture reads — see the hook for why. */
interface PointerLike {
  button: number;
  clientX: number;
  clientY: number;
  pointerType?: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: EventTarget | null;
}

interface Gesture {
  rowEl: HTMLElement;
  rowId: string;
  startX: number;
  startY: number;
  /** Resolved at the threshold, not at the press — a press that stays a click resolves nothing. */
  source: DragSource | null;
  dragging: boolean;
  /** Escape was pressed: swallow everything until the release, dispatch nothing. */
  cancelled: boolean;
  ghost: HTMLElement | null;
  over: { el: HTMLElement; target: RailDropTarget } | null;
  legal: boolean;
  reducedMotion: boolean;
}

/** Does this device ask for no motion? Read per gesture — cheap, and it can change. */
function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  } catch {
    return false;
  }
}

/** The element under the pointer — optional on purpose; absent reads as "over nothing". */
function elementAt(x: number, y: number): Element | null {
  const from = (document as { elementFromPoint?: (x: number, y: number) => Element | null })
    .elementFromPoint;
  return typeof from === "function" ? from.call(document, x, y) : null;
}

function buildGhost(source: DragSource): HTMLElement {
  const g = document.createElement("div");
  g.className = "drag-ghost";
  g.setAttribute("aria-hidden", "true");
  if (source.ids.length > 1) {
    const count = document.createElement("span");
    count.className = "dg-count num";
    count.textContent = String(source.ids.length);
    g.appendChild(count);
  }
  const from = document.createElement("span");
  from.className = "dg-from";
  from.textContent = source.label.from;
  const subj = document.createElement("span");
  subj.className = "dg-subj";
  subj.textContent = source.label.subject;
  g.append(from, subj);
  return g;
}

function placeGhost(g: HTMLElement, x: number, y: number): void {
  // Beside the pointer, not under it: the hit test must find the rail, never the ghost
  // (`pointer-events:none` guards that too — this offset is so the TEXT is readable).
  g.style.transform = `translate3d(${x + 14}px, ${y + 10}px, 0)`;
}

/**
 * Swallow the click a finished drag's release produces — once.
 *
 * A press that became a drag has been answered by the drop (or the cancel); letting the
 * release ALSO click the row would open the message that was just filed. The listener is a
 * window-capture one-shot so it runs before React's root handlers, and it disarms on the
 * next task in case no click follows at all (a release outside the window), so it can never
 * eat a later, genuine click.
 */
function suppressNextClick(): void {
  const eat = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();
    disarm();
  };
  const disarm = (): void => {
    window.removeEventListener("click", eat, true);
    window.clearTimeout(timer);
  };
  window.addEventListener("click", eat, true);
  const timer = window.setTimeout(disarm, 0);
}

export interface DragToFile {
  /** Attach on the list surface (capture): starts watching a press on `.row[data-id]`. */
  onPointerDown: (e: PointerLike) => void;
}

/**
 * The gesture, wired to a list.
 *
 * `sourceFor` answers what a row's drag stands for (the whole selection when the row is in
 * it; null refuses the drag), and `onDrop` is the dispatch — both live in the view, where
 * the selection and the existing verbs already are. Both are read through a ref at use time,
 * so the gesture never runs a stale closure and the caller memoises nothing.
 */
export function useDragToFile(opts: {
  sourceFor: (rowId: string) => DragSource | null;
  onDrop: (target: RailDropTarget, source: DragSource) => void;
}): DragToFile {
  const latest = useRef(opts);
  latest.current = opts;

  const gestureRef = useRef<Gesture | null>(null);
  /** Every ghost this hook put in the DOM and has not yet removed (a spring-back outlives its gesture). */
  const ghosts = useRef<Set<HTMLElement>>(new Set());
  /** Listener teardown for the gesture in flight. */
  const detach = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      // Unmount mid-gesture: take every trace out of the document, instantly.
      detach.current?.();
      const g = gestureRef.current;
      if (g?.over) g.over.el.classList.remove("drop-ok");
      gestureRef.current = null;
      for (const el of ghosts.current) el.remove();
      ghosts.current.clear();
      document.body.classList.remove("dnd-active");
    };
  }, []);

  const removeGhost = useCallback((el: HTMLElement): void => {
    el.remove();
    ghosts.current.delete(el);
  }, []);

  /** The ghost's exit on cancel or an illegal drop: back to the row it came from. */
  const springBack = useCallback(
    (g: Gesture): void => {
      const ghostEl = g.ghost;
      g.ghost = null;
      if (!ghostEl) return;
      if (g.reducedMotion || !ghostEl.isConnected) {
        removeGhost(ghostEl);
        return;
      }
      const r = g.rowEl.isConnected ? g.rowEl.getBoundingClientRect() : null;
      ghostEl.style.transition = `transform ${SPRING_MS}ms var(--swift), opacity ${SPRING_MS}ms var(--swift)`;
      if (r) ghostEl.style.transform = `translate3d(${r.left + 8}px, ${r.top + 6}px, 0)`;
      ghostEl.style.opacity = "0";
      const done = (): void => removeGhost(ghostEl);
      ghostEl.addEventListener("transitionend", done, { once: true });
      window.setTimeout(done, SPRING_MS + 80);
    },
    [removeGhost],
  );

  /** The ghost's exit on a landed drop: it settles where it is, quietly. */
  const settleGhost = useCallback(
    (g: Gesture): void => {
      const ghostEl = g.ghost;
      g.ghost = null;
      if (!ghostEl) return;
      if (g.reducedMotion) {
        removeGhost(ghostEl);
        return;
      }
      ghostEl.style.transition = `opacity 140ms var(--swift)`;
      ghostEl.style.opacity = "0";
      const done = (): void => removeGhost(ghostEl);
      ghostEl.addEventListener("transitionend", done, { once: true });
      window.setTimeout(done, 200);
    },
    [removeGhost],
  );

  const onPointerDown = useCallback(
    (e: PointerLike): void => {
      if (gestureRef.current) return;
      if (e.button !== 0) return;
      // A finger dragging a list is scrolling it; shift is the range-pick.
      if (e.pointerType === "touch") return;
      if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      const rowEl = (e.target as Element | null)?.closest?.<HTMLElement>(".row[data-id]") ?? null;
      const rowId = rowEl?.dataset.id;
      if (!rowEl || !rowId) return;

      const g: Gesture = {
        rowEl,
        rowId,
        startX: e.clientX,
        startY: e.clientY,
        source: null,
        dragging: false,
        cancelled: false,
        ghost: null,
        over: null,
        legal: false,
        reducedMotion: prefersReducedMotion(),
      };
      gestureRef.current = g;

      const clearHighlight = (): void => {
        if (g.over) g.over.el.classList.remove("drop-ok");
        g.over = null;
        g.legal = false;
      };

      const teardown = (): void => {
        detach.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKey, true);
        document.body.classList.remove("dnd-active");
        gestureRef.current = null;
      };

      const onMove = (ev: Event): void => {
        const p = ev as unknown as PointerLike;
        if (g.cancelled) return;
        if (!g.dragging) {
          if (Math.hypot(p.clientX - g.startX, p.clientY - g.startY) < DRAG_SLOP_PX) return;
          const source = latest.current.sourceFor(g.rowId);
          if (!source || source.ids.length === 0) {
            teardown();
            return;
          }
          g.source = source;
          g.dragging = true;
          g.ghost = buildGhost(source);
          ghosts.current.add(g.ghost);
          document.body.appendChild(g.ghost);
          document.body.classList.add("dnd-active");
        }
        placeGhost(g.ghost!, p.clientX, p.clientY);
        const under = elementAt(p.clientX, p.clientY);
        const hit = under ? railDropTargetOf(under) : null;
        if (hit?.el !== g.over?.el) {
          clearHighlight();
          if (hit && dropLegal(hit.target, g.source!.messages)) {
            g.over = hit;
            g.legal = true;
          }
        }
        // A target lights ONLY when the drop is legal — an illegal one stays quiet rather
        // than lighting red: the gesture is an offer, not a scold. Re-asserted on EVERY
        // move, not just on target change, because the class is imperative and the rail is
        // React's: a re-render of the row mid-drag (a live count ticking, the hover reveal
        // swapping the count for a keycap) rewrites `className` and would wipe a class
        // applied once. One idempotent `classList.add` per move is the whole cost.
        if (g.over && g.legal) g.over.el.classList.add("drop-ok");
      };

      const onUp = (): void => {
        const wasDragging = g.dragging;
        const over = g.over;
        const legal = g.legal;
        clearHighlight();
        teardown();
        if (!wasDragging) return; // a plain click; the row's own handler answers it.
        suppressNextClick();
        if (!g.cancelled && over && legal && g.source) {
          // Commit: the target confirms briefly, the ghost settles, the DISPATCH is the
          // caller's existing verb — nothing here writes anything.
          over.el.classList.add("drop-hit");
          window.setTimeout(() => over.el.classList.remove("drop-hit"), DROP_HIT_MS);
          settleGhost(g);
          latest.current.onDrop(over.target, g.source);
        } else {
          springBack(g);
        }
      };

      const onCancel = (): void => {
        clearHighlight();
        const ghostEl = g.ghost;
        g.ghost = null;
        if (ghostEl) removeGhost(ghostEl);
        teardown();
      };

      const onKey = (ev: KeyboardEvent): void => {
        if (ev.key !== "Escape" || !g.dragging || g.cancelled) return;
        // The drag is the innermost open thing: its Escape must not also clear a
        // selection or close a sheet. Capture on window runs before the registry's
        // document listener, so stopping it here is the whole of the precedence.
        ev.preventDefault();
        ev.stopPropagation();
        g.cancelled = true;
        clearHighlight();
        springBack(g);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKey, true);
      detach.current = teardown;
    },
    [springBack, settleGhost, removeGhost],
  );

  return { onPointerDown };
}
