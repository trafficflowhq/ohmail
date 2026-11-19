/**
 * WHAT A LIST HANDS THE READING COLUMN. The letter it opened comes with the list's own visit of it (the read rule's
 * record and the hold's doors, the read set, the open row's verbs and the two steps), and with nothing open the
 * list says what it holds. One object for any list, so the column never reads a list's own model.
 */
import { createContext, useContext, type Context } from "react";
import type { EngineMessage } from "@ohmail/wire";
import type { MessageAction, MoveTarget } from "../press/actions.js";
import type { ThreadReadWiring } from "./reader-seen.js";

export interface ListStep {
  readonly disabled: boolean;
  readonly run: () => void;
  readonly label: string;
}

/** What a list hands the reading column for the letter it opened. */
export interface ListVisit {
  /** The letter this visit is of. */
  readonly openId: string;
  /** As its row presents it: a letter that came back reads unread whatever its stored flag says. */
  readonly unread: boolean;
  /** The read rule's record, the hold's doors, the walk channel. */
  readonly wiring: ThreadReadWiring;
  /** What the read slot marks; empty, the slot offers Mark unread. */
  readonly readSet: readonly string[];
  /** A verb on the open letter, through the list's own path. */
  readonly act: (action: MessageAction) => void;
  readonly step: { readonly up: ListStep; readonly down: ListStep };
}

/** What a list says in the reading column while nothing is open. */
export interface ListBlank {
  readonly label: string;
  readonly hot: boolean;
}

export interface ListMeeting {
  readonly visit: ListVisit | null;
  readonly blank: ListBlank | null;
}

export const ListMeetingContext: Context<ListMeeting | null> = createContext<ListMeeting | null>(null);

/** The visit of exactly this letter, else null. A visit of another letter is never returned. */
export function useListVisit(openId: string | null): ListVisit | null {
  const meeting = useContext(ListMeetingContext);
  const visit = meeting?.visit ?? null;
  return visit !== null && openId !== null && visit.openId === openId ? visit : null;
}

/** undefined: no list stands above (the column says its own word). null: the list says nothing. */
export function useListBlank(): ListBlank | null | undefined {
  const meeting = useContext(ListMeetingContext);
  return meeting === null ? undefined : meeting.blank;
}

/** A place that presents its own reading cards supplies their Move through the same filing path as a list. */
export type ListMove = (message: EngineMessage, place: MoveTarget) => void;
export const ListMoveContext = createContext<ListMove | null>(null);
