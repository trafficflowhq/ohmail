"use client";

/**
 * THE MODEL OF THE THREE PILES (Answer Later, Parked, Resurface): one body for the three places, the pile the route
 * names, the counts the switch says, the rows, the letter open in the reader's column with its visit, the cursor's row
 * and the list's walk (the list places' one walk, `../place-list/walk.ts`: the steps by key, Enter, the first letter
 * on arrival, the placer), a Resurface row's Done, and the Reply Run over Answer Later. Called once, above both panes.
 */
import { useStableCallback } from "../press/stable-callback.js";
import { createContext, useContext, useLayoutEffect, useMemo, type Context } from "react";
import type { TriagePileEntry, TriagePiles } from "@ohmail/client-engine";
import { countWhen } from "@ohmail/client-engine";
import type { EngineMessage } from "@ohmail/wire";
import { usePlaceList, type PlaceListInput } from "../place-list/place-list.js";
import type { ListArrival, ListWalk, ListWalkSeat } from "../place-list/walk.js";
import type { MessageAction } from "../press/actions.js";
import type { ListVisit } from "../reading/list-meeting.js";
import type { ReaderMarkSeen, ThreadReadWiring } from "../reading/reader-seen.js";
import { useReplyRun, type ReplyRun } from "./reply-run.js";

export const PILE_IDS = ["later", "parked", "resurface"] as const;
export type PileId = (typeof PILE_IDS)[number];
/** Each place's pile in the engine's piles. */
export const PILE_OF: Readonly<Record<PileId, keyof TriagePiles>> = {
  later: "replyLater",
  parked: "setAside",
  resurface: "resurface",
};

export interface PileRow {
  /** The letter's id, else the entry's title (a thing set to return with no letter behind it). */
  readonly key: string;
  readonly entry: TriagePileEntry;
  readonly message: EngineMessage | null;
}

/** What a host hands the piles, under today's names (`TriageView`'s props). */
export interface PilesInput {
  readonly pile: PileId;
  readonly piles: TriagePiles;
  readonly messageOf: (id: string) => EngineMessage | null;
  readonly settled: boolean;
  readonly owed: boolean;
  /** The letter open (the route's), and the way to open one. */
  readonly openId: string | null;
  readonly open: (id: string | null, how?: "replace") => void;
  /** A verb on a letter, through the press seam. */
  readonly onAction: (action: MessageAction, message: EngineMessage) => void;
  /** The shell's `markSeen`: the column's read rule writes through it. */
  readonly markSeen: ReaderMarkSeen;
  /** Open the reply to a letter in the column (the Reply Run's step). */
  readonly write: (messageId: string) => void;
  readonly close?: (messageId: string) => void;
  /** An instant as a row prints it, in the seat's words (as the Ohbox's rows take theirs). */
  readonly stamp: (iso: string) => string;
  /** What the list's walk reads of the window and the address, and says in the key sheet. */
  readonly walk: ListWalkSeat;
  readonly entered?: PlaceListInput["entered"];
  /** Whether the pile's first letter stands open on arrival where two columns stand: the place's own word. */
  readonly arrival: ListArrival;
}

export interface PilesModel {
  readonly pile: PileId;
  readonly mayState: boolean;
  readonly counts: Readonly<Record<PileId, number>>;
  readonly rows: readonly PileRow[];
  readonly openId: string | null;
  /** The cursor's row: the open letter where two columns stand, the list's own row where one does. */
  readonly cursor: string | null;
  /** The list's walk (`../place-list/walk.ts`): its two steps for the reading column, its keys for the live hook. */
  readonly walk: ListWalk;
  /** The open letter's visit, for the reader's column. */
  readonly wiring: ThreadReadWiring | null;
  readonly visit: ListVisit | null;
  readonly run: ReplyRun;
  /** An instant as a row prints it: when a row's letter came. */
  readonly stamp: (iso: string) => string;
  /** A press on a row: the cursor goes there, the letter opens and its visit is entered. */
  open(row: PileRow): void;
  /** A Resurface row's Done. */
  done(row: PileRow): void;
  /** A verb on the open letter. */
  act(action: MessageAction): void;
}

export const PilesModelContext: Context<PilesModel | null> = createContext<PilesModel | null>(null);

export function usePilesModel(): PilesModel {
  const model = useContext(PilesModelContext);
  if (model === null) throw new Error("usePilesModel() was called with no pile above it");
  return model;
}

const NO_ENTERED: PlaceListInput["entered"] = { letter: null, taken: () => undefined };

export function usePiles(input: PilesInput): PilesModel {
  const { piles, pile, messageOf, openId, open: openLetter } = input;
  const rows = useMemo(
    () =>
      piles[PILE_OF[pile]].map((entry): PileRow => {
        const message = entry.messageId ? messageOf(entry.messageId) : null;
        return { key: entry.messageId ?? entry.title, entry, message };
      }),
    [piles, pile, messageOf],
  );
  const representative =
    openId === null ? undefined : rows.find(({ entry }) => entry.memberIds?.includes(openId))?.message?.id;
  useLayoutEffect(() => {
    if (representative !== undefined && representative !== openId) openLetter(representative, "replace");
  }, [openLetter, openId, representative]);
  const counts = useMemo(
    () => ({
      later: piles.replyLater.length,
      parked: piles.setAside.length,
      resurface: piles.resurface.length,
    }),
    [piles],
  );
  const letters = useMemo(() => rows.flatMap(({ message }) => (message ? [message] : [])), [rows]);
  const list = usePlaceList({
    rows: letters,
    openId,
    open: input.open,
    arrival: input.arrival,
    markSeen: input.markSeen,
    act: input.onAction,
    entered: input.entered ?? NO_ENTERED,
    walk: input.walk,
  });

  const laterIds = useMemo(
    () => (pile === "later" ? letters.map((letter) => letter.id) : []),
    [pile, letters],
  );
  const run = useReplyRun(laterIds, {
    openId,
    open: (id) => input.open(id),
    write: input.write,
    ...(input.close ? { close: input.close } : {}),
  });

  const { press } = list;
  const open = useStableCallback((row: PileRow) => {
    if (row.message) press(row.message.id);
  });
  const done = (row: PileRow): void => {
    if (row.message) input.onAction("resurface_done", row.message);
  };
  const act = (action: MessageAction): void => {
    list.visit?.act(action);
  };

  return {
    pile,
    mayState: countWhen({ settled: input.settled, count: rows.length, pending: input.owed }, true) === true,
    counts,
    rows,
    openId,
    cursor: list.cursor,
    walk: list.walk,
    wiring: list.visit?.wiring ?? null,
    visit: list.visit,
    run,
    stamp: input.stamp,
    open,
    done,
    act,
  };
}
