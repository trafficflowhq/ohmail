"use client";

/**
 * THE THREE COLUMNS' WIDTHS — one contract, four readers.
 *
 * The shell is rail | list | reading column, and until now all three widths were constants in
 * the stylesheet. They are now draggable, and every part of that lives here: what is stored,
 * where, what the numbers may be, and the two CSS custom properties the geometry actually
 * hangs on. The handles themselves are `ColumnHandles.tsx`; this file is the part that four
 * different callers must agree about, so it is deliberately a module of plain functions with
 * no React in it.
 *
 * The four readers, and why each one exists:
 *
 *  · `ColumnHandles` — writes live while a handle is dragged, persists on release.
 *  · the web door's pre-paint script (`columnsBootScript`, inlined by `(product)/providers.tsx`)
 *    — a served page has no bundle running yet, so the widths must be stamped by a string of
 *    JavaScript in the HTML or the first frame is the default and the second is the truth.
 *  · the desktop window and the served host client (`stampColumns`) — neither has Next, both
 *    run this bundle before `createRoot`, so they call the function instead of inlining a
 *    script (their CSP forbids inline scripts; `main.tsx` already re-states the theme stamp
 *    the same way for the same reason).
 *  · `BootSkeleton` via `app.css`, which reads the same two properties so the silhouette and
 *    the shell it becomes stand in the same three columns.
 *
 * ── PER MACHINE, NEVER PER ACCOUNT ──────────────────────────────────────────────────────────
 *
 * A column width is a fact about the SCREEN, not about the mailbox — a 13" laptop and a 27"
 * display want different answers and syncing it would let the small one dictate to the large
 * one. So this is `localStorage` on the origin, unkeyed by owner, exactly like the face's
 * device pin (`ohmail.face`) and the rail's group disclosures (`ohmail.ui.rail.*`), and like
 * them it SURVIVES SIGN-OUT — it is chrome, and there is no mail in a number of pixels. The
 * desktop's store is the same one: the webview's own `localStorage` inside the app's data
 * directory, which is where the face pin already survives relaunch. The sidecar's settings
 * hold mailbox and AI facts; window chrome has no business there and gets no route.
 *
 * ── WHY A CLAMP IN CSS *AND* A CLAMP IN JS, WHICH LOOKS LIKE A DUPLICATE ────────────────────
 *
 * They answer different questions. The CSS clamp is what makes a SMALLER WINDOW behave: shrink
 * the window and the rail re-clamps with no JavaScript at all, and widen it again and the
 * stored width comes back, because the stored number was never overwritten. The JS clamp is
 * what keeps the STORE honest: a value written by an older build, a hand-edited jar, or a drag
 * that ran past the ceiling must not be persisted as-is. Removing either one leaves a real
 * defect, so both are pinned in `column-geometry.test.ts`.
 *
 * ── THE VIEWER'S FLOOR IS A CSS EXPRESSION, NOT A MEASURED NUMBER ───────────────────────────
 *
 * The list's ceiling has a second bound: whatever leaves the reading column at least
 * {@link LIST.viewerMin}. That bound depends on the tile gap, which is a token (16px paper,
 * 10px ohmarchy) — and the pre-paint script runs before the stylesheet is guaranteed to have
 * loaded, so it cannot read the token. Writing `calc(100% - 480px - var(--gap-tile))` hands
 * the arithmetic to the browser instead, where the token is resolved at computed-value time on
 * the root. That is the reason the stamp and the live writer can produce byte-identical text
 * without either of them measuring anything.
 */

/**
 * The store's key and its shape. `v` is present so a future geometry that means something
 * different by `rail`/`list` can be told from this one: an unrecognised version reads as NO
 * PREFERENCE (the defaults stand) rather than as a value to repair, because a repaired guess
 * at an unknown shape is how a stale jar produces a layout nobody chose. The next write
 * replaces it with a v1 record.
 */
export const COLUMNS_KEY = "ohmail.ui.columns";
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

