/**
 * THE QUESTION'S FILTERS ON THE WIRE. A person is `sender` (from them), `to` (to them, To or Cc) or `party` (either
 * side); unread is `unread`; the days are the first and the last millisecond of the days picked, in this window's
 * zone (the service reads both ends inclusive). Only a host whose server said it takes them (`searchBy` "people")
 * sends any of them: an older server ignores what it does not know and would answer every letter under a person's
 * name. A pressed facet goes as it always went.
 */
import { useMemo, useState } from "react";
import type { ServerSearchFilters } from "@ohmail/client-engine";
import { storeFiltersOf, type Pressed } from "./facets.js";
import { parseOperators, withoutOperator } from "./operators.js";
import type { SearchDates, SearchListModel, SearchPerson } from "./types.js";

/** Whether the host's server takes the question's filters (its hello said so), or words and facets only. */
export type SearchBy = "people" | "words";

/** What the person set beside the words. */
export interface SearchNarrowing {
  readonly person: SearchPerson | null;
  readonly unread: boolean;
  readonly date: SearchDates | null;
}

export const NO_NARROWING: SearchNarrowing = { person: null, unread: false, date: null };

/** `YYYY-MM-DD` as this window's midnight, or null for a day that is not one. */
function localDay(day: string): Date | null {
  if (day.length !== 10 || day[4] !== "-" || day[7] !== "-") return null;
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  const at = new Date(y, m - 1, d, 0, 0, 0, 0);
  return at.getFullYear() === y && at.getMonth() === m - 1 && at.getDate() === d ? at : null;
}

/** The first millisecond of a day and the last, as instants. */
export function dayBounds(day: string): { first: string; last: string } | null {
  const at = localDay(day);
  if (at === null) return null;
  const next = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1, 0, 0, 0, 0);
  return { first: at.toISOString(), last: new Date(next.getTime() - 1).toISOString() };
}

export function filtersOf(n: SearchNarrowing, searchBy: SearchBy): ServerSearchFilters {
  if (searchBy !== "people") return {};
  const out: ServerSearchFilters = {};
  if (n.person !== null) {
    if (n.person.dir === "from") out.sender = n.person.address;
    else if (n.person.dir === "to") out.to = n.person.address;
    else out.party = n.person.address;
  }
  if (n.unread) out.unread = true;
  const from = n.date?.from ? dayBounds(n.date.from) : null;
  const to = n.date?.to ? dayBounds(n.date.to) : null;
  if (from !== null) out.dateFrom = from.first;
  if (to !== null) out.dateTo = to.last;
  return out;
}

/**
 * THE WORDS THE LIST ASKS: the field's text, trimmed; where the host's server takes a person, without a `from:` or
 * `to:` still being typed at its end (it names people, not words, until it is finished or a person is taken).
 */
export function wordsAsked(query: string, searchBy: SearchBy): string {
  if (searchBy !== "people") return query.trim();
  const { open } = parseOperators(query);
  return open !== null && (open.key === "from" || open.key === "to")
    ? withoutOperator(query, open).trim()
    : query.trim();
}

/** Whether anything beside the words narrows the question. */
export const narrowed = (n: SearchNarrowing): boolean => n.person !== null || n.unread || n.date !== null;

/** The question beside its words, as the list holds it: what is set, and what the store is asked with. */
export interface Question {
  readonly narrowing: SearchNarrowing;
  /** What is pressed, as it always went, and the question's own filters beside it; undefined where none is set. */
  readonly storeFilters: ServerSearchFilters | undefined;
  readonly isNarrowed: boolean;
  /** The model's own part of it, as the list hands it on. */
  readonly model: Pick<
    SearchListModel,
    "searchBy" | "person" | "unread" | "date" | "narrowed" | "setPerson" | "setUnread" | "setDate"
  >;
}

/**
 * A person, unread and the days, held only where the host's server takes them: elsewhere the question is the words
 * and the facet. Undefined where nothing is set, so a question with none is the request this build always sent.
 */
export function useQuestion(searchBy: SearchBy, pressed: Pressed): Question {
  const [own, setNarrowing] = useState<SearchNarrowing>(NO_NARROWING);
  const narrowing = searchBy === "people" ? own : NO_NARROWING;
  const storeFilters = useMemo((): ServerSearchFilters | undefined => {
    const both = { ...storeFiltersOf(pressed), ...filtersOf(narrowing, searchBy) };
    return Object.keys(both).length === 0 ? undefined : both;
  }, [pressed, narrowing, searchBy]);
  const isNarrowed = narrowed(narrowing) || (searchBy === "people" && pressed.length > 0);
  return {
    narrowing,
    storeFilters,
    isNarrowed,
    model: {
      searchBy,
      person: narrowing.person,
      unread: narrowing.unread,
      date: narrowing.date,
      narrowed: isNarrowed,
      setPerson: (person) => setNarrowing((n) => ({ ...n, person })),
      setUnread: (unread) => setNarrowing((n) => ({ ...n, unread })),
      setDate: (date) => setNarrowing((n) => ({ ...n, date })),
    },
  };
}
