"use client";

/**
 * THE SPATIAL MODEL — three focus zones, walked with the arrow keys.
 *
 *     menu rail   ←→   list   ←→   open message
 *
 * ← and → move BETWEEN zones, ↑/↓ move WITHIN one, Enter activates, Escape walks back left.
 * The list is the resting zone; the rail and the open message are places you step into and
 * out of. Every view that wants the model declares it with {@link useZoneNav}, exactly as
 * views declare their keys into the registry — this file adds NO listener of its own beyond
 * the two focus observers below, and every key it handles is an ordinary `KeyBinding`
 * dispatched by `keymap.tsx`, so the `?` sheet documents the zone keys because they exist
 * and existing single-key shortcuts keep their precedence over them (view layers are
 * consulted before these `global`-scope bindings).
 *
 * ── THE ZONE IS DERIVED FROM REAL FOCUS, NOT KEPT AS PARALLEL STATE ─────────────────────
 *
 * "Which zone am I in" has one honest answer: where the browser's focus actually is. A
 * stored zone flag would need resynchronising after every click, tap, Tab and programmatic
 * focus move, and each missed one would leave the arrows acting on a zone the user can see
 * they are not in. So the zone is COMPUTED — focus inside `.rail` is the rail, focus inside
 * the mounted view's open-message container (each view names its own, e.g.
 * `.view-ohbox .read-col`) is the reader, and everything else, `document.body` included, is
 * the list. Entering a zone is nothing more than moving real focus into it, which is also
 * the whole accessibility story: the rail rows and list rows are real `<button>`s, the
 * reading column is a labelled region with `tabIndex={-1}`, and a screen reader announces
 * every move because every move is a genuine focus change. `:focus-visible` (base.css)
 * paints the ring, in both themes, for free.
 *
 * Deriving from focus also self-guards the widths where a zone does not exist: `focus()`
 * on a `display:none` element is refused by the browser, so stepping into a hidden rail
 * (the sub-900px drawer) or a hidden reading column simply does not move — no media query
 * here, no second copy of the layout's breakpoints. Where the reading column is hidden the
 * view supplies `onHiddenEnter`, which is its deliberate open (the reader sheet), because
 * at that width "into the message" and "open the message" are the same request.
 *
 * ── TEXT INPUTS ARE NEVER TOUCHED ────────────────────────────────────────────────────────
 *
 * No binding here sets `inInput`, so the registry's typing guard applies: arrows inside
 * compose, search or any other field keep their native caret behaviour, and the zone model
 * only speaks when the rail, the list or the pane owns focus.
 *
 * ── READ-MARKING IS THE VIEW'S, ON THE SEAM THAT ALREADY SHIPPED ─────────────────────────
 *
 * Arrow selection in the Ohbox rides `selectByUser`, so the dwell guard (`DWELL_MS`,
 * `OhboxView.tsx` — armed on the cursor, cancelled by the next move, committed as a labelled
 * `"glance"` on departure) applies to a flick through five messages exactly as it applies to
 * j/k: nothing is marked until the reader actually stays. Stepping INTO the message with →
 * is explicit engagement, so the view arms its read in `onEnter` — the same arm an open
 * performs, never a second write path.
 */
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { isTypingTarget, useOptionalKeyBindings, type KeyBinding } from "./keymap";

/**
 * `"none"` is the fourth answer: a dialog is layered ABOVE the open reader (a screening
 * panel, a popover) and owns its own keys — every zone binding stands down rather than
 * scrolling an obscured sheet or walking a buried list. It exists only while a reader
 * overlay and a higher layer are BOTH standing; everywhere else the three spatial zones
 * partition the screen.
 */
export type Zone = "rail" | "list" | "reader" | "none";