/** The two custom properties the geometry hangs on. Absent = today's stylesheet, verbatim. */
export const RAIL_VAR = "--rail-w";
export const SPLIT_VAR = "--split-user";

const clamp = (px: number, lo: number, hi: number): number =>
  Math.round(Math.min(hi, Math.max(lo, px)));

export const clampRail = (px: number): number => clamp(px, RAIL.min, RAIL.max);
export const clampList = (px: number): number => clamp(px, LIST.min, LIST.max);

/**
 * The split's whole track list for a given list width.
 *
 * `minmax(floor, min(chosen, room))` and not a bare width: the floor keeps a list that cannot
 * shrink further from being squeezed by the `1fr` beside it, and `min(…, calc(100% - …))` is
 * the viewer's floor expressed so the BROWSER enforces it — narrow the window and the list
 * gives way without a resize listener, widen it and the chosen width returns.
 *
 * ONE function, because three callers must produce the same string: the live writer, the web
 * door's inline stamp, and the desktop's. `column-geometry.test.ts` compares the stamp's output
 * against this for a table of stored values, including hostile ones.
 */
export function splitUserValue(listPx: number): string {
  return `minmax(${LIST.min}px, min(${listPx}px, calc(100% - ${LIST.viewerMin}px - var(--gap-tile)))) 1fr`;
}

/** A stored record, or `null` for "no preference" — an unreadable jar included. */
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
export function writeColumns(state: ColumnState, storage?: Storage | null): void {
  try {
    const jar = storage ?? window.localStorage;
    const out: Record<string, number> = { v: COLUMNS_VERSION };
    if (state.rail !== undefined) out.rail = clampRail(state.rail);
    if (state.list !== undefined) out.list = clampList(state.list);
    if (out.rail === undefined && out.list === undefined) jar.removeItem(COLUMNS_KEY);
    else jar.setItem(COLUMNS_KEY, JSON.stringify(out));
  } catch {
    /* private mode refuses writes; the widths still hold for this session */
  }
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
  if (state.list !== undefined) root.style.setProperty(SPLIT_VAR, splitUserValue(state.list));
  else root.style.removeProperty(SPLIT_VAR);
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
 * THE SAME STAMP AS A STRING, for the web door, which paints from server-rendered HTML and has
 * no bundle running yet. Inlined by `(product)/providers.tsx` under the request's nonce.
 *
 * It is hand-written rather than derived from {@link stampColumns} by `Function.toString()`,
 * deliberately: a serialized function is whatever the bundler left behind, and a minifier that
 * hoisted one reference out of it would produce a script that throws in production and passes
 * every test, because the test never sees the bundled form. So the duplication is explicit and
 * `column-geometry.test.ts` executes THIS string against a table of stored values and requires
 * the same two properties {@link applyColumnVars} writes — the guard is the comparison, not the
 * derivation.
 */
export function columnsBootScript(): string {
  const key = JSON.stringify(COLUMNS_KEY);
  return (
    `(function(){try{var s=localStorage.getItem(${key});if(!s)return;var c=JSON.parse(s);` +
    `if(!c||typeof c!=="object"||c.v!==${COLUMNS_VERSION})return;var d=document.documentElement.style,n;` +
    `if(typeof c.rail==="number"&&isFinite(c.rail)){n=Math.round(Math.min(${RAIL.max},Math.max(${RAIL.min},c.rail)));` +
    `d.setProperty(${JSON.stringify(RAIL_VAR)},n+"px")}` +
    `if(typeof c.list==="number"&&isFinite(c.list)){n=Math.round(Math.min(${LIST.max},Math.max(${LIST.min},c.list)));` +
    `d.setProperty(${JSON.stringify(SPLIT_VAR)},"minmax(${LIST.min}px, min("+n+"px, calc(100% - ${LIST.viewerMin}px - var(--gap-tile)))) 1fr")}` +
    `}catch(e){}})()`
  );
}
