/**
 * THE SCREENER'S JUNK: the mail server's own Junk folder, read live through the shell's window and never mirrored. A
 * row is named by its mailbox, its folder's epoch and its number (a number names a letter only within one epoch); the
 * open row falls to the first while nothing is picked; its text is asked when it opens on screen, and once only (the
 * window keeps what it read). The keys walk the rows and the sections; no key moves a letter out of Junk.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyBinding } from "../keys/binding.js";
import { screenerKeys, type KeySegment, type ScreenerKeyWords } from "./keys.js";
import { firstOf, walk } from "./view-parts.js";

/** What names one row of the Junk window. */
export interface JunkKeyed {
  readonly mailboxId: string;
  readonly uidValidity: string;
  readonly uid: number;
}

/** One row's key: the twin of the shell's `junkKeyOf`. */
export const junkKey = (i: JunkKeyed): string => `${i.mailboxId}:${i.uidValidity}:${i.uid}`;

/** What a row says of itself: a standing "not junk" first (what will happen outranks who filed it), else who filed it. */
export type JunkLabel = "junkRescueQueued" | "junkRescueRefused" | "junkOriginVerdict" | "junkOriginProvider";
export function junkLabelOf(i: {
  readonly rescue?: "queued" | "refused";
  readonly origin: "verdict" | "provider";
}): JunkLabel {
  if (i.rescue === "queued") return "junkRescueQueued";
  if (i.rescue === "refused") return "junkRescueRefused";
  return i.origin === "verdict" ? "junkOriginVerdict" : "junkOriginProvider";
}

export interface JunkViewInput<I extends JunkKeyed> {
  /** Junk is the section on screen: nothing opens, falls or is read while it is not. */
  readonly active: boolean;
  /** The rows as drawn: the window's kept rows, then what the server's search appended. */
  readonly rows: readonly I[];
  /** The row open in Junk, kept above the list for the frame's life. */
  readonly selected: string | null;
  readonly select: (key: string | null) => void;
  /** Ask the open row's text: once it is on screen (both columns, or the letter over the list on one). */
  readonly openBody: (item: I) => void;
  readonly words: ScreenerKeyWords;
  readonly go: (segment: KeySegment) => void;
  readonly undo: () => void;
  readonly oneColumn: boolean;
}

export interface JunkView<I extends JunkKeyed> {
  readonly openKey: string | null;
  readonly open: I | null;
  /** On one column, the open letter stands over the list. */
  readonly full: boolean;
  readonly select: (key: string) => void;
  readonly close: () => void;
  readonly keys: KeyBinding[];
}

const NO_DECISION = (): void => undefined;

export function useJunkView<I extends JunkKeyed>(input: JunkViewInput<I>): JunkView<I> {
  const { active, rows, selected, select, openBody, oneColumn } = input;
  const [full, setFull] = useState(false);
  const keys = useMemo(() => rows.map(junkKey), [rows]);
  const openKey = !active
    ? null
    : selected !== null && keys.includes(selected)
      ? selected
      : (keys[0] ?? null);
  useEffect(() => {
    if (active && openKey !== selected) select(openKey);
  }, [active, openKey, selected, select]);
  const open = openKey === null ? null : (rows.find((r) => junkKey(r) === openKey) ?? null);
  const shown = open !== null && (!oneColumn || full);
  /* Keyed on the row: the window refuses a second ask for a text it holds or is reading. */
  const ask = shown ? openKey : null;
  const latest = useRef({ open, openBody });
  latest.current = { open, openBody };
  useEffect(() => {
    const now = latest.current;
    if (ask !== null && now.open !== null) now.openBody(now.open);
  }, [ask]);
  const close = () => setFull(false);
  return {
    openKey,
    open,
    full: oneColumn && full && open !== null,
    select: (key) => {
      select(key);
      if (oneColumn) setFull(true);
    },
    close,
    keys: screenerKeys({
      words: input.words,
      segment: "spam",
      step: walk(keys, openKey, (key) => select(key)),
      decidable: false,
      decide: NO_DECISION,
      suggested: null,
      applyAll: null,
      card: null,
      go: input.go,
      undo: input.undo,
      escape: firstOf([oneColumn && full && close]),
    }),
  };
}