/**
 * How far one ↑/↓ press moves the open message, in px.
 *
 * 48 = three 16px text lines — Firefox's native arrow-scroll unit, within a few px of
 * Chrome's 40. Small enough that a held key reads as continuous text flow rather than
 * jumps, big enough that a single press visibly moves. Applied as an instant `scrollTop`
 * assignment (`MessagePane` prefers the same primitive) so key-repeat never queues smooth
 * animations against each other. A thread needs no extra "next message" step: the
 * conversation is one flat column of full-body panels in one scroller
 * (`ConversationPanels`), so scrolling past the end of one message IS arriving at the next.
 */
export const READER_SCROLL_STEP = 48;

const RAIL = ".rail";

/* ── the derived zone, as an external store ──────────────────────────────────────────────
   Module-level rather than context so the views (which declare bindings) and any future
   reader of `currentZone` share one derivation without a provider mounted above them — the
   same reason the keymap keeps one listener. `readerGeography` is the mounted view's
   open-message selector; exactly one view is mounted at a time, so a plain slot is the
   honest shape and a registry of them would imply a concurrency that cannot occur. */
let readerGeography: string | null = null;
let zone: Zone = "list";
const subscribers = new Set<() => void>();

/**
 * The shell's full-screen reader sheet. Its EXISTENCE decides the zone, not focus inside it:
 * the sheet opens without taking focus (↑/↓ could not scroll the visible
 * sheet until the user first tabbed into it), so while it stands the zone IS "reader",
 * wherever the opening gesture left the caret. The two bindings that would move focus into
 * the surfaces UNDER the sheet keep a dispatch-time gate (`noReaderOverlay`) — every other
 * rail/list key is already declared inert by the zone itself.
 */
const READER_OVERLAY = ".reader";
function noReaderOverlay(): boolean {
  return typeof document === "undefined" || document.querySelector(READER_OVERLAY) == null;
}

function computeZone(): Zone {
  if (typeof document === "undefined") return "list";
  const el = document.activeElement;
  const sheet = document.querySelector(READER_OVERLAY);
  if (sheet) {
    // The sheet owns the screen — unless something is layered ABOVE it. Document order is
    // half the layering truth: the shell renders every higher surface (screening panels,
    // popovers, the tag picker) AFTER the reader element, so only focus in a node the sheet
    // PRECEDES can be a layer above it. The other half is that the node
    // must BE a layer: an expired Undo toast keeps an invisible, still-focusable button
    // mounted after the whole shell (`role="status"`, opacity 0 — undo-window.test.ts), and
    // Tab landing there must not silence the visible reader. Every genuine
    // higher surface here is a dialog or menu and carries the role — the shell's own a11y
    // rule, leaned on rather than a second list of overlay class names. Focus in a layer
    // suspends the walk whole ("none"); everything else leaves the sheet in charge.
    if (!(el instanceof Element) || el === document.body) return "reader";
    if (sheet.contains(el)) return "reader";
    const pos = sheet.compareDocumentPosition(el);
    if ((pos & Node.DOCUMENT_POSITION_PRECEDING) !== 0) return "reader";
    return el.closest('[role="dialog"], [role="alertdialog"], [role="menu"]') ? "none" : "reader";
  }
  if (!(el instanceof Element) || el === document.body) return "list";
  if (el.closest(RAIL)) return "rail";
  if (readerGeography && el.closest(readerGeography)) return "reader";
  return "list";
}

/**
 * THE MOBILE DRAWER IS OFF-CANVAS BY TRANSFORM, NOT `display:none` — so the focus-refusal
 * guard that protects every other hidden surface here does not fire: a translated button
 * accepts `focus()` happily, and ← from the list would put real focus into a drawer nobody
 * can see, without opening it. The same 900px question the views' `readColumnHidden()` asks,
 * plus the drawer's own open flag (`.rail.open`, set by the shell) — entering the rail by
 * key is allowed exactly where the rail is on screen.
 */
function railHidden(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  if (!window.matchMedia("(max-width: 900px)").matches) return false;
  return document.querySelector(`${RAIL}.open`) == null;
}

