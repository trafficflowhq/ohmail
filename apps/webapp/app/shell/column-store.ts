"use client";

/**
 * The three columns' widths — one contract, four readers: `ColumnHandles` (writes live during a drag, persists on
 * release); the web door's pre-paint script (`columnsBootScript`, inlined by `(product)/providers.tsx` — a served
 * page has no bundle yet, so the widths are stamped or the first frame is the default and the second the truth); the
 * desktop window and served host client (`stampColumns` — their CSP forbids inline scripts, so they call the function
 * before `createRoot`); and `BootSkeleton` via `app.css`, reading the same two custom properties. Plain functions, no
 * React — four callers must agree. Per machine, never per account: a column width is a fact about the screen, so it
 * is origin `localStorage`, unkeyed by owner, and survives sign-out like the face pin and the rail disclosures; the
 * sidecar's settings hold mailbox and AI facts, and window chrome gets no route there.
 */

/**
 * A clamp in CSS AND a clamp in JS — different questions. The CSS clamp makes a smaller window
 * behave: shrink and the rail re-clamps with no JavaScript, widen and the stored width comes back
 * because the stored number was never overwritten. The JS clamp keeps the STORE honest: a value
 * written by an older build, a hand-edited jar, or a drag past the ceiling must not persist as-is.
 * Both are pinned in `column-geometry.test.ts`. The viewer's floor is a CSS expression, not a
 * measured number: the bound depends on the tile gap, a token the pre-paint script cannot read
 * before the stylesheet loads — `calc(100% - 480px - var(--gap-tile))` hands the arithmetic to the
 * browser, which is why the stamp and the live writer produce byte-identical text.
 */

import { UI_KEYS } from "./persisted-ui";
import { durableRemove, durableSet } from "./durable";

/**
 * The store's key and its shape. The key comes from `UI_KEYS` rather than being spelled again: that
 * table keeps every key this app writes greppable from one prefix, and it is the string
 * `sign-out-clears-durable-stores.test.ts` rules on — two copies would let the store read one key
 * while the census classified another, and the census would still pass. `v` exists so a future
 * geometry that means something different by `rail`/`list` can be told from this one: an
 * unrecognised version reads as NO PREFERENCE rather than a value to repair — a repaired guess at
 * an unknown shape is how a stale jar produces a layout nobody chose.
 */
export const COLUMNS_KEY = UI_KEYS.columns;
export const COLUMNS_VERSION = 1;

export interface ColumnState {
  /** The rail's width in px. Absent = the default; the key is removed when both are absent. */
  rail?: number;
  /** The list column's width in px. Absent = the token `--split`. */
  list?: number;
}

/**
 * The rail's bounds. 180 was tried and measured too tight — a two-word tag name wrapped — so
 * the floor is 200; the ceiling is where the rail stops being a rail.
 */
export const RAIL = { min: 200, max: 360, dflt: 224 } as const;

/**
 * The list's bounds, and the reading column's floor beneath them. The floor is where the
 * message's action bar stops working: it admits verbs greedily against its own measured width,
 * and at a 480px reading column it still carries the forward verb, while at 360 it carried
 * none — a reading column with no verbs on it has stopped being one.
 */
export const LIST = { min: 320, max: 720, dflt: 400, viewerMin: 480 } as const;

/** Keyboard steps on a focused handle: one press, and one press with Shift. */
export const STEP = 16;
export const BIG_STEP = 64;

/** The custom properties the geometry hangs on. Absent = today's stylesheet, verbatim. */
export const RAIL_VAR = "--rail-w";
export const SPLIT_VAR = "--split-user";
/**
 * …and a second track list for the boot silhouette, which is not the same box. `--split-user`
 * contains `calc(100% - …)`, and `100%` means the element the property is USED on: in the shell
 * that is `.view.split` (rail and one gap already taken out), while the silhouette's
 * `.boot-sk-window` is the whole deck — a few hundred pixels wider. Handing it the same string
 * drew a list up to `rail + gap` wider than the shell it becomes: the exact cold-boot snap this
 * store exists to remove. It cannot be repaired at the point of use — a `var()` inside a custom
 * property is substituted where the property is DECLARED (`:root`) — so the room is baked in per
 * box by the one function below, and `column-geometry.test.ts` compares both properties.
 */
