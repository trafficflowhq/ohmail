/**
 * The Ohbox's rows as drawn: the three groups after the session's placement, folded one row per conversation, what
 * the list may say about itself, and the voices and the people a folded row speaks for.
 */
import type { EngineMessage } from "@ohmail/wire";
import { countWhen, foldOhboxRows, isOwnSent, listSurface, ohboxUnreadIds } from "@ohmail/client-engine";
import type { ListSurface, OhboxRow as OhboxRowGroup, ResurfacedThreadRow } from "@ohmail/client-engine";
import { useMemo } from "react";
import { NO_ROWS, type SessionPlacement } from "./placement.js";
import type { OhboxListInput, OhboxListModel } from "./types.js";
import { groupPeople, type OhboxPerson } from "./people.js";

/** What the groups are made of: the placement's three groups, the selector's own, the sync's state. */
export interface OhboxGroupsInput {
  displayResurfaced: EngineMessage[];
  displayNew: EngineMessage[];
  displayPrev: EngineMessage[];
  resurfacedRows: ResurfacedThreadRow[];
  newForYou: EngineMessage[];
  previouslySeen: EngineMessage[];
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
  | "listInput"
  | "surface"
  | "mayState"
  | "hasOwnSent"
>;

/** The groups, and where a message stands among them. */
export interface OhboxGroups {
  model: OhboxGroupsModel;
  rowIndexOf: (id: string | null) => number;
}

/** The groups, kept per what they are made of, so `shown`, the walk and what keys on them change only when the list does. */
export function useOhboxGroups(
  input: OhboxListInput,
  { displayResurfaced, displayNew, displayPrev }: SessionPlacement,
): OhboxGroups {
  const { resurfacedRows = NO_ROWS, newForYou, previouslySeen, settled, owed } = input;
  return useMemo(
    () =>
      ohboxGroups({
        displayResurfaced,
        displayNew,
        displayPrev,
        resurfacedRows,
        newForYou,
        previouslySeen,
        settled,
        owed,
      }),
    [displayResurfaced, displayNew, displayPrev, resurfacedRows, newForYou, previouslySeen, settled, owed],
  );
}

export function ohboxGroups({
  displayResurfaced,
  displayNew,
  displayPrev,
  resurfacedRows,
  newForYou,
  previouslySeen,
  settled,
  owed,
}: OhboxGroupsInput): OhboxGroups {
  // Selection and read-state follow the MESSAGES on screen, top to bottom.
  const all = [...displayResurfaced, ...displayNew, ...displayPrev];
  // The rail's own set (`ohboxUnreadIds`): the session placement moves rows, never membership.
  const unreadIds = ohboxUnreadIds(resurfacedRows, { newForYou, previouslySeen });
  /**
   * WHAT THIS LIST IS SHOWING — the three groups, in render order. The one list every VERB resolves against. Mail
   * beyond what this device keeps is History's: the Ohbox has no Older tail, so what it shows is what it holds.
   */
  const shown = all;

  /**
   * ONE ROW PER CONVERSATION, ACROSS SECTIONS — the engine's `foldOhboxRows`, the fold the phone
   * draws too. It runs AFTER session placement, so the session order positions rows but cannot
   * make a second one: a member still sliding out of New keeps its conversation's row there, and a
   * Sent copy of a conversation standing above rides that row. Messages stay
   * the unit of the meta count, mark-all-read, read state and the pick set.
   */
  const folded = foldOhboxRows(
    { resurfaced: displayResurfaced, new: displayNew, earlier: displayPrev, older: [] },
    resurfacedRows,
  );
  const groupedResurfaced: OhboxRowGroup[] = folded.resurfaced;
  const groupedNew: OhboxRowGroup[] = folded.new;
  const groupedPrev: OhboxRowGroup[] = folded.earlier;
  /** The rows on screen, top to bottom — what j/k walk and what a pick range spans. */
  const navRows: OhboxRowGroup[] = [...groupedResurfaced, ...groupedNew, ...groupedPrev];
  /** The row holding this message, folded or not; -1 for a message not in the three groups. */
  const rowIndexOf = (id: string | null): number =>
    id == null ? -1 : navRows.findIndex((g) => g.members.some((m) => m.id === id));
  /**
   * WHAT THIS PANE MAY SAY ABOUT ITSELF — one reading, shared with the phone
   * (`@ohmail/client-engine`'s `listSurface`). Every claim below is derived from it: the empty
   * sentence, the header count and the doorbell's "All clear". They were
   * hand-written conditions and they disagreed — the sentence waited for `settled`, the
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
      listInput,
      surface,
      mayState,
      hasOwnSent,
    },
    rowIndexOf,
  };
}

/**
 * A row's people, asked of its conversation once a row and kept: per row as drawn (a row is the same object while the
 * groups stand, and a new one when they move) and per asker (a shell hands a new one when its mirror moves). A redraw
 * that moves nothing, the clock's included, asks no conversation; a conversation is a walk of the whole mirror.
 */
export function useGroupPeople(
  conversationOf: ((messageId: string) => readonly EngineMessage[]) | undefined,
): (g: OhboxRowGroup) => OhboxPerson[] {
  return useMemo(() => {
    const kept = new WeakMap<OhboxRowGroup, OhboxPerson[]>();
    return (g: OhboxRowGroup): OhboxPerson[] => {
      let people = kept.get(g);
      if (people === undefined) {
        people = groupPeople(g, conversationOf);
        kept.set(g, people);
      }
      return people;
    };
  }, [conversationOf]);
}