function refresh(): void {
  const next = computeZone();
  if (next === zone) return;
  zone = next;
  for (const notify of subscribers) notify();
}

function subscribe(notify: () => void): () => void {
  subscribers.add(notify);
  return () => subscribers.delete(notify);
}

export function currentZone(): Zone {
  return zone;
}

/** The zone, live — re-renders the caller when focus crosses a zone boundary. */
export function useZone(): Zone {
  return useSyncExternalStore(subscribe, currentZone, () => "list");
}

/**
 * FOCUS-BORDER-AS-CURSOR, THE MECHANISM (ohmarchy Phase 1) — the derived zone, REFLECTED
 * ONTO THE DOCUMENT so CSS can paint which tile the keys land in. The deep prototype does
 * exactly this (`document.documentElement.dataset.tile`), and the shipping shell adopts the
 * same surface: `:root[data-zone="rail"|"list"|"reader"|"none"]`.
 *
 * `data-zone` is FOCUS STATE, not appearance — it names where the keys land, which is one
 * fact in every theme. How LOUDLY a theme paints it is the appearance side, and that rides
 * the contract's tokens alone (OHMARCHY-CONTRACT.md: teaching intensity is the `--teach`
 * token, focus loudness `--focus-w`/`--focus-offset`, all defined in the token stylesheet's
 * face blocks) — paper's quiet reading is `zone-cursor.css`; the ohmarchy face re-resolves
 * the same rules through its own token values. Tokens change, the mechanism does not (the
 * one-UI law: teaching intensity is a parameter, never a fork).
 *
 * A component rather than an effect in `AppShell` so the subscription re-renders NOTHING —
 * it returns null and writes the attribute imperatively, the way the store itself is
 * module-level: a focus crossing must not re-render a six-thousand-line shell to move one
 * attribute.
 */
export function ZoneCursor(): null {
  const zone = useZone();
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-zone", zone);
    return () => {
      root.removeAttribute("data-zone");
    };
  }, [zone]);
  /* The cursor keeps the DERIVATION live even where no view declares a zone config: the
     focus observers used to ride `useZoneNav` alone, so on a view without it (Compose) no
     focus move ever re-derived, and the attribute could stand on "rail" while the caret
     sat in a compose field (review finding, round 1). Same pair, same semantics as the
     hook's — Set semantics on the store make a second installation one refresh, not two. */
  useEffect(() => {
    const onFocusIn = (): void => refresh();
    const onFocusOut = (): void => {
      void Promise.resolve().then(refresh);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    refresh();
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);
  return null;
}

/* ── focus movement ──────────────────────────────────────────────────────────────────────
   Every helper moves REAL focus and then trusts the derivation above. `focus()` on an
   element the browser will not focus (hidden, or removed between query and call) leaves
   `activeElement` where it was, so each helper checks whether the move actually happened
   rather than assuming — that check is the whole of the responsive guard. */

/** Focusable rail rows, in visual order. Collapsed groups are skipped by focus refusal. */
function railItems(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`${RAIL} button:not([disabled])`)];
}

function tryFocus(el: HTMLElement | null | undefined): boolean {
  if (!el) return false;
  el.focus();
  return document.activeElement === el;
}

/** Step into the rail, landing on the row for the view the reader is already in. */
function enterRail(): void {
  if (railHidden()) return;
  const active = document.querySelector<HTMLElement>(`${RAIL} .ritem.on`);
  if (tryFocus(active)) return;
  for (const el of railItems()) if (tryFocus(el)) return;
}

/** ↑/↓ inside the rail: the next row that accepts focus, so a closed group is no stop. */
function railStep(dir: 1 | -1): void {
  const items = railItems();
  const cur = document.activeElement;
  const at = cur instanceof HTMLElement ? items.indexOf(cur) : -1;
  if (at < 0) {
    enterRail();
    return;
  }
  for (let i = at + dir; i >= 0 && i < items.length; i += dir) {
    if (tryFocus(items[i]!)) return;
  }
}

