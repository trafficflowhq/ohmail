"use client";

/**
 * ONE FOCUS RULE FOR THE SHELL. A sheet, dialog or menu that opens takes focus: its first control,
 * or itself when it has none. When it closes — by Escape, a verb or a finished action — focus goes
 * back to what opened it; when that is gone, to the row after it in the list, then the list itself.
 * An `aria-modal` surface keeps Tab and Shift+Tab inside. A focused control the page takes away
 * (a row's Done) lands the same way, so focus does not fall to the page body while a list stands.
 * Surfaces call {@link useFocusFollows}; the shell mounts {@link FocusFollows} once.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

const useCommitEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** A message row, and any list item a verb can take away. */
const ITEM = '.row[data-id], [role="listitem"]';
/** Where a focused control sat when it was a layer over the page. */
const LAYER = '[role="dialog"], [role="alertdialog"], [role="menu"], [aria-modal="true"]';
/** The surfaces that own the page while they stand: nothing behind one may take focus. */
const MODAL = '[aria-modal="true"], .reader';
const TABBABLE = [
  "a[href]", "button:not([disabled])", "input:not([disabled]):not([type=\"hidden\"])",
  "select:not([disabled])", "textarea:not([disabled])", "[tabindex]", "[contenteditable=\"true\"]",
].join(", ");

/** Where somebody was: the control, the row it stood in and the rows either side, and the list. */
interface Place {
  el: HTMLElement | null;
  row: HTMLElement | null;
  id: string | null;
  next: HTMLElement | null;
  nextId: string | null;
  prev: HTMLElement | null;
  prevId: string | null;
  list: HTMLElement | null;
  /** The layer it stood in, and that surface's own opener when the layer is one of ours. */
  layer: HTMLElement | null;
  parent: Place | null;
}

interface Surface { root: HTMLElement; opener: Place; seq: number }

const open: Surface[] = [];
let seq = 0;
let lastPress: Place | null = null;
let lastFocus: Place | null = null;
let returning = 0;

function showing(el: HTMLElement): boolean {
  if (el.hidden || el.getAttribute("aria-hidden") === "true") return false;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  return !style || (style.display !== "none" && style.visibility !== "hidden");
}

function tabbables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)]
    .filter((el) => el.tabIndex >= 0 && showing(el));
}

/* An app focus move never scrolls: a scroll it caused would read as the person's in the reader. */
function tryFocus(el: HTMLElement | null | undefined): boolean {
  if (!el || !el.isConnected) return false;
  el.focus({ preventScroll: true });
  return document.activeElement === el;
}

/** Into a surface: its first control, else the surface itself. */
function enterInto(root: HTMLElement, atRoot = false): boolean {
  if (!atRoot && tryFocus(tabbables(root)[0])) return true;
  if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
  return tryFocus(root);
}

function rowOf(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>(ITEM)
    ?? el.closest(".row-slot")?.querySelector<HTMLElement>(".row[data-id]") ?? null;
}

function rowById(id: string | null): HTMLElement | null {
  if (id === null) return null;
  for (const row of document.querySelectorAll<HTMLElement>(".row[data-id]")) {
    if (row.dataset.id === id) return row;
  }
  return null;
}

function cursorRow(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".view .row.sel");
}

function holderOf(el: HTMLElement | null): Surface | null {
  if (el === null) return null;
  for (let i = open.length - 1; i >= 0; i -= 1) if (open[i]!.root.contains(el)) return open[i]!;
  return null;
}

/** The place of a press or a focus. Nothing focused lands on the cursor's row, below (`land`). */
function placeOf(target: Element | null): Place {
  const el = target instanceof HTMLElement && target !== document.body ? target : null;
  const row = el ? rowOf(el) : null;
  const list = row?.closest<HTMLElement>('.scroller, [role="list"]') ?? null;
  let next: HTMLElement | null = null;
  let prev: HTMLElement | null = null;
  if (row && list) {
    const rows = [...list.querySelectorAll<HTMLElement>(ITEM)];
    const at = rows.indexOf(row);
    next = at >= 0 ? rows[at + 1] ?? null : null;
    prev = at > 0 ? rows[at - 1] ?? null : null;
  }
  return {
    el, row, list, next, prev,
    id: row?.dataset.id ?? null,
    nextId: next?.dataset.id ?? null,
    prevId: prev?.dataset.id ?? null,
    layer: el?.closest<HTMLElement>(LAYER) ?? null,
    parent: holderOf(el)?.opener ?? null,
  };
}

function standingModal(): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(MODAL)].filter(showing);
  return all[all.length - 1] ?? null;
}

/**
 * Land focus for a place. A return tries the opener first — a row stands for the list's cursor,
 * so a cursor that moved while the surface was open wins — then whose opener it had, then the
 * rows either side, the cursor's row, the list, and the view. A standing modal takes focus
 * itself before anything behind it can.
 */
