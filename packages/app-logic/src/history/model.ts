/**
 * HISTORY'S MODEL: every letter, newest first, each with the place it is in as a word; the count; and the letter
 * open among them, as any list beside the reader. While the mirror is owed the list says so, never that nothing is
 * there. The server's store answering nothing is said with its way back.
 */
import type { EngineMessage } from "@ohmail/wire";
import { createContext, useContext, useMemo, type RefObject } from "react";
import { countWhen, listSurface, saysEmpty, zonedFields, type ThreadMark } from "@ohmail/client-engine";
import { newestFirst, usePlaceList, type PlaceList, type PlaceListInput } from "../place-list/place-list.js";
import type { ListWindow } from "../lists/list-window.js";
import { readerZone } from "../reader/head-model.js";

export interface HistoryInput extends Omit<PlaceListInput, "rows"> {
  readonly messages: readonly EngineMessage[];
  readonly conversationMarks?: ReadonlyMap<string, readonly ThreadMark[]>;
  readonly timelineCount?: number;
  readonly timelineMonths?: readonly HistoryMonth[];
  readonly windowed?: HistoryWindow;
  readonly settled: boolean;
  readonly owed: boolean;
  /** The place a letter is in, in the person's words (Ohbox, News, a folder's name). */
  readonly placeOf: (m: EngineMessage) => string;
  readonly stamp: (iso: string) => string;
  /** The server's store did not answer: the device's recent mail stands, with a way to ask again. */
  readonly store: { readonly down: boolean; readonly retry: () => void };
}

/** A month of the list, as the month rail steps through it: its letters stand one after the other. */
export interface HistoryMonth {
  /** "2026-11" in the reader's own zone; null for the letters with no date. */
  readonly month: string | null;
  /** The slot of the month’s newest letter. */
  readonly start: number;
  readonly count: number;
}

export interface HistoryWindow {
  readonly scroller: RefObject<HTMLDivElement | null>;
  readonly window: ListWindow;
  readonly total: number;
  readonly slots: readonly (EngineMessage | "gone" | "folded" | null)[];
  readonly jump: (slot: number) => void;
}

export interface HistoryModel {
  readonly windowed?: HistoryWindow;
  readonly list: PlaceList;
  readonly conversationMarks?: HistoryInput["conversationMarks"];
  /** The list's months, newest first: what the month rail lays out for the room it has. */
  readonly months: readonly HistoryMonth[];
  readonly count: number | undefined;
  readonly loading: boolean;
  readonly empty: boolean;
  readonly placeOf: (m: EngineMessage) => string;
  readonly stamp: (iso: string) => string;
  readonly store: HistoryInput["store"];
}

export function useHistoryList(input: HistoryInput): HistoryModel {
  const { messages, settled, owed } = input;
  const rows = useMemo(
    () => (input.windowed ? messages : [...messages].sort(newestFirst)),
    [input.windowed, messages],
  );
  const list = usePlaceList({ ...input, rows });
  const months = useMemo(
    () => input.timelineMonths ?? monthsOf(rows, readerZone()),
    [input.timelineMonths, rows],
  );
  const facts = { settled, count: input.timelineCount ?? rows.length, pending: owed };
  const surface = listSurface(facts);
  return {
    list,
    conversationMarks: input.conversationMarks,
    months,
    windowed: input.windowed,
    count: countWhen(facts, facts.count),
    loading: surface === "skeleton" || surface === "pending",
    empty: saysEmpty(surface),
    placeOf: input.placeOf,
    stamp: input.stamp,
    store: input.store,
  };
}

/** The month an instant stands in on the reader's calendar, "2026-11"; null for no date. */
function monthIn(iso: string | null | undefined, zone: string): string | null {
  const when = iso ? new Date(iso) : null;
  if (when === null || Number.isNaN(when.getTime())) return null;
  const { year, month } = zonedFields(when, zone);
  return `${year}-${String(month).padStart(2, "0")}`;
}

/**
 * The months of a list newest first, each with its newest letter: the released rail's segments, read off the rows.
 * A letter's month is the reader's own (the zone the store's timeline is asked in), never UTC's.
 */
export function monthsOf(rows: readonly EngineMessage[], zone: string): HistoryMonth[] {
  const out: HistoryMonth[] = [];
  const at = new Map<string | null, number>();
  for (const [start, m] of rows.entries()) {
    const month = monthIn(m.date, zone);
    const was = at.get(month);
    if (was === undefined) {
      at.set(month, out.length);
      out.push({ month, start, count: 1 });
    } else out[was] = { ...out[was]!, count: out[was]!.count + 1 };
  }
  return out;
}

export const HistoryModelContext = createContext<HistoryModel | null>(null);

export function useHistoryModel(): HistoryModel {
  const model = useContext(HistoryModelContext);
  if (model === null) throw new Error("History was drawn with no model above it (HistoryModelContext)");
  return model;
}