export interface ZoneListStep {
  /** Same contract as a binding's `disabled` — the sheet reads it. */
  disabled: boolean;
  run: () => void;
  /** The view's own next/prev wording, so ↓ and `j` document one vocabulary. */
  label: string;
}

/**
 * FOCUS FOLLOWS THE CURSOR WHILE A ROW OWNS FOCUS — and the defect this closes is concrete:
 * → from the rail lands real focus on the selected row; without this, the next ↓ moves the
 * VIEW's cursor and leaves focus standing on the old row, so Enter — the browser's own
 * button activation — presses the row the reader has visibly left. Focus and cursor must
 * not be allowed to name two different messages.
 *
 * Keyed on the view's selected id and gated on "a row button currently has focus": the
 * mouse-and-letters flow (focus on body, j/k walking the virtual cursor) is untouched, and
 * a reader who entered the list BY FOCUS gets the row announced on every step — the roving
 * walk over the real `<button>` rows the views already render as `role`-carrying options.
 * Runs after the render that moved the cursor, so the `.sel` row it focuses is the new one.
 */
function useListFocusFollow(followId: string | null | undefined, selector: string): void {
  useEffect(() => {
    if (followId == null) return;
    const cur = document.activeElement;
    if (!(cur instanceof HTMLElement) || !cur.matches(".row")) return;
    const sel = document.querySelector<HTMLElement>(selector);
    if (sel && sel !== cur) sel.focus();
  }, [followId, selector]);
}

export interface ZoneNavConfig {
  /**
   * ↑/↓ in the list zone — the view's j/k walk, so arrows and letters are one gesture.
   * `followId` is the view's selected id, for {@link useListFocusFollow}; a view whose rows
   * are not `.row` buttons may omit it and the follow never engages.
   */
  list?: { up: ZoneListStep; down: ZoneListStep; followId?: string | null };
  /** The open-message zone. Absent in the stream views, which have no third column. */
  reader?: {
    /** Geography, focus target and default scroller of the open message. */
    selector: string;
    /** Where ↑/↓ scroll, when that is not `selector` itself (Settings: the view scroller). */
    scrollSelector?: string;
    /** Nothing is open — → into the pane is declared inert, and the sheet says so. */
    disabled: boolean;
    /** → landed in the pane: explicit engagement. The Ohbox arms its read here. */
    onEnter?: () => void;
    /** The pane is hidden at this width; → means the view's deliberate open instead. */
    onHiddenEnter?: () => void;
  };
  /** Where "back to the list" lands focus. Default: the selected row. */
  listFocusSelector?: string;
}

/**
 * Declare the zone model for the mounted view. Returns the live zone so the view can gate
 * its own bindings (`disabled: … || zone !== "list"`) — the counterpart of this hook gating
 * everything it registers on the same value.
 */
