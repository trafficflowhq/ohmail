"use client";

/**
 * THE MODEL OF THE THREE PILES (Answer Later, Parked, Resurface): one body for the three places, the pile the route
 * names, the counts the switch says, the rows, the letter open in the reader's column with its visit, a Resurface
 * row's Done, and the Reply Run over Answer Later. Called once, above both panes.
 */
import { createContext, useCallback, useContext, useMemo, type Context } from "react";
import type { EngineMessage, TriagePileEntry, TriagePiles } from "@ohmail/client-engine";
import type { MessageAction } from "../press/actions.js";
import { useReaderVisit, type ReaderMarkSeen, type ThreadReadWiring } from "../reading/reader-seen.js";
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
  readonly open: (id: string | null) => void;
  /** A verb on a letter, through the press seam. */
  readonly onAction: (action: MessageAction, message: EngineMessage) => void;
  /** The shell's `markSeen`: the column's read rule writes through it. */
  readonly markSeen: ReaderMarkSeen;
  /** Open the reply to a letter in the column (the Reply Run's step). */
  readonly write: (messageId: string) => void;
  /** An instant as a row prints it, in the seat's words (as the Ohbox's rows take theirs). */
  readonly stamp: (iso: string) => string;
}

export interface PilesModel {
  readonly pile: PileId;
  readonly mayState: boolean;
  readonly counts: Readonly<Record<PileId, number>>;
  readonly rows: readonly PileRow[];
  readonly openId: string | null;
  /** The open letter's visit, for the reader's column. */
  readonly wiring: ThreadReadWiring | null;
  readonly run: ReplyRun;
  /** An instant as a row prints it: when a row's letter came. */
  readonly stamp: (iso: string) => string;
  open(row: PileRow): void;
  /** The row `by` steps from the open one, or null. */
  stepFrom(by: 1 | -1): PileRow | null;
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

export function usePiles(input: PilesInput): PilesModel {
  const { piles, pile, messageOf, openId } = input;
  const rows = useMemo(
    () =>
      piles[PILE_OF[pile]].map((entry): PileRow => {
        const message = entry.messageId ? messageOf(entry.messageId) : null;
        return { key: entry.messageId ?? entry.title, entry, message };
      }),
    [piles, pile, messageOf],
  );
  const counts = useMemo(
    () => ({
      later: piles.replyLater.length,
      parked: piles.setAside.length,
      resurface: piles.resurface.length,
    }),
    [piles],
  );
  const shown = openId === null ? null : (rows.find((r) => r.message?.id === openId)?.message ?? null);
  const visit = useReaderVisit({ shown, markSeen: input.markSeen });

  const laterIds = useMemo(
    () => piles.replyLater.flatMap((e) => (e.messageId ? [e.messageId] : [])),
    [piles.replyLater],
  );
  const run = useReplyRun(pile === "later" ? laterIds : [], {
    openId,
    open: (id) => input.open(id),
    write: input.write,
  });

  const open = useCallback(
    (row: PileRow) => {
      if (!row.message) return;
      visit.enter(row.message.id);
      input.open(row.message.id);
    },
    [visit, input],
  );
  const stepFrom = (by: 1 | -1): PileRow | null => {
    const openable = rows.filter((r) => r.message !== null);
    const at = openable.findIndex((r) => r.message!.id === openId);
    if (at < 0) return null;
    return openable[at + by] ?? null;
  };
  const done = (row: PileRow): void => {
    if (row.message) input.onAction("resurface_done", row.message);
  };
  const act = (action: MessageAction): void => {
    if (shown) input.onAction(action, shown);
  };

  return {
    pile,
    mayState: input.settled && !input.owed,
    counts,
    rows,
    openId,
    wiring: visit.wiring,
    run,
    stamp: input.stamp,
    open,
    stepFrom,
    done,
    act,
  };
}