export const SPLIT_SK_VAR = "--split-user-sk";

/**
 * The rail's track, as CSS. One string, so the stylesheet and the stamp cannot drift. The ceiling
 * follows the window: a constant 360px cap let a rail dragged wide keep its width while the window
 * shrank, leaving the reading column ~250px at 1000px — its header address ran into the time. The
 * cap is now the smaller of the rail's own ceiling and what the window leaves once the list keeps
 * its floor and the reading column its own (`LIST.min` + `LIST.viewerMin`, plus the edge and tile
 * gaps, in tokens): the viewer keeps a floor at every split width, no script running. When the
 * window is too narrow even for the floor, `clamp()` resolves to the rail's minimum — right there
 * too.
 */
export const RAIL_TRACK =
  `clamp(${RAIL.min}px, var(${RAIL_VAR}, ${RAIL.dflt}px), `
  + `min(${RAIL.max}px, calc(100vw - ${LIST.min + LIST.viewerMin}px - 2 * var(--gap-edge) - 2 * var(--gap-tile))))`;

/** What is left for the list once the reading column keeps its floor — per box. */
const ROOM_SPLIT = `calc(100% - ${LIST.viewerMin}px - var(--gap-tile))`;
const ROOM_SKELETON =
  `calc(100% - ${RAIL_TRACK} - var(--gap-tile) - ${LIST.viewerMin}px - var(--gap-tile))`;

const clamp = (px: number, lo: number, hi: number): number =>
  Math.round(Math.min(hi, Math.max(lo, px)));

export const clampRail = (px: number): number => clamp(px, RAIL.min, RAIL.max);
export const clampList = (px: number): number => clamp(px, LIST.min, LIST.max);

/**
 * The split's whole track list for a given list width. `minmax(floor, min(chosen, room))` and not a bare width: the
 * floor keeps a list that cannot shrink further from being squeezed by the `1fr` beside it, and `min(…, calc(100% -
 * …))` is the viewer's floor expressed so the BROWSER enforces it — narrow the window and the list gives way without
 * a resize listener, widen it and the chosen width returns. ONE function, because three callers must produce the same
 * string: the live writer, the web door's inline stamp, and the desktop's. `column-geometry.test.ts` compares the
 * stamp's output against this for a table of stored values, including hostile ones.
 */
function splitTracks(listPx: number, room: string): string {
  return `minmax(${LIST.min}px, min(${listPx}px, ${room})) 1fr`;
}

/** The shell's split — `100%` is `.view.split`, the rail already taken out of it. */
export function splitUserValue(listPx: number): string {
  return splitTracks(listPx, ROOM_SPLIT);
}

/** The silhouette's — `100%` is the whole deck, so the rail and its gap come out here. */
export function splitSkeletonValue(listPx: number): string {
  return splitTracks(listPx, ROOM_SKELETON);
}

/**
 * The stored record, reduced to what this build understands — and an EMPTY record, never `null`,
 * for every "no preference" case: an empty jar, a version this build does not know, a malformed
 * value, and a jar that refuses to be read at all. One shape out means callers never branch on
 * which kind of nothing they got, and the empty record is exactly what `applyColumnVars` turns
 * into "remove both properties", which is the default geometry.
 */
