/**
 * The Ohbox's rows as drawn: the three groups after the session's placement and the Older tail, folded one row per
 * conversation, what the list may say about itself, and the voices a folded row speaks for.
 */
import {
  arrivalMs,
  countWhen,
  foldOhboxRows,
  isOwnSent,
  listSurface,
  ohboxUnreadIds,
} from "@ohmail/client-engine";
import type {
  EngineMessage,
  ListSurface,
  OhboxRow as OhboxRowGroup,
  ResurfacedThreadRow,
} from "@ohmail/client-engine";
import { useMemo } from "react";
import type { OlderMail } from "../lists/older-mail.js";
import { NO_ROWS, type SessionPlacement } from "./placement.js";
import type { OhboxListInput, OhboxListModel } from "./types.js";

/** What the groups are made of: the placement's three groups, the selector's own, the Older tail, the sync's state. */
export interface OhboxGroupsInput {
  displayResurfaced: EngineMessage[];
  displayNew: EngineMessage[];
  displayPrev: EngineMessage[];
  resurfacedRows: ResurfacedThreadRow[];
  newForYou: EngineMessage[];
  previouslySeen: EngineMessage[];
  older: Pick<OlderMail, "items">;
  settled: boolean;
  owed: boolean;
}

/** The model's fields the groups answer. */
export type OhboxGroupsModel = Pick<
  OhboxListModel,
  | "all"
  | "shown"
  | "unreadIds"
  | "navRows"
  | "groupedResurfaced"
  | "groupedNew"
  | "groupedPrev"
  | "olderRows"
  | "olderShown"
  | "listInput"
  | "surface"
  | "mayState"
  | "hasOwnSent"
>;

/** The groups, and where a message stands among them. */
export interface OhboxGroups {
  model: OhboxGroupsModel;
  rowIndexOf: (id: string | null) => number;
  olderRowOf: (id: string) => OhboxRowGroup | undefined;
}

/**
 * The groups, kept per what they are made of (the Older tail's rows are kept by `useOlderMail`), so `shown`, the walk
 * and what keys on them change only when the list does.
 */
export function useOhboxGroups(
  input: OhboxListInput,
  { displayResurfaced, displayNew, displayPrev }: SessionPlacement,
): OhboxGroups {
  const { resurfacedRows = NO_ROWS, newForYou, previouslySeen, settled, owed } = input;
  const olderItems = input.older.items;
  return useMemo(
    () =>
      ohboxGroups({
        displayResurfaced,
        displayNew,
        displayPrev,
        resurfacedRows,
        newForYou,
        previouslySeen,
        older: { items: olderItems },
        settled,
        owed,
      }),
    [
      displayResurfaced,
      displayNew,
      displayPrev,
      resurfacedRows,
      newForYou,
      previouslySeen,
      olderItems,
      settled,
      owed,
    ],
  );
}

