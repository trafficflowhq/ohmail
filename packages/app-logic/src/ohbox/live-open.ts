/**
 * WHICH LETTER IS OPEN AT THE OHBOX, AND ITS CURSOR ROW: the place's own state, kept for as long as the place is on
 * screen. Two columns: the letter beside the list is the address's, and a selection names it there. One column: the
 * cursor row is kept here and names no letter; a row that is ENTERED names its letter, which then stands over the
 * list. With it: the row's seed for Move, Forward's target, the open's measure, and the row of a letter that
 * arrived by the address.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useEffect, useRef, useState } from "react";
import { ownFaceOfRow, rowOpenTarget } from "@ohmail/client-engine";
import { useEngine } from "../engine/context.js";
import type { PlaceLiveArgs } from "../lists/place-live.js";
import { useStableCallback } from "../press/stable-callback.js";
import { usePresented } from "../reading/presented-mirror.js";
import { abandonOpen, beginOpen } from "../session/ui-vitals.js";

/**
 * WHICH LETTER IS OPEN, AND THE CURSOR ROW. Two columns: the letter beside the list is the address's, and a
 * selection names it there. One column: the cursor row is kept here and names no letter; a letter the address names
 * before the cursor has followed it (a link, a reload) is the cursor row meanwhile.
 */

/** What only the seat can read of the document, as this state asks it. */
export interface OpenAndCursorOwn {
  /** A row was entered where one column stands: the keyboard goes to the letter over the list. */
  readonly onRowEntered: (id: string) => void;
  /** A letter's row in the list, where the list has mounted it. */
  readonly row: (id: string) => HTMLElement | null;
}

/** How long an arrival's row is looked for: a row that never appears is a letter this list does not hold. */
const ARRIVAL_LOOK_MS = 2000;

/**
 * A LETTER THAT ARRIVED BY THE ADDRESS (a link, a reload, Back: no press of this list named it) has its row brought
 * to the middle of the list, once, when the list has mounted the row: the list's own reveal mounts a row far down
 * in a later commit, so the row is looked for after each commit, for a short while. A letter this list named itself
 * moves no list: its row is where the person pressed.
 */
function useArrivalInView(open: string | null, row: OpenAndCursorOwn["row"]) {
  /* The letter this list holds as named: its own press's, which the address then only echoes, else the address's
     last. Back to a letter pressed earlier is an arrival: another letter was named since. */
  const named = useRef<string | null>(null);
  const owed = useRef<{ id: string; until: number } | null>(null);
  const last = useRef<string | null>(null);
  if (last.current !== open) {
    last.current = open;
    owed.current =
      open !== null && open !== named.current ? { id: open, until: Date.now() + ARRIVAL_LOOK_MS } : null;
    named.current = open;
  }
  useEffect(() => {
    const arrival = owed.current;
    if (arrival === null) return;
    const at = row(arrival.id);
    if (at === null) {
      if (Date.now() > arrival.until) owed.current = null;
      return;
    }
    owed.current = null;
    at.scrollIntoView?.({ block: "center" });
  });
  return (id: string | null): void => {
    named.current = id;
  };
}

