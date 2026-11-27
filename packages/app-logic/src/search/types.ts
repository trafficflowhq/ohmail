/**
 * SEARCH'S SHAPES: what a host hands the list's behaviour (`SearchListInput`), who a question is about
 * (`SearchPerson`) and its days (`SearchDates`), how every pass ends (`SearchVerdict`), what stands in each slot of
 * the one list (`SearchSlot`), and the model the behaviour hands back (`SearchListModel`). No markup.
 */
import type { EngineMessage, Folder } from "@ohmail/wire";
import type { RefObject } from "react";
import type {
  AddressBookEntry,
  OhmailEngine,
  SearchHit,
  ServerSearchFacets,
  ServerSearchSort,
} from "@ohmail/client-engine";
import type { StorageScope } from "../storage/scope.js";
import type { Translator } from "../text/translator.js";
import type { RestingSearchPerson } from "./people.js";

/** Who a person-first question is about, and on which side of the letter. */
export interface SearchPerson {
  readonly address: string;
  readonly name: string | null;
  readonly dir: "any" | "from" | "to";
}

export type { RestingSearchPerson } from "./people.js";

/** A day window, both ends inclusive, as the person picked it (`YYYY-MM-DD`); either end may stand open. */
export interface SearchDates {
  readonly from: string | null;
  readonly to: string | null;
}

/** How large the match set is, as the store said it. */
export interface SearchCount {
  readonly kind: "exact" | "about" | "atLeast";
  readonly n: number;
}

/**
 * EVERY WAY A PASS ENDS. `none` no question; `device` the device's rows alone (a single character, or before the
 * store is asked); `searching`; `unfinished` (nothing in the newest mail and the end not reached: no verdict yet);
 * `noStore` (no store on this host: the device's rows are the answer); `matched` (whose mail: the whole mailbox, the
 * part synced so far, or a paired computer's mirror; the count; closest words or not; the wait); `unanswered` (the
 * server did not answer, or `refused`: it answered with a fault). The switch over it is exhaustive.
 */
export type SearchVerdict =
  | { readonly kind: "none" }
  | { readonly kind: "device" }
  | { readonly kind: "searching" }
  | { readonly kind: "unfinished" }
  | { readonly kind: "noStore" }
  | {
      readonly kind: "matched";
      readonly scope: "whole" | "synced" | "mirror";
      readonly count: SearchCount;
      readonly near: boolean;
      readonly waitedMs: number | null;
    }
  | { readonly kind: "unanswered"; readonly refused: boolean };

/** One slot of the one list: a result, a place owed until its page lands, or nothing where a row was deleted. */
export type SearchSlot =
  | { readonly kind: "hit"; readonly hit: SearchHit; readonly similar: boolean }
  | { readonly kind: "owed" }
  | { readonly kind: "gone" };

/** A pressed facet: the store's own key for it (a folder path, a sender's address), or files. */
export type SearchFacetPick =
  | { readonly group: "folder"; readonly key: string; readonly raw: string | null; readonly exactPath?: true }
  | { readonly group: "from"; readonly key: string; readonly raw: string | null }
  | { readonly group: "refine" };

/** A facet as the list offers it: its group, its key, its count where the store's total is exact, pressed or not. */
export interface SearchFacetItem {
  readonly pick: SearchFacetPick;
  /** A sender as the facet names them, the words for files; for a folder its key (a place's id, else the leaf), which the screen names. */
  readonly label: string;
  readonly count: number | null;
  readonly pressed: boolean;
}
export interface SearchFacetGroup {
  readonly group: SearchFacetPick["group"];
  readonly items: readonly SearchFacetItem[];
}

/** What a host hands the list's behaviour. The scope is the host's, never looked up; no part of it is defaulted. */
export interface SearchListInput {
  readonly engine: OhmailEngine;
  /** Whose stored order this is; `false`: drawn under no scope, so the order holds for the mount and is stored nowhere. */
  readonly scope: StorageScope | false;
  readonly query: string;
  readonly onQuery: (q: string) => void;
  readonly onOpen: (hit: SearchHit, words: Readonly<Record<string, string>>, entered?: boolean) => void;
  readonly onRefine?: (words: Readonly<Record<string, string>>) => void;
  /** Routing and deletes held for Undo by the shared reader. */
  readonly holds?: { readonly held: ReadonlySet<string>; readonly places: ReadonlyMap<string, Folder> };
  readonly linkWords?: Readonly<Record<string, string>>;
  readonly openId?: string | null;
  /** Arrow and letter keys follow the preview when the list is beside it. */
  readonly walkPreview?: boolean;
  readonly closePreview?: () => void;
  readonly dismissPreview?: () => void;
  /** Escape's second press: back to where Search was opened; `none` stops at clearing the box. */
  readonly onExit: (() => void) | "none";
  /** The box, where the caret is put back. */
  readonly boxRef: RefObject<HTMLInputElement | null>;
  /** The list's scroller, which the window over the store's slots reads. */
  readonly scrollerRef: RefObject<HTMLElement | null>;
  /** The `search` namespace's reader, for the key sheet's labels. */
  readonly t: Translator;
  /**
   * Whether this host's server takes a person, unread and the days (its hello said so): only then are they offered
   * and sent. A host that holds no hello answers `words`.
   */
  readonly searchBy: "people" | "words";
  readonly people?: () => readonly AddressBookEntry[];
  readonly readMailboxTotal?: () => Promise<number | null>;
}