export function ohboxGroups({
  displayResurfaced,
  displayNew,
  displayPrev,
  resurfacedRows,
  newForYou,
  previouslySeen,
  older,
  settled,
  owed,
}: OhboxGroupsInput): OhboxGroups {
  // Selection and read-state follow the MESSAGES on screen, top to bottom.
  const all = [...displayResurfaced, ...displayNew, ...displayPrev];
  // The rail's own set (`ohboxUnreadIds`): the session placement moves rows, never membership.
  const unreadIds = ohboxUnreadIds(resurfacedRows, { newForYou, previouslySeen });
  /**
   * WHAT THIS LIST IS SHOWING — the three groups and the server-paged Older tail, in render order.
   * The one list every VERB resolves against.
   *
   * `all` above stays the three groups, and the split is the point: `all` is what the pane's own
   * CLAIMS are made of — the unread count, the empty sentence, the doorbell — and a row from
   * beyond the mirror window is not part of what this Ohbox holds. Reach and counting were one
   * list, so a row `Load older` had just put on screen could be looked at and nothing else.
   * Nothing here sorts; the sections decide what is where.
   */
  const inGroups = new Set(all.map((m) => m.id));
  const olderShown = older.items.filter((m) => !inGroups.has(m.id));
  const shown = olderShown.length === 0 ? all : [...all, ...olderShown];

  /**
   * ONE ROW PER CONVERSATION, ACROSS SECTIONS — the engine's `foldOhboxRows`, the fold the phone
   * draws too. It runs AFTER session placement, so the session order positions rows but cannot
   * make a second one: a member still sliding out of New keeps its conversation's row there, and a
   * Sent copy or an Older-tail row of a conversation standing above rides that row. Messages stay
   * the unit of the meta count, mark-all-read, read state and the pick set.
   */
  const folded = foldOhboxRows(
    { resurfaced: displayResurfaced, new: displayNew, earlier: displayPrev, older: olderShown },
    resurfacedRows,
  );
  const groupedResurfaced: OhboxRowGroup[] = folded.resurfaced;
  const groupedNew: OhboxRowGroup[] = folded.new;
  const groupedPrev: OhboxRowGroup[] = folded.earlier;
  const olderRows: OhboxRowGroup[] = folded.older;
  /** The rows on screen, top to bottom — what j/k walk and what a pick range spans. */
  const navRows: OhboxRowGroup[] = [...groupedResurfaced, ...groupedNew, ...groupedPrev];
  /** The row holding this message, folded or not; -1 for a message not in the three groups. */
  const rowIndexOf = (id: string | null): number =>
    id == null ? -1 : navRows.findIndex((g) => g.members.some((m) => m.id === id));
  /** The Older-tail row holding this message, or `undefined`. */
  const olderRowOf = (id: string): OhboxRowGroup | undefined =>
    olderRows.find((g) => g.members.some((m) => m.id === id));
  /**
   * WHAT THIS PANE MAY SAY ABOUT ITSELF — one reading, shared with the phone
   * (`@ohmail/client-engine`'s `listSurface`). Every claim below is derived from it: the empty
   * sentence, the header count, the doorbell's "All clear" and the older-mail tail. They were
   * four hand-written conditions and they disagreed — the sentence waited for `settled`, the
   * count spoke the moment one row landed — which is the partial count the review measured.
   */
  const listInput = { settled, count: all.length, pending: owed };
  const surface: ListSurface = listSurface(listInput);
  /** May this pane state a number, or locate the mail, as fact yet? — `countWhen`'s predicate. */
  const mayState = countWhen(listInput, true) === true;
  /** Does "Earlier" hold any of the account's own sent mail? Gates the history-window note. */
  const hasOwnSent = all.some(isOwnSent);
  return {
    model: {
      all,
      shown,
      unreadIds,
      navRows,
      groupedResurfaced,
      groupedNew,
      groupedPrev,
      olderRows,
      olderShown,
      listInput,
      surface,
      mayState,
      hasOwnSent,
    },
    rowIndexOf,
    olderRowOf,
  };
}

/**
 * THE VOICES A GROUPED ROW SPEAKS FOR — one message per distinct sender, newest first. The unread members while the
 * conversation is waiting (what is unanswered is what the row is for), else the newest member alone once it has all
 * been read. Returns the MESSAGES rather than their names because two things are derived from this list and they
 * must not drift: the sender line ({@link groupSenders}) and the row's lead circles. A row whose text reads "Ada
 * Lund, Bo Ek" and whose faces are somebody else's would be two answers to one question.
 */
export const groupVoices = (g: OhboxRowGroup): EngineMessage[] => {
  const ms = (m: EngineMessage): number => arrivalMs(m) ?? Number.NEGATIVE_INFINITY;
  const pool = (g.unreadCount > 0 ? g.members.filter((m) => m.unread) : [g.face])
    .slice()
    .sort((a, b) => (ms(a) === ms(b) ? 0 : ms(b) - ms(a)));
  const seen = new Set<string>();
  const out: EngineMessage[] = [];
  for (const m of pool) {
    const key = m.from.address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
};

/** A grouped row's sender summary: the distinct unread voices, newest first. */
export const groupSenders = (g: OhboxRowGroup, senderName: (m: EngineMessage) => string): string =>
  groupVoices(g).map(senderName).join(", ");
