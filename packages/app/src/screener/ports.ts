/**
 * WHAT A SHELL HANDS THE SCREENER BESIDE ITS MODEL, by what the Screener calls of it. The held letters' parts are the
 * very objects the shell hands the reader; nothing here is built by the Screener.
 */
import type { SuggestStanding } from "@ohmail/app-logic/screener/no-suggestion";
import type { NoAdvice } from "@ohmail/app-logic/screener";
import type { JunkWindowControl } from "@ohmail/app-logic/screener/junk-window";
import type { ReaderParts } from "../reader/index.js";

/** The parts a held letter is drawn with: its body, its files, its pictures and the one look at a file. */
export type HeldParts = Pick<ReaderParts, "body" | "files" | "pictures" | "look"> &
  Partial<Pick<ReaderParts, "invitation">>;

/**
 * THE SUGGESTION RUN AS THE SCREENER DRIVES IT: the shell's batch control, bound to the senders it would ask about.
 * Nothing is bought before `confirm`; the price is the server's quote for the size chosen.
 */
export interface ScreenerSuggestControl {
  readonly disabled?: boolean;
  /** Waiting senders with no suggestion yet, and those that already have one (asked again at the same price). */
  readonly available: number;
  readonly resuggestable: number;
  /** How many the open ladder draws from. */
  readonly pool: number;
  readonly sizes: readonly number[];
  readonly size: number;
  readonly phase: "closed" | "pricing" | "ready" | "running";
  readonly quote: { readonly senders: number; readonly credits: number } | null;
  /** One sentence about the run, already in the person's words, or null. */
  readonly notice: string | null;
  readonly progress: { readonly done: number; readonly total: number } | null;
  /** Why the last run could not buy, while that still stands (`no_budget`: the balance is empty); null: nothing. */
  readonly standing?: SuggestStanding | null;
  open(): void;
  openAgain(): void;
  choose(size: number): void;
  confirm(): void;
  cancel(): void;
}

export interface ScreenerSuggest {
  /** Each sender asked about costs a credit. */
  readonly priced: boolean;
  readonly control: ScreenerSuggestControl;
  /** What the run knows about senders it has no advice for: why a sender's sentence says none. */
  readonly noAdvice: NoAdvice;
}

/** One letter of the mail server's Junk folder, as the shell's window reads it: header facts, never a mirror row. */
export interface ScreenerJunkItem {
  readonly mailboxId: string;
  readonly uid: number;
  readonly uidValidity: string;
  readonly subject: string;
  readonly from: { readonly name: string | null; readonly address: string };
  readonly date: string | null;
  readonly messageIdHeader: string | null;
  readonly seen: boolean;
  /** Who filed it: this account's verdict, or the mail server's own filter. */
  readonly origin: "verdict" | "provider";
  /** A standing "not junk": waiting for the organizer, or refused by the mail server (a press tries once more). */
  readonly rescue?: "queued" | "refused";
  readonly rescueId?: string;
}

/** One mailbox's Junk window: read, without a Junk folder, or not answering just now. */
export interface ScreenerJunkMailbox {
  readonly id: string;
  readonly address: string;
  readonly window: "ok" | "no_junk_folder" | "unreachable";
}

/** A letter's text, read from the mail server when it opens. */
export type ScreenerJunkBody =
  | { readonly phase: "idle" }
  | { readonly phase: "loading"; readonly attempt: number }
  | { readonly phase: "ready"; readonly text: string }
  | { readonly phase: "failed" };

/** Search Junk: what is typed filters what is loaded; the mail server is asked when that finds nothing, or on a press. */
export interface ScreenerJunkSearch {
  readonly query: string;
  setQuery(q: string): void;
  readonly phase: "idle" | "local" | "searching" | "done" | "failed";
  /** The server's hits not already among the loaded rows. */
  readonly hits: readonly ScreenerJunkItem[];
  /** How many of the window's visible rows are loaded ones: the server's hits begin after them. */
  readonly localCount: number;
  readonly mailboxes: readonly ScreenerJunkMailbox[];
  readonly truncated: boolean;
  searchServer(): void;
}

/**
 * THE JUNK WINDOW AS THE SCREENER DRIVES IT: the shell's window over the mail server's own Junk folder (its offer to
 * move ohmail's kept spam and its list of that spam are not the Screener's). Handed only where a server stands behind
 * it; with it the third section is Junk.
 */
export interface ScreenerJunk {
  readonly supported: boolean;
  /** The list's read: failed is said as failed, never as empty. */
  readonly phase: "loading" | "ready" | "failed";
  readonly items: readonly ScreenerJunkItem[];
  /** What is drawn: the loaded rows, or with a query the matching ones and the server's hits after them. */
  readonly visible: readonly ScreenerJunkItem[];
  readonly mailboxes: readonly ScreenerJunkMailbox[];
  readonly nextCursor: string | null;
  readonly olderLoading: boolean;
  reload(): void;
  loadOlder(): void;
  bodyFor(item: ScreenerJunkItem): ScreenerJunkBody;
  openBody(item: ScreenerJunkItem, opts?: { retry?: boolean }): void;
  /** Not junk: one move back to the inbox; `allow` also lets the sender in from now on. */
  rescue(item: ScreenerJunkItem, opts?: { allow?: boolean }): void;
  rescuing(item: ScreenerJunkItem): boolean;
  /** Leave it in Junk: a refused move is cleared, and the letter stays. */
  dismissRescue(item: ScreenerJunkItem): void;
  readonly search: ScreenerJunkSearch;
  readonly sweep?: JunkWindowControl["sweep"];
  readonly held?: JunkWindowControl["held"];
}