/** The model `useSearchList` hands back: everything the markup reads, and every act it can ask for. */
export interface SearchListModel {
  /** The question as the host holds it, untrimmed: what the field shows. */
  readonly query: string;
  /** The words asked, trimmed: where a person may be set, without a `from:` or `to:` still being typed. */
  readonly text: string;
  /** The box and the list's scroller the host handed in: the screen stands them on its field and its scroller. */
  readonly boxRef: RefObject<HTMLInputElement | null>;
  readonly scrollerRef: RefObject<HTMLElement | null>;
  /** The order asked: the kept one, but best match for no words in an order the store answers only with words. */
  readonly sort: ServerSearchSort;
  /** Keep an order (per scope); the kept one stays while no words ask another. */
  readonly setSort: (sort: ServerSearchSort) => void;
  readonly verdict: SearchVerdict;
  /** The device's index has not caught up with this mirror. */
  readonly indexing: boolean;
  /** The store is still indexing: how far, in percent; null when it is not. */
  readonly storeIndexing: number | null;
  /** The store has not taken in the whole mailbox yet. */
  readonly syncing: boolean;
  /** Past a cut set's last relevance page: the rows walked, said once the walk ends. */
  readonly bounded: number | null;
  /** The device's own pass, in ms. */
  readonly tookMs: number;
  /** How many slots the list has, and what stands in each. */
  readonly length: number;
  slotAt(i: number): SearchSlot;
  /** The list's size as a screen reader hears it; -1 while unknown. */
  readonly setSize: number;
  /** The count the head states. */
  readonly found: number;
  /** The closest words are listed, not matches. */
  readonly similar: boolean;
  /** Where a part inside a word is looked for, said on an empty or closest-words answer. */
  readonly partsSaid: boolean;
  readonly cursor: number;
  readonly facets: readonly SearchFacetGroup[];
  /** An empty field with no filter set. */
  readonly resting: boolean;
  readonly restingPeople: readonly RestingSearchPerson[];
  /** Whole History count from the host, or null while unknown. */
  readonly mailboxTotal: number | null;
  readonly filtered: boolean;
  pick(facet: SearchFacetPick): void;
  /** Ask the store again (the verdict's retry). */
  retry(): void;
  /** The list scrolled near its end: the next page, or past the walk's bound, further. */
  nearEnd(): void;
  /** The store's slots on screen, for the window. */
  readonly window: {
    readonly start: number;
    readonly end: number;
    readonly padTop: number;
    readonly padBottom: number;
  };
  /** The text is a lone address: the empty answer offers the address's own view. */
  readonly addressOnly: boolean;
  /** Whose rows the list holds: the device's first paint (drawn whole), or the store's pages (a window over its slots). */
  readonly listing: "device" | "store";
  /** The slot the closest words' heading stands above; null when none are listed. */
  readonly similarFrom: number | null;
  /** The closest words are of the part synced so far. */
  readonly similarSynced: boolean;
  /** The verdict carries the store's count (and the head then says no count of its own unless a facet narrows). */
  readonly counts: boolean;
  /** An empty list is a settled answer: "Nothing matched" may be said. */
  readonly settledEmpty: boolean;
  /** The store counted exactly nothing: the depth it searched is said. */
  readonly nothingMatched: boolean;
  /** The wait the head states beside its count, in ms: this device's pass, else the store's measured wait. */
  readonly headMs: number | null;
  /** Whether a person, unread and the days may be set (the host's server takes them). */
  readonly searchBy: "people" | "words";
  /** The person the question is about, and on which side; null for everybody. */
  readonly person: SearchPerson | null;
  readonly unread: boolean;
  readonly date: SearchDates | null;
  /** Something beside the words narrows the question: with no words it is a question too. */
  readonly narrowed: boolean;
  /** Set or let go the person (and their side), unread, the days: each a new question, asked at once. */
  setPerson(person: SearchPerson | null): void;
  setUnread(on: boolean): void;
  setDate(date: SearchDates | null): void;
  /** A result pressed: the host opens it. */
  open(hit: SearchHit): void;
  afterAction(message: EngineMessage): boolean;
  /** The person typed: the text handed on; a pressed facet is let go, but for the place and the files where a person may be set. */
  type(q: string): void;
  /** Enter: the question is asked at once. */
  submit(): void;
}
