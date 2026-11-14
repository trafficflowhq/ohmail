/**
 * THE VERDICT, AS DATA: one always on screen while a question is — searching, matched, nothing matched, or the server
 * did not answer — and it says truthfully whose mail was searched. A refusal is the third, never the server's text.
 */
import { storeRefused, type StoreSearchMeta, type StoreSearchState } from "@ohmail/client-engine";
import type { SearchCount, SearchListModel, SearchVerdict } from "./types.js";

export interface VerdictReading {
  /** The question as typed, trimmed. */
  readonly text: string;
  readonly passState: StoreSearchState;
  readonly ready: StoreSearchMeta | null;
  readonly cause: string | null;
  /** The store is asked with a filter: with no words that is a question too. */
  readonly filtered: boolean;
}

/** Exact, else the estimate's "about N" (never of closest words), else the page's bound. */
function countOf(ready: StoreSearchMeta, near: boolean): SearchCount {
  if (ready.totalExact) return { kind: "exact", n: ready.total };
  if (ready.about !== null && !near) return { kind: "about", n: ready.about };
  return { kind: "atLeast", n: ready.total };
}

/** The text, or a filter with no words, is a question the store is asked. */
const askedOf = (text: string, filtered: boolean): boolean => text.length >= 2 || (text === "" && filtered);

export function verdictOf({ text, passState, ready, cause, filtered }: VerdictReading): SearchVerdict {
  if (text === "" && !filtered) return { kind: "none" };
  if (!askedOf(text, filtered)) return { kind: "device" };
  if (passState === "idle" || passState === "searching") return { kind: "searching" };
  if (passState === "unavailable") return { kind: "noStore" };
  /* Nothing in the newest mail and the end not reached: no verdict yet. */
  if (passState === "unfinished") return { kind: "unfinished" };
  /* A server that answered with a fault could not run the search; it did answer. */
  if (passState === "unanswered" || ready === null)
    return { kind: "unanswered", refused: storeRefused(cause) };
  /* Closest words are near, never matched: their count is said as such. */
  const near = ready.tier === "similar";
  return {
    kind: "matched",
    /* A desktop paired with ohmail Cloud whose account did not answer: its mirror did, and the sentence says whose
       mail that is. The store that has not taken in the whole mailbox yet says what it searched. */
    scope: ready.fromMirror ? "mirror" : ready.importing ? "synced" : "whole",
    count: countOf(ready, near),
    near,
    /* THE TIME SAID IS THE WAIT A PERSON HAD: page one's request leaving to its verdict on screen, never the store's
       own time. Until it is measured, none. */
    waitedMs: ready.waitedMs ?? null,
  };
}

/** The verdict carries the store's count: the store answered this question and its pass did not end unanswered. */
export function verdictCounts({ text, passState, ready, filtered }: VerdictReading): boolean {
  return (
    askedOf(text, filtered) &&
    ready !== null &&
    passState !== "idle" &&
    passState !== "searching" &&
    passState !== "unavailable" &&
    passState !== "unanswered"
  );
}

/** What the walk said beside the verdict: whether this device's pass answered, its time, and how far the walk got. */
export interface VerdictBeside {
  readonly answered: boolean;
  readonly tookMs: number;
  readonly atEnd: boolean;
  readonly walked: number;
}

/** The model's sentences about the pass: the verdict, and the lines beside it. */
export function verdictModel(
  reading: VerdictReading,
  { answered, tookMs, atEnd, walked }: VerdictBeside,
): Pick<
  SearchListModel,
  | "verdict"
  | "counts"
  | "settledEmpty"
  | "nothingMatched"
  | "storeIndexing"
  | "syncing"
  | "bounded"
  | "headMs"
  | "similarSynced"
> {
  const { passState, ready } = reading;
  const counts = answered && verdictCounts(reading);
  return {
    verdict: verdictOf(reading),
    counts,
    settledEmpty: passState !== "idle" && passState !== "searching" && passState !== "unfinished" && !counts,
    nothingMatched: counts && ready?.total === 0,
    storeIndexing: ready?.indexed ? Math.floor((100 * ready.indexed.done) / ready.indexed.total) : null,
    syncing: ready?.importing === true && !ready.fromMirror,
    /* A count that landed as exactly 0 has no best matches to show, nor a rest to walk. */
    bounded: ready?.bounded && atEnd && !(ready.totalExact && ready.total === 0) ? walked : null,
    headMs: ready === null ? tookMs : ready.waitedMs,
    similarSynced: ready !== null && ready.importing && !ready.fromMirror,
  };
}