export function readColumns(storage?: Storage | null): ColumnState {
  try {
    const jar = storage ?? window.localStorage;
    const raw = jar.getItem(COLUMNS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return normalizeColumns(parsed);
  } catch {
    /* storage blocked, or a malformed value — no preference, which is the default geometry */
    return {};
  }
}

/**
 * A parsed value, reduced to what this build understands. Exported because the pre-paint stamp
 * and the tests apply exactly this reduction and there must be one copy of the rules:
 * wrong version ⇒ nothing; a non-finite number ⇒ that field absent; anything else clamped.
 */
export function normalizeColumns(parsed: unknown): ColumnState {
  if (!parsed || typeof parsed !== "object") return {};
  const rec = parsed as Record<string, unknown>;
  if (rec.v !== COLUMNS_VERSION) return {};
  const out: ColumnState = {};
  if (typeof rec.rail === "number" && Number.isFinite(rec.rail)) out.rail = clampRail(rec.rail);
  if (typeof rec.list === "number" && Number.isFinite(rec.list)) out.list = clampList(rec.list);
  return out;
}

/**
 * Persist — and REMOVE the key when nothing is set, so a reader who resets both handles leaves
 * no entry behind rather than a record that says "the defaults, explicitly". The difference
 * matters the day a default changes.
 */
/*
 * The `storage` parameter this took is gone: no caller ever passed one — not the handles, not
 * the tests — so the injected arm was unreachable and the jar is always this browser's. The
 * widths still hold for this session when a write is refused; it is no longer refused silently.
 */
export function writeColumns(state: ColumnState): void {
  const out: Record<string, number> = { v: COLUMNS_VERSION };
  if (state.rail !== undefined) out.rail = clampRail(state.rail);
  if (state.list !== undefined) out.list = clampList(state.list);
  if (out.rail === undefined && out.list === undefined) durableRemove(COLUMNS_KEY, "ui.columns");
  else durableSet(COLUMNS_KEY, JSON.stringify(out), "ui.columns");
}

/**
 * Write (or clear) the two properties on `<html>`.
 *
 * A field that is absent REMOVES its property rather than writing a default, which is what
 * makes "never dragged" byte-identical to the shipped stylesheet: `var(--rail-w, 224px)` and
 * `var(--split-user, var(--split))` both fall through to exactly what they resolved to before
 * this feature existed.
 */
export function applyColumnVars(root: HTMLElement, state: ColumnState): void {
  if (state.rail !== undefined) root.style.setProperty(RAIL_VAR, `${state.rail}px`);
  else root.style.removeProperty(RAIL_VAR);
  if (state.list !== undefined) {
    root.style.setProperty(SPLIT_VAR, splitUserValue(state.list));
    root.style.setProperty(SPLIT_SK_VAR, splitSkeletonValue(state.list));
  } else {
    root.style.removeProperty(SPLIT_VAR);
    root.style.removeProperty(SPLIT_SK_VAR);
  }
}

/**
 * THE PRE-PAINT STAMP, for a host that runs this bundle before it paints — the desktop window
 * and the served host client. Both re-state the theme stamp in their entry for the same reason
 * (their CSP forbids an inline script), and this is that contract's third axis.
 */
export function stampColumns(): void {
  if (typeof document === "undefined") return;
  applyColumnVars(document.documentElement, readColumns());
}

/**
 * THE SAME STAMP AS A STRING, for the web door, which paints from server-rendered HTML and has no bundle running yet.
 * Inlined by `(product)/providers.tsx` under the request's nonce. It is hand-written rather than derived from {@link
 * stampColumns} by `Function.toString()`, deliberately: a serialized function is whatever the bundler left behind,
 * and a minifier that hoisted one reference out of it would produce a script that throws in production and passes
 * every test, because the test never sees the bundled form. So the duplication is explicit and
 * `column-geometry.test.ts` executes THIS string against a table of stored values and requires the same two
 * properties {@link applyColumnVars} writes — the guard is the comparison, not the derivation.
 */
export function columnsBootScript(): string {
  const key = JSON.stringify(COLUMNS_KEY);
  return (
    `(function(){try{var s=localStorage.getItem(${key});if(!s)return;var c=JSON.parse(s);` +
    `if(!c||typeof c!=="object"||c.v!==${COLUMNS_VERSION})return;var d=document.documentElement.style,n;` +
    `if(typeof c.rail==="number"&&isFinite(c.rail)){n=Math.round(Math.min(${RAIL.max},Math.max(${RAIL.min},c.rail)));` +
    `d.setProperty(${JSON.stringify(RAIL_VAR)},n+"px")}` +
    `if(typeof c.list==="number"&&isFinite(c.list)){n=Math.round(Math.min(${LIST.max},Math.max(${LIST.min},c.list)));` +
    `d.setProperty(${JSON.stringify(SPLIT_VAR)},"minmax(${LIST.min}px, min("+n+"px, ${ROOM_SPLIT})) 1fr");` +
    `d.setProperty(${JSON.stringify(SPLIT_SK_VAR)},"minmax(${LIST.min}px, min("+n+"px, ${ROOM_SKELETON})) 1fr")}` +
    `}catch(e){}})()`
  );
}