function land(p: Place, returnTo: boolean): boolean {
  // A document whose root has unmounted has no body: there is nowhere left to put focus.
  if (document.body === null) return false;
  const modal = standingModal();
  const take = (el: HTMLElement | null | undefined): boolean =>
    el != null && el.isConnected && (modal === null || modal.contains(el))
    && (tryFocus(el) || tryFocus(tabbables(el)[0]));
  const chain: Place[] = [];
  for (let q: Place | null = p; q && !chain.includes(q); q = q.parent) chain.push(q);
  if (returnTo) {
    for (const q of chain) {
      const cursor = cursorRow();
      if (q.el !== null && q.el === q.row && cursor !== null && cursor !== q.el && take(cursor)) return true;
      if (take(q.el) || take(rowById(q.id))) return true;
    }
  } else if (p.layer?.isConnected && (modal === null || modal.contains(p.layer))) {
    return enterInto(p.layer);
  }
  for (const q of chain) {
    if (take(q.next) || take(rowById(q.nextId)) || take(q.prev) || take(rowById(q.prevId))) return true;
  }
  if (take(cursorRow()) || take(document.querySelector<HTMLElement>(".view .scroller"))) return true;
  if (returnTo && take(tabbables(document.querySelector<HTMLElement>(".view") ?? document.body)[0])) return true;
  return modal !== null && enterInto(modal);
}

function focusIsLost(): boolean {
  const now = document.activeElement;
  return now === null || now === document.body;
}

export interface FocusFollowsOptions {
  /** Open while truthy; default `true`, for a surface mounted only while it is open. A new
   *  value is a new surface (the same confirm, opened under another row). */
  active?: boolean | string | null;
  /** Take focus on open. `false` where the surface places focus itself (a composer, a strip);
   *  `"root"` on the surface itself, never its first control (a sheet the width raised). */
  enter?: boolean | "root";
  /** Close on Escape, pressed inside it or on the control that opened it. Only for a surface
   *  the shell's Escape ladder does not own. */
  onEscape?: () => void;
  /** Hold Tab inside while open, for a surface that covers the page and is not `aria-modal`
   *  (the navigation drawer, which stays a navigation landmark). */
  trap?: boolean;
}

/** The rule, for one surface. `ref` is its root; `aria-modal="true"` on it traps Tab. */
export function useFocusFollows(ref: RefObject<HTMLElement | null>, opts: FocusFollowsOptions = {}): void {
  const { active = true, enter = true, trap = false } = opts;
  const escape = useRef(opts.onEscape);
  escape.current = opts.onEscape;
  const closes = opts.onEscape !== undefined;
  useCommitEffect(() => {
    const root = ref.current;
    if (!active || root === null) return undefined;
    const pressed = lastPress?.el && !root.contains(lastPress.el) ? lastPress : null;
    const surface: Surface = { root, opener: pressed ?? placeOf(document.activeElement), seq: ++seq };
    open.push(surface);
    if (enter) {
      queueMicrotask(() => {
        if (root.isConnected && !root.contains(document.activeElement)) enterInto(root, enter === "root");
      });
    }
    const onTab = (e: KeyboardEvent): void => {
      if (e.key !== "Tab" || (!trap && root.getAttribute("aria-modal") !== "true")) return;
      e.preventDefault();
      const stops = tabbables(root);
      if (stops.length === 0) { tryFocus(root); return; }
      const at = stops.indexOf(document.activeElement as HTMLElement);
      const to = e.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : (at < 0 || at === stops.length - 1 ? 0 : at + 1);
      tryFocus(stops[to]);
    };
    const onEscape = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented || !(e.target instanceof Node)) return;
      // Read at the press: a windowed list can remount the surface while it stays open.
      if (!(ref.current ?? root).contains(e.target) && e.target !== surface.opener.el) return;
      e.preventDefault();
      e.stopPropagation();
      escape.current?.();
    };
    root.addEventListener("keydown", onTab);
    if (closes) document.addEventListener("keydown", onEscape, true);
    return () => {
      root.removeEventListener("keydown", onTab);
      if (closes) document.removeEventListener("keydown", onEscape, true);
      open.splice(open.indexOf(surface), 1);
      // Focus somebody moved elsewhere was moved on purpose; only a close that took it is answered.
      const had = document.activeElement;
      if (had !== null && had !== document.body && !root.contains(had)) return;
      const closedAt = seq;
      returning += 1;
      queueMicrotask(() => {
        returning -= 1;
        // A surface opened in the same breath (a sheet replaced by the one it opened) takes focus.
        if (open.some((s) => s.seq > closedAt) || !focusIsLost()) return;
        land(surface.opener, true);
      });
    };
  }, [active, enter, closes, trap, ref]);
}

/**
 * The shell's half, mounted once: where each press happened (the opener a surface records), and
 * the answer to a focused control the page removes. A blur leaves its element standing and is
 * left alone; only a removal is answered, after a surface's own return has had its turn.
 */
export function FocusFollows(): null {
  useEffect(() => {
    const onKey = (): void => { lastPress = placeOf(document.activeElement); };
    const onPress = (e: Event): void => {
      const target = e.target instanceof Element ? e.target.closest<HTMLElement>(TABBABLE) : null;
      lastPress = placeOf(target);
    };
    const onFocusIn = (e: FocusEvent): void => {
      lastFocus = e.target instanceof HTMLElement ? placeOf(e.target) : null;
    };
    const onFocusOut = (e: FocusEvent): void => {
      const left = e.target;
      queueMicrotask(() => {
        if (lastFocus?.el === left && left instanceof HTMLElement && left.isConnected
          && document.activeElement !== left) lastFocus = null;
      });
    };
    const observer = new MutationObserver(() => {
      const lost = lastFocus;
      if (lost?.el == null || lost.el.isConnected || returning > 0 || !focusIsLost()) return;
      lastFocus = null;
      land(lost, false);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPress, true);
    document.addEventListener("mousedown", onPress, true);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      observer.disconnect();
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPress, true);
      document.removeEventListener("mousedown", onPress, true);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      lastPress = null;
      lastFocus = null;
    };
  }, []);
  return null;
}