export function useZoneNav(cfg: ZoneNavConfig = {}): Zone {
  const t = useTranslations("shortcuts");
  const z = useZone();

  /* The mounted view owns the reader geography for as long as it is mounted. */
  const readerSelector = cfg.reader?.selector ?? null;
  useEffect(() => {
    readerGeography = readerSelector;
    refresh();
    return () => {
      readerGeography = null;
      refresh();
    };
  }, [readerSelector]);

  /* The two observers that keep the derivation current. `focusout` fires before the next
     `activeElement` settles (a blur to `body` fires no `focusin` at all), so it re-reads on
     a microtask. Installed per mounted hook and ref-counted by Set semantics: one view at a
     time in practice, and a second caller would simply add the same two listeners once. */
  useEffect(() => {
    const onFocusIn = (): void => refresh();
    const onFocusOut = (): void => {
      void Promise.resolve().then(refresh);
    };
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    refresh();
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);

  /* Re-derive after EVERY commit, not only on focus events. Geography changes move no focus
     of their own — the reader sheet unmounting leaves `activeElement` on `body` with no
     `focusout` fired (a removed node blurs silently), which would strand the store on
     "reader" and keep the list arrows declared inert after the sheet closed. But a geography
     change is always a React commit, and the commit is the moment to re-read where focus
     stands. `refresh()` notifies only on an actual change, so the steady state costs one
     `closest()` per commit and no render loop. */
  useEffect(() => {
    refresh();
  });

  /* Read through a ref at run time, the registry's own pattern (`Layer.get`): the closures
     below dispatch against the render that is on screen, never the mount's. */
  const latest = useRef(cfg);
  latest.current = cfg;

  useListFocusFollow(cfg.list?.followId, cfg.listFocusSelector ?? ".view .row.sel");

  const focusList = (): void => {
    const sel = latest.current.listFocusSelector ?? ".view .row.sel";
    if (tryFocus(document.querySelector<HTMLElement>(sel))) return;
    // No row to stand on (a resting list, a stream): release focus to the body, which IS
    // the list zone by derivation. The view's own cursor highlight carries the indication.
    const cur = document.activeElement;
    if (cur instanceof HTMLElement) cur.blur();
  };

  const enterReader = (): void => {
    const r = latest.current.reader;
    if (!r || r.disabled) return;
    const pane = document.querySelector<HTMLElement>(r.selector);
    if (tryFocus(pane)) {
      r.onEnter?.();
      return;
    }
    // The column is hidden at this width (or not rendered): "into the message" can only
    // mean the deliberate open, and the view says what that is.
    r.onHiddenEnter?.();
  };

  const scrollReader = (dir: 1 | -1): void => {
    // The sheet outranks the column: while the full-screen reader stands, the zone is
    // "reader" wherever focus sits, and the thing to scroll is the sheet — never a column
    // standing `display:none` behind it. With no sheet, the zone can only be "reader"
    // through the view's own geography, and its declared scroller is the target.
    const sheet = document.querySelector<HTMLElement>(READER_OVERLAY);
    const r = latest.current.reader;
    const el =
      sheet ?? (r ? document.querySelector<HTMLElement>(r.scrollSelector ?? r.selector) : null);
    if (el) el.scrollTop = el.scrollTop + dir * READER_SCROLL_STEP;
  };

  /* Two bindings per contested chord, gated to disjoint zones, so the `?` sheet shows the
     label for the zone the reader is actually in — the dedup keeps the enabled one.

     ── h / l ARE THE ARROWS' LATERAL TWINS (the ohmarchy keymap, Phase 1) ────────────────
     The prototype's one-table grammar reads "h / l · ← / →: move tile focus", and the
     letters ride HERE, beside the arrows they alias, rather than in a second table — same
     zone gates, same handlers, so the pair cannot drift. Only the LATERAL axis gets
     letters: j/k already walk the list from the views' own bindings (view scope, which
     wins over these), so a vertical twin here would be a third opinion about what j is.
     The letters obey the typing guard exactly as every bare key does — `h` in a field
     types an h — which the arrows never needed; that asymmetry is why the reader-scroll
     pair below has no letter twins (`inInput` scrolling is the arrows' alone). */
  const lateralTwins = (alias: "h" | "l") =>
    (b: KeyBinding): KeyBinding[] => [b, { ...b, chord: alias, inInput: false }];
  const left = lateralTwins("h");
  const right = lateralTwins("l");
  const bindings: KeyBinding[] = [
    ...left({
      chord: "ArrowLeft",
      group: "navigate",
      label: t("zoneMenu"),
      disabled: z !== "list",
      run: enterRail,
    }),
    ...left({
      chord: "ArrowLeft",
      group: "navigate",
      label: t("zoneList"),
      disabled: z !== "reader",
      // Gated: with the SHEET standing the zone is "reader" too, and "back to the list"
      // would land real focus on a row behind a modal. The sheet's ← is nothing; its exit
      // is Escape, which the shell's overlay ladder owns.
      when: noReaderOverlay,
      run: focusList,
    }),
    ...right({
      chord: "ArrowRight",
      group: "navigate",
      label: t("zoneList"),
      disabled: z !== "rail",
      run: focusList,
    }),
    ...right({
      chord: "ArrowRight",
      group: "navigate",
      label: t("zoneRead"),
      disabled: z !== "list" || !cfg.reader || cfg.reader.disabled,
      run: enterReader,
    }),
    {
      chord: "ArrowUp",
      group: "navigate",
      label: t("zoneMenuUp"),
      disabled: z !== "rail",
      run: () => railStep(-1),
    },
    {
      chord: "ArrowDown",
      group: "navigate",
      label: t("zoneMenuDown"),
      disabled: z !== "rail",
      run: () => railStep(1),
    },
    /* Escape walks back left, one zone per press. It is registered at `global` scope like
       everything here, so every existing Escape wins first: the shell's overlay ladder
       (anything open on top), then the view's own (cancel the bulk row, clear the picked
       set) — this fires only when nothing nearer claimed the key. */
    {
      chord: "Escape",
      group: "navigate",
      label: t("zoneList"),
      disabled: z !== "reader",
      // Gated for ArrowLeft's reason — and the shell's overlay-scope Escape outranks this
      // binding anyway while anything is open; the gate keeps the fallthrough honest.
      when: noReaderOverlay,
      run: focusList,
    },
    {
      chord: "Escape",
      group: "navigate",
      label: t("zoneMenu"),
      disabled: z !== "list",
      run: enterRail,
    },
  ];

  if (cfg.list) {
    bindings.push(
      {
        chord: "ArrowUp",
        group: "navigate",
        label: cfg.list.up.label,
        disabled: z !== "list" || cfg.list.up.disabled,
        run: () => latest.current.list?.up.run(),
      },
      {
        chord: "ArrowDown",
        group: "navigate",
        label: cfg.list.down.label,
        disabled: z !== "list" || cfg.list.down.disabled,
        run: () => latest.current.list?.down.run(),
      },
    );
  }

  /* Unconditional, unlike everything else the reader config guards: the STREAM views have no
     reading column, but the full-screen sheet can stand over any view, and while it does the
     zone is "reader" — a pair registered only under `cfg.reader` left the sheet unscrollable
     exactly there. With no sheet and no geography the zone is never
     "reader", so the pair stays declared-inert where it has nothing to scroll. */
  /* `inInput` + the `when` below, together: a keyboard search can open a hit in place while
     the search box keeps focus, so the typing target is a field BURIED UNDER the sheet — the
     pair must claim ↑/↓ there or the visible reader cannot scroll at all.
     A typing target INSIDE the sheet (an editor in the open message) keeps its native caret:
     the `when` yields for it, and with no sheet standing it yields for every field. */
  const scrollableTyping = (e: KeyboardEvent): boolean => {
    if (!isTypingTarget(e.target)) return true;
    const el = e.target as HTMLElement;
    return document.querySelector(READER_OVERLAY) != null && !el.closest(READER_OVERLAY);
  };
  bindings.push(
    {
      chord: "ArrowUp",
      group: "navigate",
      label: t("zoneScroll"),
      disabled: z !== "reader",
      inInput: true,
      when: scrollableTyping,
      run: () => scrollReader(-1),
    },
    {
      chord: "ArrowDown",
      group: "navigate",
      label: t("zoneScroll"),
      disabled: z !== "reader",
      inInput: true,
      when: scrollableTyping,
      run: () => scrollReader(1),
    },
  );

  /* Optional registration: the split views are also mounted with no keymap at all (bare
     view tests, keyboard-less hosts), where the zone model is simply absent — see the
     variant's own docs in `keymap.tsx`. Under the app's provider it registers exactly as
     `useKeyBindings` would. */
  useOptionalKeyBindings(bindings, "global");
  return z;
}
