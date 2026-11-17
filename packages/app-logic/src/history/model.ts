/**
 * HISTORY'S MODEL: every letter, newest first, each with the place it is in as a word; the count; and the letter
 * open among them, as any list beside the reader. While the mirror is owed the list says so, never that nothing is
 * there. The server's store answering nothing is said with its way back.
 */
import { createContext, useContext, useMemo } from "react";
import { zonedFields, type EngineMessage } from "@ohmail/client-engine";
import { newestFirst, usePlaceList, type PlaceList, type PlaceListInput } from "../place-list/place-list.js";
import { readerZone } from "../reader/head-model.js";

export interface HistoryInput extends Omit<PlaceListInput, "rows"> {
  readonly messages: readonly EngineMessage[];
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
  /** The month's newest letter: where a press on the month goes. */
  readonly first: string;
  readonly count: number;
}

export interface HistoryModel {
  readonly list: PlaceList;
  /** The list's months, newest first: what the month rail lays out for the room it has. */
  readonly months: readonly HistoryMonth[];
  readonly count: number;
  readonly loading: boolean;
  readonly empty: boolean;
  readonly placeOf: (m: EngineMessage) => string;
  readonly stamp: (iso: string) => string;
  readonly store: HistoryInput["store"];
}

export function useHistoryList(input: HistoryInput): HistoryModel {
  const { messages, settled, owed } = input;
  const rows = useMemo(() => [...messages].sort(newestFirst), [messages]);
  const list = usePlaceList({ ...input, rows });
  const months = useMemo(() => monthsOf(rows, readerZone()), [rows]);
  const none = rows.length === 0;
  return {
    list,
    months,
    count: rows.length,
    loading: none && (!settled || owed),
    empty: none && settled && !owed,
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
  for (const m of rows) {
    const month = monthIn(m.date, zone);
    const was = at.get(month);
    if (was === undefined) {
      at.set(month, out.length);
      out.push({ month, first: m.id, count: 1 });
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