export function useOpenAndCursor(args: PlaceLiveArgs, own: OpenAndCursorOwn) {
  const { onRowEntered } = own;
  const engine = useEngine();
  const presented = usePresented();
  const [cursor, setCursor] = useState<string | null>(null);
  /* THE ROW PRESS AND THE REPLY FACING ITS ROW: Move's seed, decided when the selection is made. Only the list's own
     selection writes it; a link, a reload or Back records nothing. */
  const [rowSeed, setRowSeed] = useState<{ id: string; ownFace: string | null } | null>(null);
  const oneColumn = args.plan.columns === 1;
  const open = args.route.open;
  const nameIt = useArrivalInView(open, own.row);
  const onSelect = useStableCallback((id: string | null, wholeThread?: true) => {
    const m = id === null ? undefined : presented.get<EngineMessage>("message", id);
    const next = m
      ? { id: m.id, ownFace: ownFaceOfRow(presented, m, engine.openRowHeld())?.id ?? null }
      : null;
    // The same answer keeps the same record: a press on the row already selected renders nothing more.
    setRowSeed((cur) => (cur?.id === next?.id && cur?.ownFace === next?.ownFace ? cur : next));
    setCursor(id);
    if (args.plan.columns === 1) {
      /* No reading column is drawn for a row only walked to: the cursor row's text is asked ahead, as a
         selection's is, so that it is there when the row is entered. A letter over the list is the reader's. */
      if (id !== null && args.route.open === null) void engine.hydrateBody(id, { urgent: true });
      return;
    }
    /* The open's measure begins at the press that names another letter, and the letter's own text is asked in the
       press's own task, before the address has announced it to the reading column. */
    if (id !== null && id !== args.route.open) {
      beginOpen(id);
      void engine.hydrateBody(id, { urgent: true });
    }
    nameIt(id);
    args.commands.open(id, undefined, wholeThread);
  });
  /* THE ROW OPEN, AND WHAT IT IS ACTED ON: Forward's target. Only a row that was ENTERED records it, taken at the
     open from the rows the Ohbox draws, so a later change to the row cannot move it; a cursor, a link or a landing
     records nothing, so each forwards the message it names. */
  const [rowOpen, setRowOpen] = useState<{ id: string; target: EngineMessage } | null>(null);
  const forwardTargetFor = useStableCallback((m: EngineMessage): EngineMessage =>
    rowOpen !== null && rowOpen.id === m.id ? rowOpen.target : m,
  );
  /* A ROW ENTERED. Where one column stands the letter is named in the address and stands over the list. */
  const onEnterReader = useStableCallback((messageId: string, wholeThread?: true) => {
    const opened = presented.get<EngineMessage>("message", messageId);
    setRowOpen(
      opened ? { id: messageId, target: rowOpenTarget(presented, opened, engine.openRowHeld()) } : null,
    );
    if (args.plan.columns !== 1) return;
    if (messageId !== args.route.open) {
      beginOpen(messageId);
      void engine.hydrateBody(messageId, { urgent: true });
    }
    nameIt(messageId);
    args.commands.open(messageId, undefined, wholeThread);
    onRowEntered(messageId);
  });
  /* THE OPEN'S MEASURE IS ABANDONED WHEN THE LETTER IS LET GO: a letter closed before its text arrived, by whatever
     way, leaves no open waiting to be ended by a later look at the same letter. And with the place. */
  useEffect(() => {
    if (open === null) abandonOpen();
  }, [open]);
  useEffect(() => () => abandonOpen(), []);
  /* THE WINDOW WIDENS PAST ONE COLUMN WITH A CURSOR ROW AND NO LETTER OVER THE LIST: at two columns the row the keys
     are on is the letter beside the list, so its letter stands there and the cursor stays on it (one state across a
     resize, as today's shell kept it). A row only the cursor stood on was walked to, not entered: no open's measure
     begins; its text is asked as a selection's is. */
  const wasOneColumn = useRef(oneColumn);
  const widen = useStableCallback((): void => {
    if (open !== null || cursor === null) return;
    if (presented.get<EngineMessage>("message", cursor) == null) return;
    void engine.hydrateBody(cursor, { urgent: true });
    nameIt(cursor);
    args.commands.open(cursor);
  });
  /* Read at the change of the column count alone: the press reads the state as it stands then. */
  useEffect(() => {
    const widened = wasOneColumn.current && !oneColumn;
    wasOneColumn.current = oneColumn;
    if (widened) widen();
  }, [oneColumn, widen]);
  /** Our own reply facing the row `m` was selected on, while that row selection stands. */
  const ownFaceFor = useStableCallback((m: EngineMessage): EngineMessage | null =>
    cursor === m.id && rowSeed?.id === m.id && rowSeed.ownFace !== null
      ? (presented.get<EngineMessage>("message", rowSeed.ownFace) ?? null)
      : null,
  );
  return {
    selectedId: oneColumn ? (cursor ?? open) : open,
    readerId: oneColumn ? open : null,
    onSelect,
    onEnterReader,
    ownFaceFor,
    forwardTargetFor,
  };
}
