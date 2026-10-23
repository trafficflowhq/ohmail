/**
 * ONE FIXTURE FOR THE TWO CLIENT RETRO PLANNERS AND THE PASS THEY OPTIMISE.
 *
 * The invariant under test: the fifty a client moves at once are a SUBSET of what the server's
 * `ruleRetroPass` would move, in the order the person sees. Two planners answer it —
 * `apps/webapp/app/shell/sender-screening.ts#planScreeningChange` and
 * `apps/mobile/src/state/live.ts#screenSender` — and they live in test programs that cannot import
 * each other, so the fixture lives here and each side reads THIS module. A fixture per surface is
 * how the two spellings drifted in the first place.
 *
 * Every row is one fact the pass narrows on, and `RETRO_MOVES` is hand-named rather than derived:
 * `retro-candidate-parity.test.ts` asserts the exported predicate answers exactly this list, so a
 * mutation of the predicate reddens there and the client tests keep measuring the predicate.
 *
 * NOTHING SITS AT `ohmail/Screener` ON PURPOSE. A subject with held mail takes the decide branch
 * on both surfaces, and the gate's mail is the decide's to file — a different question from this
 * one.
 */

/** Where this fixture's press files the sender's mail. */
export const RETRO_DESTINATION = "ohmail/News";

/** The sender every row is from — one subject, so one press covers the fixture. */
export const RETRO_SENDER = { name: "Ledger", address: "ledger@shop.example" };

export interface RetroFixtureRow {
  id: string;
  /** Where the mailbox has it FILED — the wire's `folder`, which is `folder_state.desired_folder`. */
  folder: string;
  /** The triage state the wire carries, `null` for a message with no `message_states` row. */
  triage: string | null;
  /** Newest first is the order the person sees; distinct instants make that observable. */
  date: string;
  /** What this row is here to say. */
  why: string;
  /** The wire's `placeDecided`: a person placed it (the walk's clause 7). */
  placeDecided?: boolean;
}

export const RETRO_FIXTURE: readonly RetroFixtureRow[] = [
  { id: "r-inbox", folder: "INBOX", triage: null, date: "2026-08-20T09:00:00.000Z",
    why: "the ordinary candidate: a folder ohmail organizes, nothing triaged" },
  { id: "r-screened", folder: "ohmail/Screened", triage: null, date: "2026-08-19T09:00:00.000Z",
    why: "another organized folder — the pass moves out of all six, not only the INBOX" },
  { id: "r-quarantine", folder: "ohmail/Quarantine", triage: null, date: "2026-08-18T09:00:00.000Z",
    why: "the same, and it is the one people call Spam" },
  { id: "r-receipts", folder: "ohmail/Receipts", triage: null, date: "2026-08-17T09:00:00.000Z",
    why: "the same" },
  { id: "r-state-none", folder: "INBOX", triage: "none", date: "2026-08-16T09:00:00.000Z",
    why: "a state row that says `none` is not a triage — the pass excludes `state <> 'none'`" },
  { id: "r-already", folder: RETRO_DESTINATION, triage: null, date: "2026-08-15T09:00:00.000Z",
    why: "already where the press files it — the pass's idempotency clause" },
  { id: "r-archive", folder: "Archive", triage: null, date: "2026-08-14T09:00:00.000Z",
    why: "a folder the person keeps themselves; the pass's allow-list excludes it" },
  { id: "r-deep", folder: "Private/Family", triage: null, date: "2026-08-13T09:00:00.000Z",
    why: "the same, nested — an allow-list, so a folder nobody thought about is out by default" },
  { id: "r-sent", folder: "Sent", triage: null, date: "2026-08-12T09:00:00.000Z",
    why: "read and never organized" },
  { id: "r-set-aside", folder: "INBOX", triage: "set_aside", date: "2026-08-11T09:00:00.000Z",
    why: "set aside by hand — the caption promises this one is left alone" },
  { id: "r-reply-later", folder: "ohmail/Receipts", triage: "reply_later", date: "2026-08-10T09:00:00.000Z",
    why: "the same pile family, in an organized folder, so only the triage keeps it" },
  { id: "r-muted", folder: "INBOX", triage: "muted", date: "2026-08-09T09:00:00.000Z",
    why: "muted is a state too" },
  { id: "r-resurfaced", folder: "INBOX", triage: "resurfaced", date: "2026-08-08T09:00:00.000Z",
    why: "the wire state the narrower client type used not to admit" },
  { id: "r-decided", folder: "INBOX", triage: null, date: "2026-08-07T09:00:00.000Z", placeDecided: true,
    why: "placed by the person (decided_at): the walk never moves it; a press that is the instruction does" },
];

/** The ids the pass would move, newest first — hand-named, and the predicate is read against it. */
export const RETRO_MOVES: readonly string[] = [
  "r-inbox", "r-screened", "r-quarantine", "r-receipts", "r-state-none",
];

/** …and what a press that IS the instruction moves: a decided place does not stop the person's own move. */
export const RETRO_PRESS_MOVES: readonly string[] = [...RETRO_MOVES, "r-decided"];

/**
 * A subject big enough to slice: 51 candidates, so the fifty that move name an ORDER.
 *
 * Read as a SET, never as a sequence: the moves are dispatched unawaited and the wire may settle
 * them in any order, but WHICH fifty of the fifty-one is a fact about the slice. Oldest-first
 * leaves out `r-big-51`, newest-first leaves out `r-big-01`, and the fixture is built oldest id
 * first so a planner that does not sort at all fails the same way.
 */
export const RETRO_ORDER_FIXTURE: readonly RetroFixtureRow[] = Array.from(
  { length: 51 },
  (_, i): RetroFixtureRow => ({
    id: `r-big-${String(i + 1).padStart(2, "0")}`,
    folder: "INBOX",
    triage: null,
    // Distinct days, ascending with the id, so the newest fifty are `r-big-02`…`r-big-51`.
    date: new Date(Date.UTC(2026, 5, 1 + i, 9, 0, 0)).toISOString(),
    why: "one of fifty-one candidates, to make the slice's order observable",
  }),
);

/** The fifty of the fifty-one a newest-first slice keeps — everything but the oldest. */
export const RETRO_ORDER_MOVES: readonly string[] =
  RETRO_ORDER_FIXTURE.slice(1).map((r) => r.id);
