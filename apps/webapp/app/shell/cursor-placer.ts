"use client";

/**
 * ONE CURSOR PLACER, FOR EVERY LIST VIEW.
 *
 * The rule it carries is the dispatcher's (`keymap.tsx#DisabledReason`): a message verb pressed on
 * a list that has rows and no cursor PLACES the cursor and says so, performing nothing. Nothing is
 * placed on arrival — a `?? allOhbox[0]` fallback fetched a body from the person's own server on
 * open, and ⌫ is that hazard with a delete on the end. It lives here rather than in the shell
 * because the shell holds the cursor for three of its views and every other list holds its own:
 * one spelling, and a host supplies only its rows and the row selector it already has.
 */
import { useTranslations } from "next-intl";
import { useOptionalToast } from "@ohmail/ui";
import { useCursorPlacer, type PlacerScope } from "./keymap";

/**
 * HOW LONG THE CURSOR HINT STANDS. Shorter than the toast's 2600 ms default, because this one
 * carries no action to reach for and the second press is meant to follow it immediately.
 *
 * Exported so a guard reads the number rather than restating it: a hint that outlives the press it
 * explains, or vanishes before it can be read, is a difference a test should be able to see.
 */
export const CURSOR_HINT_MS = 2400;

/** The least a row has to be for a cursor to stand on it. */
export interface CursorRow {
  id: string;
}

/** What a host has to hand over to be asked — its list, its cursor, and where its rows live. */
export interface CursorHost {
  /** The rows this list is SHOWING, in the order it shows them. */
  rows: readonly CursorRow[];
  /** The cursor this host holds right now. Non-null declines: there is nothing to place. */
  current: string | null;
  /** This list's row scope, e.g. `".view-folder"` — `".view"` where one view is on screen. */
  scope: string;
  /** Put the cursor on this id — the host's own row selector, never a second one. */
  select: (id: string) => void;
}

/**
 * Place the cursor on the first row and say so. `false` means nothing was placed — an empty list,
 * a cursor already standing, or a row the window has not mounted — and the dispatcher leaves such
 * a press exactly as inert as it was, `preventDefault` included.
 *
 * The DOM row is read because the scroll needs the element, and the null check earns its keep
 * twice: it is what a click would have hit, and it is `null` for a host holding a list in state
 * without rendering it.
 */
export function placeFirstRow(
  host: CursorHost,
  label: string,
  say: ((label: string) => void) | null,
): boolean {
  /* NO SENTENCE, NO PLACEMENT. A ring that appears with nothing saying why is the defect this
     whole rule exists to end, one surface over — so a host with nowhere to say it declines and
     the press stays as inert as it was. `null` reaches here only where there is no toast layer
     at all (a view mounted bare); every shipped surface has one. */
  if (say == null) return false;
  if (host.current != null) return false;
  const first = host.rows[0];
  if (first == null) return false;
  const row = document.querySelector<HTMLElement>(
    `${host.scope} .row[data-id="${CSS.escape(first.id)}"]`,
  );
  if (row == null) return false;
  host.select(first.id);
  /* The same nudge a click's selection gets — `block: "nearest"`, the whole list's convention.
     Optional-chained on the METHOD, not the node: jsdom mounts these views without implementing
     it (`RulesView`'s precedent). */
  row.scrollIntoView?.({ block: "nearest" });
  say(label);
  return true;
}

/**
 * THE SENTENCE, read from the catalogue once. `{label}` is the pressed binding's own sheet label,
 * so one line works for every verb with no grammar per verb, and the toast primitive's own live
 * region announces it (`role="status" aria-live="polite"`). No action button: there is nothing to
 * undo about a cursor, and an Undo beside it would read as "put the mail back".
 */
export function useCursorHint(): ((label: string) => void) | null {
  const toast = useOptionalToast();
  const t = useTranslations();
  if (toast == null) return null;
  return (label: string) => toast(t("cursor.placed", { label }), { duration: CURSOR_HINT_MS });
}

/**
 * OFFER THIS LIST'S CURSOR for as long as the caller is mounted — the whole host half, in one
 * call. `view` scope by default, because the callers that hold their own cursor are views and a
 * view's claim has to beat the shell's (see `keymap.tsx#PlacerScope`); the shell passes `global`.
 *
 * `host` is read at the KEYPRESS, never closed over — `useCursorPlacer` keeps the current render's
 * closure — so the rows and the cursor are the ones on screen when the key was pressed.
 */
export function useRowCursorPlacer(host: CursorHost, scope: PlacerScope = "view"): void {
  const say = useCursorHint();
  useCursorPlacer((label) => placeFirstRow(host, label, say), scope);
}
