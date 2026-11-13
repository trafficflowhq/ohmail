/**
 * SEARCH over what the device holds: titles, places, people and notes. Every typed word must be found,
 * as the start of a word, or (four letters or more) one slip away: one letter wrong, added or left out,
 * or two neighbours swapped. Upcoming first, then what has been, the newest first. A date typed is not
 * read here: that needs the sentence reader, which this release does not build.
 */
import type { ZoneSource } from "@ohmail/cal-core";
import { daySpanOf, type DayId, type Placed } from "./days.js";

/** Lower case, accents dropped, ß as ss. */
export const fold = (s: string): string =>
  s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/ß/g, "ss");

export const wordsOf = (s: string): string[] =>
  fold(s)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** How many slips lie between two words, a swap of neighbours counted as one; anything over `max` is `max + 1`. */
export function slips(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let p2: number[] | null = null;
  let p1 = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(p1[j]! + 1, cur[j - 1]! + 1, p1[j - 1]! + c);
      if (p2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        cur[j] = Math.min(cur[j]!, p2[j - 2]! + 1);
    }
    p2 = p1;
    p1 = cur;
  }
  return Math.min(p1[b.length]!, max + 1);
}

/** A typed word against an event's words: the word it was read as, or null. */
function readAs(w: string, words: readonly string[]): string | null {
  if (words.some((t) => t.startsWith(w))) return w;
  if (w.length < 4) return null;
  for (const t of words) {
    if (slips(w, t, 1) <= 1) return t;
    if (t.length > w.length && slips(w, t.slice(0, w.length), 1) <= 1) return t.slice(0, w.length);
  }
  return null;
}

export interface SearchQuery<T extends Placed> {
  readonly query: string;
  readonly items: readonly T[];
  readonly keyOf: (item: T) => string;
  /** The words an item can be found by: title, place, people, notes. */
  readonly textOf: (item: T) => readonly (string | null | undefined)[];
  readonly today: DayId;
  readonly zone: string;
  /** The zone rules the view places by: the same for every view. */
  readonly zones: ZoneSource;
}

export interface SearchHit<T> {
  readonly key: string;
  readonly item: T;
  readonly day: DayId;
  readonly startMinute: number | null;
  /** Its end on the reader's clock where it ends on the same day; null otherwise. */
  readonly endMinute: number | null;
}

export interface SearchResult<T> {
  /** Something was typed. */
  readonly any: boolean;
  readonly hits: readonly SearchHit<T>[];
  /** The words as they were read where a slip was forgiven ("tech check" for "tehc check"); empty otherwise. */
  readonly readAs: string;
  /** Matches that cannot be placed: their time zone is not known on this device. */
  readonly unplaced: number;
}

export function searchEvents<T extends Placed>(q: SearchQuery<T>): SearchResult<T> {
  const typed = wordsOf(q.query);
  if (!typed.length) return { any: false, hits: [], readAs: "", unplaced: 0 };
  const read: (string | undefined)[] = [];
  const hits: SearchHit<T>[] = [];
  let unplaced = 0;
  for (const item of q.items) {
    const words = q.textOf(item).flatMap((t) => (t ? wordsOf(t) : []));
    const as: string[] = [];
    let all = true;
    for (const w of typed) {
      const r = readAs(w, words);
      if (r === null) {
        all = false;
        break;
      }
      as.push(r);
    }
    if (!all) continue;
    const span = daySpanOf(item, q.zone, q.zones);
    if (span === null) {
      unplaced++;
      continue;
    }
    as.forEach((r, i) => {
      if (read[i] === undefined || read[i] === typed[i]) read[i] = r;
    });
    hits.push({
      key: q.keyOf(item),
      item,
      day: span.first,
      startMinute: span.startMinute,
      endMinute: span.last === span.first ? span.endMinute : null,
    });
  }
  hits.sort((a, b) => {
    const ua = a.day >= q.today;
    const ub = b.day >= q.today;
    if (ua !== ub) return ua ? -1 : 1;
    if (a.day !== b.day) return (a.day < b.day ? -1 : 1) * (ua ? 1 : -1);
    return (a.startMinute ?? -1) - (b.startMinute ?? -1);
  });
  const said = typed.map((w, i) => read[i] ?? w).join(" ");
  return { any: true, hits, readAs: said !== typed.join(" ") ? said : "", unplaced };
}
