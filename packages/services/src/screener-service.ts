import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import {
  messages,
  folderState,
  flagState,
  contacts,
  accountSettings,
  rules as rulesTbl,
  routingDecisions,
  claimIdempotencyKey,
  recordChange,
  screenerLedgerSource,
  AI_ACTION_COST,
  type Tx,
} from "@trafficflow/db";
// Values from the root barrel's pure leaf, the GATE as a type only — see `drafting-service.ts`.
/* The PORT, from the root barrel — not `@trafficflow/db/cloud`, which is the half that
 * answers. This service names a gate it may be handed; it never builds one, and it must
 * compile in a deployment where no gate and no ledger exist. */
import type { AiCreditGate } from "@trafficflow/db";
import type { AdapterPort, ClassifierPort, Destination, NativeLocator, OhboxPolicy } from "@trafficflow/core/mail";
import {
  applyReconcileAction, CLASSIFY_DESTINATIONS, effectForDestination, rationaleHoldsAtGate,
  redactForModel, resolveOhboxPolicy,
} from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { ServiceContext } from "./context.js";
import { ServiceError, IdempotencyRaceLost } from "./errors.js";
import { getScreeningPreference } from "./screening-preference.js";
import { LearningService } from "./learning-service.js";
import { clampLimit, decodeListCursor, encodeListCursor } from "./pagination.js";
import type { Folder, Page, ScreenerItem } from "./dto/types.js";

/** Where unknown first-contact senders are held (core routing, `source:"screener"`). */
export const SCREENER_FOLDER: Destination = "ohmail/Screener";
const YES_FOLDER: Destination = "INBOX";               // Imbox
const NO_FOLDER: Destination = "ohmail/Screened";

/**
 * ── THE FIVE PLACES A DECISION MAY FILE MAIL, AND THE SIXTH THAT IS NOT ONE ──────────────────
 *
 * The DecisionBar has shown five buttons since it shipped — Ohbox, Reads, Receipts, Screen out,
 * Mark spam — and until `dest` reached this file the wire carried none of them. `decide`
 * answered with exactly two folders, `INBOX` for a yes and `ohmail/Screened` for a no, so three
 * of the five buttons wrote a rule and a `folder_state` naming a place the user had not chosen.
 *
 * **The clients did compose the difference, and it did not survive.** Both surfaces fired a
 * follow-up `move` per held message beside the decide. This method reads its held rows OUTSIDE
 * the transaction and then upserts `desired_folder` inside it, so a `move` that commits in that
 * window was silently overwritten by the decide's own write. The result is visible as a promoted
 * rule whose `destination` is `INBOX` for a sender the user admitted with Reads, the sender's mail
 * piling up in the Ohbox behind it, and the destination folder left all but empty.
 *
 * `Destination` and not a screener-only `"ohbox"|"reads"|…` vocabulary: `POST /messages/:id/move`
 * takes `{folder}` and `POST /rules` takes `{destination}`, both folder strings, and
 * {@link ScreenDecisionResult.appliedFolder} answers with one. A second spelling for the same
 * concept, reachable only here, is the drift this file would have to keep translating.
 *
 * **`ohmail/Screener` IS ABSENT AND THAT IS THE POINT.** It is a `Destination` and it is where
 * mail is HELD, never a place consent can file it to. A promoted rule pointing at it would hold
 * that sender at the gate for ever — every message they send re-screened by the user's own
 * rule, with no path out but revoking it. The check below is therefore membership in this set
 * FIRST and the allow/deny agreement second: `effectForDestination("ohmail/Screener")` is
 * `"deny"`, so the agreement check alone would wave it through on any `no`.
 */
const DECIDABLE_FOLDERS: ReadonlySet<string> = new Set<Destination>([
  YES_FOLDER, "ohmail/Reads", "ohmail/Receipts", NO_FOLDER, "ohmail/Quarantine",
]);

/**
 * ── THE TWO "NO" DESTINATIONS WHOSE MAIL A DECISION MARKS READ, AND THE SAFETY LINE ─────────
 *
 * A screen-out (`ohmail/Screened`) or a spam press (`ohmail/Quarantine`) is the user saying they
 * are done with this sender, so the mail they dismissed should not sit unread on the server for
 * ever. This set is exactly those two folders, and its membership IS the safety boundary
 * itself: `INBOX`, `ohmail/Reads` and `ohmail/Receipts` are ADMITTED mail and their read
 * state is never touched here — admitting a sender is not reading their backlog — and
 * `ohmail/Screener` is not a {@link DECIDABLE_FOLDERS} member at all, so mail still waiting at the
 * gate for a decision can never be pre-read (which would hide that it needs the user's attention).
 *
 * The `\Seen` write is ADDITIVE and reversible: this records `flag_state.desired_seen = true`
 * (`last_set_by = 'us'`, so it is distinguishable from the mailbox's own state and reversible by
 * `scripts/undo-runaway-reads.mjs`), and the worker's `reconcileFlags` (`apps/worker/src/sync.ts`)
 * adds `\Seen` on the real server. No move, no delete, no flag is ever REMOVED by this.
 *
 * It equals `decision === "no"` today — the consent gate refuses any other pairing — but is
 * expressed as folder membership so a future destination cannot silently inherit a read-mark by
 * being wired to a `no`. The same shape, for the same reason, as the membership-first check in
 * `DECIDABLE_FOLDERS`.
 */
const MARK_READ_ON_DECIDE: ReadonlySet<string> = new Set<Destination>([
  NO_FOLDER, "ohmail/Quarantine",
]);

/**
 * What the READ half is allowed to hold.
 *
 * There is no `classifier` here and no `credits` here, and both absences are the gate rather
 * than a convention. `ScreenerReadService` is constructed with exactly this bag, so inside
 * `list` and `decide` the expressions `this.deps.classifier` and `this.deps.credits` DO NOT
 * COMPILE. `ScreenerService` destructures both out of its own deps before calling `super`
 * ({@link ScreenerService.constructor}), so they are not reachable at runtime either — a cast
 * finds nothing on the object to cast to.
 *
 * The alternative is a `limit` constant guarding a call the read path can still make:
 * "the someone-remembers form". Nobody has to remember this one.
 */
export interface ScreenerDeps {
  /**
   * The IMAP write-path adapter for the inline re-route (OUTSIDE the tx).
   * OPTIONAL: the serverless API constructs the service WITHOUT one — the DB
   * tx still sets folder_state `pending` + emits the move change, and the always-on
   * worker performs the physical IMAP move on its next reconcile cycle. The unit
   * tests inject a FakeAdapter, so the inline move still runs there.
   */
  adapter?: AdapterPort;
  learning?: LearningService;
  /**
   * Auto-unsubscribe. OPTIONAL, and absent means the feature is simply off: the
   * screen-out still happens, nothing is sent. It is called AFTER the transaction commits
   * and it never throws, because the user's filing decision is the product and the
   * unsubscribe is a courtesy on top of it.
   */
  unsubscribe?: { onScreenOut(ctx: ServiceContext, messageIds: string[]): Promise<unknown> };
}

/**
 * What the SUGGEST half additionally holds — the model and the money, together, one level
 * down from every read.
 */
export interface ScreenerSuggestDeps extends ScreenerDeps {
  /** The model. Absent ⇒ `POST /screener/suggest` answers 503; no read path is affected. */
  classifier?: ClassifierPort;
  /**
   * The AI spend gate FACTORY, per account like every other gate. Absent ⇒ unmetered.
   *
   * A factory rather than a gate because this service is constructed ONCE per host bag
   * (`makeScreenerService({})`) and serves every account, while a gate is per account by
   * construction — it is what holds the account's refund markers.
   *
   * It moved OUT of {@link ScreenerDeps} with the classifier and for the same reason: a
   * read path that can build a gate is a read path that can charge, and the two capabilities
   * are only useful together anyway.
   */
  credits?: (db: Tx, accountId: string) => AiCreditGate;
  /**
   * THE BALANCE READ that answers "how much is left", beside the gate that spends it.
   *
   * A separate dep and not a method on {@link AiCreditGate}, because the gate is a PORT — the
   * question a caller asks about permission — and this is a read with no decision in it.
   * Widening that port would make every implementation of it, including the one-line test
   * doubles the pipeline's degrade-to-rules proof is written against, owe an answer about a
   * ledger they do not have.
   *
   * A factory taking `(db, accountId)` for the same reason `credits` is one: this service is
   * constructed once per host and serves every account.
   *
   * ABSENT ⇒ {@link ScreenerSuggestResult.remainingCredits} is omitted, and the surface says
   * nothing about a balance. That is the correct answer for the local install and for the
   * hosted deployment during any window where the ledger is not wired: silence, never `0`.
   * It is also why `balanceOf` is not imported here — it lives in `@trafficflow/db/cloud`,
   * the half this module must compile without (see the import block's own note).
   */
  remaining?: (db: Tx, accountId: string) => Promise<number>;
}

export interface ScreenBody {
  decision: "yes" | "no";
  /**
   * WHERE THE USER ASKED FOR IT — one of {@link DECIDABLE_FOLDERS}. Optional, and its absence
   * is exactly the behaviour this endpoint has always had: `yes` ⇒ `INBOX`, `no` ⇒
   * `ohmail/Screened`.
   *
   * Optional rather than required because a shipped desktop mirror and the API's own contract
   * tests post `{decision}` alone, and a client that cannot name a folder should still be able
   * to admit a sender. It is NOT optional in the sense of "the server will guess": present, it
   * decides the folder outright; absent, the two-folder default stands and the response's
   * `appliedFolder` says which one it was.
   */
  dest?: Destination;
  scope?: "sender" | "domain";   // default "sender"
}

/** Idempotency handle threaded in by the route; the row is written IN the decide tx. */
export interface ScreenIdempotency {
  key: string;
  requestHash: string;
}


export interface ScreenDecisionResult {
  messageId: string;
  appliedFolder: Folder;
  createdRuleId: string | null;
}

/* ── The explicit suggestion purchase ───────────────────────────────────────────────────── */

/**
 * Where a bought suggestion is STORED, and why it is a `routing_decisions` row.
 *
 * The table already holds "what was decided about this message, with what confidence and on
 * what evidence" — `destination`, `confidence`, `rationale`, `spam`, per account, per message,
 * FK'd to `messages`, dropped by `AccountDeletionService`, and granted to NO staff role
 * (`scripts/harden-staff-role.sql` §11). A suggestion is that shape exactly.
 *
 * The two vocabulary values are NEW, and deliberately values no existing reader matches:
 * `input_provenance` is `'rule'|'header'|'screener'|'ai'` for the pipeline's own writer
 * (`packages/core/src/adapters/drizzle-repo.ts:771`) and `'screener'` there means "the router
 * sent this to the gate", which is a different sentence from "the model advised on a sender
 * already at the gate". Reusing it would have merged the two in every count anybody runs —
 * including the `ai_decisions` figure. Neither column carries
 * a CHECK, and migration 0023's rule (quoted at `schema.ts` `authVerdict`) is that the
 * vocabulary belongs to the code that computes it.
 *
 * This is the one part of this feature that would rather have been a migration: there is no
 * `UNIQUE (account_id, message_id)` here, so {@link ScreenerService.suggest} deletes-then-inserts
 * inside its transaction and two concurrent suggests for one message can leave two rows. They
 * carry the same verdict (the model was asked once — the second spend is a `duplicate`), and
 * the read takes the newest, so the surface is unaffected; it is untidiness, not ambiguity.
 */
const SUGGESTION_PROVENANCE = "screener_suggestion";
/**
 * Not `auto_applied` and not `pending_approval`: nothing was applied and nothing is queued.
 *
 * Paired with the rule that makes these rows genuinely inert — **a suggestion emits no
 * `recordChange`**. It is not a change to the user's mail, nothing in `/sync` refers to it, and
 * `ApprovalService` reaches a routing decision only through `approvals.routing_decision_id`,
 * which no row here ever has. So the only reader of a suggestion is
 * {@link ScreenerReadService.storedSuggestions}, by provenance, in this file.
 */
const SUGGESTION_STATUS = "suggestion";

/**
 * The most senders ONE `POST /screener/suggest` request may cover — the PER-REQUEST cap.
 *
 * A cap and not a truncation: over it the request is REFUSED (413), because a control that quotes
 * a price for the whole request and silently buys up to the cap has priced something the user did not do.
 * Every sender is spend-gated INDIVIDUALLY inside {@link ScreenerService.suggest} — so a larger N
 * costs proportionally more and never bypasses the credit check. The quote and the charge both
 * scale with N; neither is a per-batch shortcut.
 *
 * ── A HARD 413 CEILING, NOT A SIZE CHOSEN TO FIT ONE INVOCATION ──────────────────────────────
 *
 * A real (non-dry) purchase of N senders makes N SERIAL model calls in the loop below, and the
 * Vercel host runs under `maxDuration = 60` (`apps/api-vercel/app/[[...path]]/route.ts`). At the
 * measured per-sender model latency a batch this large does NOT finish inside one invocation, so
 * 50 is the point past which a request is REFUSED (413) — a guard against an absurd request, not a
 * size picked to fit the deadline. The size that fits the deadline is the CLIENT's, and it is
 * smaller: the webapp splits a purchase into requests of `SUGGEST_CHUNK_SIZE` senders (well below
 * this cap), pricing and buying each on its own (`apps/webapp/.../screener-suggest.ts`), so each
 * request completes and the run ticks forward one chunk at a time rather than freezing on a single
 * oversized request. This cap only bounds the worst a single request may be; the run is RESUMABLE
 * per message anyway — spend and the stored suggestion are written before the next model call — so
 * even a request cut short bills only what it finished and a re-press resumes for free (the
 * `duplicate` retry re-asks nothing already stored). A DRY RUN makes no model call at all, so a
 * price for any size is a single fast request.
 */
export const MAX_SUGGEST_SENDERS = 50;

export interface ScreenerSuggestBody {
  /** The explicit sender set. Absent, empty or unparseable ⇒ 400; never "all". */
  senders?: unknown;
  /**
   * Price this set and stop — no model call, no debit, no write.
   *
   * It exists for the client that did NOT get its senders from `GET /screener`, which today is
   * every client that matters: the webapp derives its Screener rows from `/sync` deltas
   * (`packages/client-engine/src/selectors.ts`), so the quote carried on
   * {@link ScreenerPage.suggestable} never reaches it. Rather than have that surface
   * re-implement the eligibility rule and drift from this file, it asks — once, before showing
   * the confirmation — and the answer comes from the same code path that will do the work.
   */
  dryRun?: unknown;
}

export interface ScreenerSuggestion {
  sender: string;
  messageId: string;
  /**
   * `hold` is the model declining to place this sender — see {@link SCREEN_DISPOSITION}. It is
   * advice a surface may show and a BULK control may never act on.
   *
   * It stays three-valued now that {@link ScreenerSuggestion.destination} sits beside it, and that
   * is the point of the pair: this field is what a BULK control reads, so widening it would have
   * widened what one press of "Apply all" can do. The finer answer is carried, not acted on.
   */
  decision: "yes" | "no" | "hold";
  /**
   * The pile the model actually named, unreduced.
   *
   * `decision` answers "may a bulk control act, and which way"; three values cannot also say WHICH
   * of five piles, and the difference was visible on a live account: `ohmail/Receipts`,
   * `ohmail/Reads` and `ohmail/Quarantine` answers all reached the surface as the one word
   * "Screened out", so the product looked as though it never suggested Receipts, never Reads and
   * never spam. It suggested all three.
   *
   * `POST /screener/:id` already accepts every one of these as a `dest`, so a surface can offer the
   * suggestion as a one-press filing. What it must not do is act on it WITHOUT a press — that is
   * `decision`'s job, and `decision` still says `hold` wherever the model declined.
   */
  destination: Destination;
  /**
   * The model's own hard "no", carried rather than folded into the destination.
   *
   * `ohmail/Quarantine` and "screened out" are different verdicts about a stranger — one says the
   * mail is junk, the other says the person is unwanted — and collapsing them left the Screener
   * unable to say "spam" at all.
   */
  spam: boolean;
  confidence: number;
  rationale: string;
}

/**
 * Why a requested sender produced nothing. Every one of these costs zero credits EXCEPT
 * `model_unavailable`, which is charged and then retried for free (the classify path's rule).
 */
export type ScreenerSuggestSkip =
  | "not_held"            // no mail from this sender is at the gate
  | "out_of_credits"      // the balance ran out part-way through the set
  | "spend_unavailable"   // subscription state, AI switched off, or a gate fault
  | "model_unavailable";  // charged, the model faulted; the free retry honours it
// `"withheld"` was here — a sender skipped because their mail looked like it carried a credential.
// It is GONE rather than retained-and-never-emitted, and the compile errors that removal caused at
// every consumer were the point: a value nothing can produce is a branch every reader has to keep
// reasoning about, and the UI's copy for it ("This one is never sent to AI") is a promise the
// product no longer makes on this path. See the AI-OPEN ruling on `ScreenerService.suggest`.

export interface ScreenerSuggestResult {
  /** Whether this was a price check. `true` ⇒ nothing ran, nothing moved, nothing was stored. */
  dryRun: boolean;
  /** How many distinct senders the body named, after normalisation. */
  requested: number;
  /**
   * How many of them a control would have PRICED — held, AI-eligible, and not already bought.
   * The credits actually moved can only be ≤ this, never more, which is the property that makes
   * the quote safe: a control that shows this number can promise it is a ceiling.
   */
  quoted: number;
  /**
   * What {@link quoted} COSTS, in credits — `quoted × AI_ACTION_COST`, computed here.
   *
   * The count and the price are different numbers and only one of them is what the pricing
   * invariant demands a control names before it spends. They happen to be equal today because
   * `AI_ACTION_COST` is 1, which is exactly why the client must not be the one multiplying:
   * the webapp cannot import `@trafficflow/db`, so a client-side price would be a hardcoded
   * `1` that goes on reading "40 senders · 40 credits" the day the constant becomes 2.
   * `GET /screener` already states `suggestable.credits` for the same reason; this is the
   * same sentence on the path that a client which does not read that page can reach.
   */
  quotedCredits: number;
  /** Credits this request moved. A re-run over the same mail is a `duplicate` and charges 0. */
  charged: number;
  /**
   * Set when the spend gate stopped the run PART-WAY. Absent when everything asked for was
   * served, and never the whole answer: a run that produced nothing because of the gate is a
   * 402/409/503 instead, because "you have no credits" is not a successful request.
   */
  stopped?: "out_of_credits" | "spend_unavailable";
  /**
   * WHAT IS LEFT ON THE ACCOUNT AFTER THIS REQUEST — read from the ledger, never inferred.
   *
   * ── WHY THE SERVER HAS TO SAY IT ──────────────────────────────────────────────────────
   *
   * The summary a person sees after a run states what it cost. The obvious next question —
   * "so how much have I got left?" — had no answer anywhere on this path, and the only
   * material a client held was `charged`, which answers a different question entirely. A
   * client that subtracted `charged` from a remembered figure would be keeping its own
   * shadow ledger: wrong after a renewal, wrong after a refund, wrong after a second tab,
   * wrong after an expiry, and wrong in the direction that tells somebody they have credits
   * they do not. Invariant #10 is that money is named by the side that moves it.
   *
   * ── OPTIONAL, AND THE OPTIONALITY IS THE CONTRACT ─────────────────────────────────────
   *
   * A deployment with no ledger — the local install, every test that predates the gate —
   * supplies no reader, so the field is ABSENT and the client omits the clause. It is never
   * `0` for "we do not know": zero is a real balance with a real sentence of its own, and
   * conflating them would put "no credits left" in front of an unmetered install.
   *
   * Read AFTER the loop, so it is the balance the run left behind rather than the one it
   * started with. A dry run charges nothing, so on that path the two are the same number.
   */
  remainingCredits?: number;
  suggestions: ScreenerSuggestion[];
  skipped: Array<{ sender: string; reason: ScreenerSuggestSkip }>;
}

/**
 * What `GET /screener` answers — a page, plus the PRICE of suggesting for it.
 *
 * The quote travels with the page so a control can say "suggest for these 40 senders —
 * 40 credits" from the response it already has: no quote endpoint, no second round trip, and
 * no client-side re-derivation of the eligibility rule that could drift from this one.
 *
 * `senders` is exactly the set the control should POST back, so the thing that was priced and
 * the thing that is bought are the same list rather than two computations that agree today.
 */
export interface ScreenerPage extends Page<ScreenerItem> {
  suggestable: {
    /** Page senders that are held, AI-eligible, and have no stored suggestion yet. */
    senders: string[];
    /** `senders.length × AI_ACTION_COST`. Stated, not implied. */
    credits: number;
    /**
     * How many senders one `POST /screener/suggest` will accept — {@link MAX_SUGGEST_SENDERS}.
     *
     * It is published so the client learns the PER-REQUEST cap by READING it rather than
     * hardcoding a constant that can drift. The webapp does not batch by the page at all — it
     * derives its Screener queue from the `/sync` mirror, which can hold far more than one page —
     * and it may offer a purchase LARGER than this cap; it then splits that purchase into requests
     * of at most this many, pricing and buying each on its own (`screener-suggest.ts`). So this
     * number is not the ladder's top — it is the CEILING on one chunk of it (the client's own
     * latency budget makes a chunk smaller still), and the only thing that keeps a chunk under
     * the 413.
     */
    maxPerRequest: number;
  };
}

interface ScreenerRow {
  messageId: string;
  threadId: string | null;
  fromAddress: string;
  subject: string;
  snippet: string;
  date: Date | null;
  observedFolder: string;
  nativeLocator: NativeLocator;
  updatedAt: Date;
  /**
   * The server's current `\Seen` as the mirror last recorded it, `!unread`. Read by `decide`'s
   * read-mark step to seed `flag_state.observed_seen` on the INSERT branch — held mail has no
   * `flag_state` row at ingest, so a wrong observed value would queue a needless (idempotent) IMAP
   * STORE. Not surfaced to any list; the DTO does not carry it.
   */
  unread: boolean;
}

/**
 * The columns a {@link ScreenerRow} is built from — named ONCE.
 *
 * Two queries produce this row: {@link ScreenerReadService.heldRows} (the whole bag, for
 * `decide`) and {@link ScreenerReadService.heldSenderPage} (one bounded page, for `list`). They
 * share this projection and {@link toScreenerRow} so the two cannot drift into disagreeing about
 * what a held row IS.
 *
 * `no_ai` and `sensitivity_category` USED to be selected here, to compute an `aiEligible` flag
 * that travelled on the row and gated the model call. Both are gone with the flag under the
 * AI-OPEN ruling, and the field was deleted rather than left unread on purpose: an unread
 * eligibility boolean sitting on the row is an invitation to gate on it again, and the guard that
 * keeps this open is `screener-ai-open.test.ts`, which plants the old gate and watches it go red.
 * The COLUMNS themselves are untouched in the database and still drive stored redaction — this is
 * a statement about what the Screener's suggestion path reads, not about what the mail is.
 */
const HELD_COLUMNS = {
  messageId: messages.id, threadId: messages.threadId, fromAddress: messages.fromAddress,
  subject: messages.subject, snippet: messages.snippet, date: messages.date,
  nativeLocator: messages.nativeLocator, observedFolder: folderState.observedFolder,
  updatedAt: messages.updatedAt, unread: messages.unread,
} as const;

function toScreenerRow(r: {
  messageId: string; threadId: string | null; fromAddress: string; subject: string;
  snippet: string; date: Date | null; nativeLocator: unknown; observedFolder: string;
  updatedAt: Date; unread: boolean;
}): ScreenerRow {
  return {
    messageId: r.messageId,
    threadId: r.threadId ?? null,
    fromAddress: r.fromAddress,
    subject: r.subject,
    snippet: r.snippet,
    date: r.date,
    observedFolder: r.observedFolder,
    nativeLocator: (r.nativeLocator as NativeLocator | null) ?? { folder: r.observedFolder, ref: "0:0" },
    updatedAt: r.updatedAt,
    unread: r.unread,
  };
}

const asTx = (ctx: ServiceContext): Tx => ctx.db as unknown as Tx;
const domainOf = (addr: string): string => { const i = addr.indexOf("@"); return i >= 0 ? addr.slice(i + 1) : ""; };

/**
 * The `(date, messageId)` keyset for the Screener's `date desc, messageId desc` order — the
 * same shape and the same encoding as `MessageService`'s.
 *
 * The tuple, and not the id alone: senders share dates (an ESP sends a batch in one second),
 * so a date-only cursor would skip every sender after the first at that instant. `?? 0` maps
 * undated mail to the epoch, which is where the sort puts it too.
 *
 * **The encodings match; the two lists do NOT page identically over UNDATED mail, and the
 * difference is in this file's favour.** `MessageService.list` orders by a bare `desc(date)` —
 * NULLS FIRST in Postgres — and its cursor predicate is `date < $cursorDate`, which is NULL for
 * an undated row and therefore drops it from every page after the first. So there, undated mail
 * leads page one and then vanishes. Here the sort key is `coalesce(date, epoch)` in BOTH the
 * ORDER BY and the keyset, so undated mail sorts last and pages like everything else. Stated
 * rather than silently copied: a sender chooses whether to send a `Date:` header, and this is
 * the consent queue.
 */
function encodeScreenerCursor(r: { date: Date | null; messageId: string }): string {
  return encodeListCursor(`${r.date ? r.date.getTime() : 0}:${r.messageId}`);
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The cursor tuple, VALIDATED — because the comparison now happens in Postgres.
 *
 * While the keyset was applied in JavaScript a corrupt cursor was harmless: a non-numeric time
 * compared false and an arbitrary string compared as a string. The predicate now binds
 * `::timestamptz` and `::uuid` parameters, where the same garbage is a database error and
 * therefore a 500 on a request the caller malformed. It is a 400 instead, decided here, in the
 * one place the cursor is read.
 */
function decodeScreenerCursor(cursor: string): { time: number; messageId: string } {
  const raw = decodeListCursor(cursor);
  const i = raw.indexOf(":");
  const time = Number(raw.slice(0, i));
  const messageId = raw.slice(i + 1);
  if (i < 0 || !Number.isFinite(time) || !UUID_RE.test(messageId)) {
    throw new ServiceError("validation_failed", 400, "cursor is not a valid screener cursor");
  }
  return { time, messageId };
}

/**
 * The READ half of the Screener — the queue and the decision, and NOTHING that spends.
 *
 * ## This class exists because `list` used to call the model
 *
 * `list` performed one `classifier.classify()` per held sender per page — up to
 * {@link MAX_PAGE_LIMIT} of them on a single `GET`, on the one endpoint a client re-fetches
 * on every poll, scroll and reload. Three things were wrong with that and only one of them
 * was money: a read charged, its cost was a function of how much the user scrolled, and the
 * subject and snippet of first-contact mail were shipped to a third party by the act of
 * LOOKING at the queue. Generation is now a purchase — {@link ScreenerService.suggest} — and
 * this class returns what is stored.
 *
 * The separation is structural, not documentary. This class is constructed with
 * {@link ScreenerDeps}, which has no classifier and no credit-gate factory, so neither `list`
 * nor `decide` can compile a model call or a debit; and {@link ScreenerService} keeps both on
 * its own private fields rather than on the bag it passes down, so neither is reachable at
 * runtime from here either.
 *
 * The queue itself is DERIVED (no separate table): every message whose desired folder is
 * `ohmail/Screener` is a held first-contact sender, and `list` returns one entry per distinct
 * sender (latest message representative).
 *
 * `decide` re-routes ALL of that sender's held mail to the destination the user pressed
 * ({@link ScreenDest}) and creates a `provenance:'promoted'` sender/domain rule pointing at
 * that same folder. **yes** additionally marks the sender known; **no** additionally hands the
 * re-routed messages to auto-unsubscribe. With no `dest` on the body the two-folder default
 * stands — yes ⇒ `INBOX`, no ⇒ `ohmail/Screened`. Every branch records a deduped learning
 * signal and emits the rule-create + per-message move changes through the `change_log` seam;
 * the physical IMAP move runs via the reconciler write-path OUTSIDE the tx.
 */
export class ScreenerReadService {
  private readonly learning: LearningService;
  constructor(protected readonly deps: ScreenerDeps) {
    this.learning = deps.learning ?? new LearningService();
  }

  /**
   * The queue, and the price of suggesting for it. **Reads only.**
   *
   * The mutation that would have reintroduced the read-path model call is `await something.classify(...)` in this
   * method or in {@link toItem} below it. It does not typecheck: the only bag either of them
   * can see is {@link ScreenerDeps}.
   */
  async list(ctx: ServiceContext, opts: { cursor?: string; limit?: number } = {}): Promise<ScreenerPage> {
    const limit = clampLimit(opts.limit);
    const after = opts.cursor ? decodeScreenerCursor(opts.cursor) : null;
    // ONE bounded query: the representative per sender, the order, the keyset and the LIMIT are
    // all decided by Postgres. See {@link heldSenderPage} for why none of it is done here.
    const windowed = await this.heldSenderPage(ctx, { after, limit: limit + 1 });
    const pageRows = windowed.slice(0, limit);

    // The account's posture, resolved the same way the worker and the API read it — NULL/absent ⇒
    // {@link resolveOhboxPolicy}'s lenient default. It changes only how a STORED verdict reads as
    // Yes/No ({@link screenedOut}), never what was bought: a sender the model filed under Reads is
    // "yes" while the posture is lenient and "no" once it is `people_only`, with no re-purchase.
    const { ohboxPolicy } = await getScreeningPreference(ctx);
    const posture = resolveOhboxPolicy(ohboxPolicy);

    // ONE extra query for the whole page, not one per row, and none at all for an empty page.
    const stored = await this.storedSuggestions(ctx, pageRows.map((r) => r.messageId), posture);

    const items = pageRows.map((r) => toItem(r, stored.get(r.messageId) ?? null));

    // The quote. A sender is priced when they have not already been paid for (`!stored`) — and
    // that is now the WHOLE rule. The fact is in hand, so this costs no query.
    //
    // It used to also require `r.aiEligible`, and the two halves had to agree with `suggest`'s
    // own loop or the page would price a set the purchase would not buy. They still have to
    // agree, and they do — by both having one clause. Under the AI-OPEN ruling every held sender
    // is suggestable, so a quote that subtracted the credential-bearing ones would under-price a
    // purchase that then charged for them.
    //
    // A sender whose stored suggestion belongs to an OLDER representative is priced again, and
    // that is right: the rep rotates when they send again, so the suggestion on offer is about
    // mail the model has not read. It is also charged again, under that message's own source.
    const suggestable = pageRows
      .filter((r) => !stored.has(r.messageId))
      .map((r) => r.fromAddress.toLowerCase());

    const last = pageRows[pageRows.length - 1];
    const nextCursor = windowed.length > limit && last ? encodeScreenerCursor(last) : null;
    return {
      items,
      nextCursor,
      suggestable: {
        senders: suggestable,
        credits: suggestable.length * AI_ACTION_COST,
        maxPerRequest: MAX_SUGGEST_SENDERS,
      },
    };
  }

  async decide(
    ctx: ServiceContext, id: string, b: ScreenBody,
    opts: { idempotency?: ScreenIdempotency | null } = {},
  ): Promise<ScreenDecisionResult> {
    // ── THE ROUTE HANDS THIS BODY OVER UNVALIDATED ──────────────────────────────────────────
    //
    // `routes/screener.ts` does `readBody<ScreenBody>(req)`, which is a CAST and not a check, so
    // `scope` arrives as whatever JSON was posted. Earlier an unknown string fell through
    // `scope === "domain" ? … : …` and quietly produced a SENDER rule — wrong, but narrow. Now
    // that the same word also decides how much mail moves and how many strangers get an
    // unsubscribe request, a typo silently selecting a branch is no longer survivable. Named
    // here rather than in the route because this is the only reader of the field.
    const scope = b.scope ?? "sender";
    if (scope !== "sender" && scope !== "domain") {
      throw new ServiceError("validation_failed", 400, "scope must be 'sender' or 'domain'");
    }
    // ── `decision` IS CHECKED NOW, AND IT WAS NOT ───────────────────────────────────────────
    //
    // This used to be a bare `b.decision === "yes" ? … : …`, so EVERY other value — `"Yes"`, a
    // number, a missing field — fell through to the reject branch. That is the wider action
    // selected by absent evidence, and here the wider action files a stranger's mail to
    // `ohmail/Screened` AND hands their messages to auto-unsubscribe, which sends real requests
    // to a third party. Same reasoning as `scope` above; it is checked here for the same reason.
    const decision = b.decision;
    if (decision !== "yes" && decision !== "no") {
      throw new ServiceError("validation_failed", 400, "decision must be 'yes' or 'no'");
    }
    // ── AND SO IS `dest`, TWICE, IN THIS ORDER ─────────────────────────────────────────────
    //
    // Two separate refusals, because they are two separate mistakes. A folder outside
    // {@link DECIDABLE_FOLDERS} is a client naming a place a decision may not file to — an
    // invented string, or `ohmail/Screener`, which would promote a rule that holds the sender
    // at the gate for ever. A DECIDABLE folder on the wrong side of the gate —
    // `{decision:"yes", dest:"ohmail/Quarantine"}` — is the second: coercing it either way
    // files mail under a consent the user did not give, and which half to trust is a coin toss
    // the caller cannot see. The client guards the same confusion in the other direction —
    // `sender-screening.ts` once shipped a "yes unless screened" mapping that asked the server
    // to file a SPAM press into the Ohbox.
    //
    // MEMBERSHIP FIRST. `effectForDestination("ohmail/Screener")` is `"deny"`, so the agreement
    // check on its own accepts it for any `no`.
    const dest = b.dest;
    if (dest !== undefined) {
      if (typeof dest !== "string" || !DECIDABLE_FOLDERS.has(dest)) {
        throw new ServiceError(
          "validation_failed", 400,
          `dest must be one of ${[...DECIDABLE_FOLDERS].join(", ")}`,
        );
      }
      // `effectForDestination` and not a second hand-written table: it is exhaustive over
      // `Destination`, so a seventh folder is a compile error there until somebody decides
      // which side of the consent gate it is on.
      const admits = effectForDestination(dest) === "allow";
      if (admits !== (decision === "yes")) {
        throw new ServiceError(
          "validation_failed", 400,
          `dest '${dest}' does not belong to decision '${decision}'`,
        );
      }
    }
    // ── TWO INDEXED READS, NOT THE WHOLE QUEUE ──────────────────────────────────────────────
    //
    // This used to be `heldRows(ctx)` — every held message in the account — followed by a
    // `.find` and a `.filter` in JavaScript. On a large mailbox that is **thousands of rows,
    // each carrying `subject` and `snippet`**, pulled into a serverless function before the
    // decision does any work at all. The user-visible cost is the whole point: they click
    // "Ohbox" on a sender and the request spends its first seconds materializing a queue it is
    // about to discard, an unstable delay reported from the field. A delay that scales with the
    // size of the backlog is unpredictable by construction, and an action whose effect arrives at
    // an unpredictable time is indistinguishable from one that failed.
    //
    // The target lookup stays a HELD-ONLY lookup, so the 404 still means "not in the Screener"
    // and not merely "no such message" — deciding on mail that is not at the gate would create a
    // promoted rule for a sender nobody was asked about.
    const target = await this.heldRowById(ctx, id);
    if (!target) throw new ServiceError("not_found", 404, "screener item not found");

    const address = target.fromAddress.toLowerCase();
    const domain = domainOf(address);
    // ONE expression, read by the promoted rule, by every `folder_state` upsert and by the
    // learning signal, so the three cannot disagree about where a decision filed mail. `dest`
    // when the client named one; otherwise the two-folder default that was the whole of this
    // line before.
    const appliedFolder: Destination = dest ?? (decision === "yes" ? YES_FOLDER : NO_FOLDER);

    // ── A DOMAIN DECISION NEEDS A DOMAIN ────────────────────────────────────────────────────
    //
    // `domainOf` answers `""` for an address with no `@`, and an empty `match` on a
    // `kind: 'domain'` row is not an inert rule — every reader compares it against
    // `split_part(lower(from_address), '@', 2)`, which is ALSO `''` for any other malformed
    // address, so one such rule would silently rule on all of them. Refused rather than
    // narrowed to `sender`: falling back would file mail under a decision the user did not
    // make, and this is the branch where absent evidence must not select the wider action.
    if (scope === "domain" && domain === "") {
      throw new ServiceError(
        "unprocessable", 422,
        "this sender has no domain to rule on — decide on the address instead",
      );
    }

    // ── THE BAG FOLLOWS THE SCOPE, AND EARLIER IT DID NOT ───────────────────────────────────
    //
    // This was `heldRowsForSender(ctx, address)` unconditionally. A `scope: "domain"` decision
    // therefore wrote a rule saying "everyone at corp.com goes to Screened" and then moved ONE
    // address's mail, leaving every other held sender at that domain waiting at a gate whose
    // own rule already said to let them through — and nothing repairs that later, because
    // `rules` is consulted when mail ARRIVES and never retroactively. The rule and the mail it
    // moves are one decision; they have to have one subject.
    //
    // `split_part(lower(…), '@', 2)` and not a suffix match: `lower(from) like '%@corp.com'`
    // would also catch `evil-corp.com`, and this is the same expression
    // `drizzle-repo.ts#listScreenerBacklog` and `sensitive-rescreen.ts#selectCandidates`
    // already use to ask "has the user ruled on this sender", so the set a rule MOVES and the
    // set it is later understood to COVER are computed the same way.
    //
    // Still ALL of the matching held mail — `decide` re-routes the whole bag by contract, and
    // a page of it would leave the rest stranded at a gate whose rule now says "allow".
    const heldMail = scope === "domain"
      ? await this.heldRowsForDomain(ctx, domain)
      : await this.heldRowsForSender(ctx, address);

    /**
     * The subset of {@link heldMail} this decision ACTUALLY re-routed — see the guard inside the
     * transaction. Declared out here because two things after the commit need it and neither may
     * act on a row the guard skipped: the IMAP write-path (it would move mail the database says
     * is elsewhere) and auto-unsubscribe (it would leave a list on behalf of a message that is
     * no longer screened out).
     */
    const rerouted: ScreenerRow[] = [];

    // ── DB tx: mark known (yes) + promoted rule + folder-state re-route + change_log + learning (step 2) ──
    const result = await asTx(ctx).transaction(async (tx) => {
      rerouted.length = 0;
      if (decision === "yes") {
        await tx.insert(contacts).values({ accountId: ctx.accountId, address })
          .onConflictDoNothing({ target: [contacts.accountId, contacts.address] });
      }

      /**
       * ── THE SCREENING BASELINE, STAMPED ON THE FIRST DECIDE AND NEVER AGAIN (mail 0056) ───
       *
       * The instant the cutline measures its window back from. Until it exists the window slides
       * off `now()` and the unread test ignores age entirely, so any old unread mail entering the
       * mirror — a backfill reaching further back, a folder read for the first time, a `\Seen`
       * flag adopted late — resurrects a sender the account had already worked past, and the
       * queue never stays empty. `client-engine/src/consent-cutline.ts` carries the argument.
       *
       * WHY HERE. This transaction is the account's decision that a sender is answered for; the
       * FIRST one is the account saying the queue is a thing it is now working through. Nothing
       * else in the product is that event: `seed_confirmed_at` is answered before any mail has
       * been screened, and a login is not a decision.
       *
       * WHY `setWhere: isNull(...)` AND NOT AN OVERWRITE. The baseline is established once. A
       * later decide is the account USING a queue that already has a baseline, and re-stamping
       * would drag the cutoff forward every time somebody presses a button — which drops every
       * sender whose newest mail just fell behind the new cutoff out of the queue, silently, as a
       * side effect of answering an unrelated one.
       *
       * AND IT IS WHAT MAKES THE RACE SAFE. Two decides on one account commit concurrently — two
       * devices, or a client firing a batch. Both reach this upsert, Postgres serialises them on
       * the primary key, and the loser re-evaluates `screening_baseline_at IS NULL` against the
       * WINNER's committed row and skips. One baseline, and it is the earlier one. A
       * read-then-write here would produce two different answers under exactly that interleaving
       * and PGlite would never show it — `consent-baseline.concurrency.pg.test.ts` runs it on
       * real Postgres for the reason `consent-auto-suggest.concurrency.pg.test.ts` states.
       *
       * Column-scoped, like every other writer on this row: only `screening_baseline_at` and
       * `updated_at` are touched, so a concurrent `confirmSeed` or `setDormancyDays` is not
       * clobbered by a stale snapshot.
       */
      await tx.insert(accountSettings).values({
        accountId: ctx.accountId,
        screeningBaselineAt: ctx.now(),
        updatedAt: ctx.now(),
      }).onConflictDoUpdate({
        target: accountSettings.accountId,
        set: { screeningBaselineAt: ctx.now(), updatedAt: ctx.now() },
        setWhere: isNull(accountSettings.screeningBaselineAt),
      });

      const [rule] = await tx.insert(rulesTbl).values({
        accountId: ctx.accountId,
        kind: scope === "domain" ? "domain" : "sender",
        match: scope === "domain" ? domain : address,
        destination: appliedFolder,
        provenance: "promoted",
        enabled: true,
      }).returning({ id: rulesTbl.id });
      let lastSeq = await recordChange(tx, { accountId: ctx.accountId, entityType: "rule", entityId: rule!.id, op: "create", meta: null });

      /**
       * ── THE RE-ROUTE IS GUARDED ON THE ROW STILL BEING HELD, AND THAT IS A FIX ─────────────
       *
       * `heldMail` was read OUTSIDE this transaction, so between that read and this write the
       * row can have been re-routed by somebody else: a second device, `ruleRetroPass`, or —
       * the case that was measured in production — the client's own follow-up `move`. The
       * upsert had no `where`, so it stamped `appliedFolder` over whatever had landed, and the
       * user's stated destination lost to the endpoint's default. That is the whole of
       * SCR-READ's 97 misfiled bulletins: the `move` to `ohmail/Reads` committed first and this
       * line put it back to `INBOX`.
       *
       * Removing the client composition (which this slice also does) does not close it, because
       * a shipped DESKTOP mirror goes on composing `decide` + `move` until it updates. So the
       * guard lives here, where every writer passes: `DO UPDATE … WHERE desired_folder =
       * 'ohmail/Screener'` re-routes only rows that are STILL at the gate. A row that has moved
       * on keeps where it went — "user always wins", the same rule the reconciler runs on — and
       * an old client's racing `move` to Reads now WINS instead of being clobbered.
       *
       * `.returning()` is what makes the `change_log` honest: a row the guard skipped did not
       * move, so emitting a `move` change for it would tell every client's delta stream that
       * mail went somewhere it did not, and the next drain would paint it in the wrong pile.
       * The IMAP write-path below iterates the same list for the same reason.
       *
       * ON CONFLICT and not a plain UPDATE: `heldRows` INNER JOINs `folder_state`, so a row
       * always exists and the INSERT always conflicts — the values arm is unreachable in
       * practice and is kept only because the upsert shape is what every other writer here uses.
       */
      for (const m of heldMail) {
        const [hit] = await tx.insert(folderState).values({
          messageId: m.messageId, desiredFolder: appliedFolder, observedFolder: m.observedFolder,
          lastSetBy: "us", reconcileStatus: "pending", conflict: false,
        }).onConflictDoUpdate({
          target: folderState.messageId,
          set: { desiredFolder: appliedFolder, lastSetBy: "us", reconcileStatus: "pending", conflict: false, updatedAt: ctx.now() },
          // `setWhere`, not the deprecated `where`: both render into the same slot, but `where`
          // reads as though it filtered the CONFLICT TARGET (a partial-index predicate, which is
          // `targetWhere`). This is the `DO UPDATE … WHERE` arm, and the column reference is the
          // EXISTING row — `excluded.*` would be the row we are proposing.
          setWhere: eq(folderState.desiredFolder, SCREENER_FOLDER),
        }).returning({ messageId: folderState.messageId });
        if (!hit) continue;
        rerouted.push(m);
        lastSeq = await recordChange(tx, {
          accountId: ctx.accountId, entityType: "message", entityId: m.messageId, op: "move",
          meta: { from: m.observedFolder, to: appliedFolder },
        });

        // ── A SCREEN-OUT OR SPAM PRESS MARKS THE MAIL READ, IN THIS SAME TRANSACTION ─────────
        //
        // Only the two "no" destinations qualify — see {@link MARK_READ_ON_DECIDE} for why this
        // is a folder-membership check and not `decision === "no"`, and for the safety boundary
        // it draws. ADDITIVE: `desired_seen = true` is a `\Seen` to ADD, never a flag to remove,
        // and the worker's `reconcileFlags` applies it on the real server — the API opens no IMAP.
        //
        // Shape mirrors `MessageService.upsertDesiredSeen`: `observed_seen` is supplied only on
        // the INSERT (held mail has no `flag_state` row at ingest — `pipeline.ts` writes only
        // `folder_state`), and on the UPDATE it is deliberately omitted so the worker's observed
        // truth is preserved and `reconcile_status` is recomputed in SQL against the STORED value.
        // A `\Seen` already on the server ⇒ `reconciled`, no needless STORE.
        if (MARK_READ_ON_DECIDE.has(appliedFolder)) {
          await tx.insert(flagState).values({
            messageId: m.messageId, desiredSeen: true, observedSeen: !m.unread,
            lastSetBy: "us", reconcileStatus: m.unread ? "pending" : "reconciled", conflict: false,
          }).onConflictDoUpdate({
            target: flagState.messageId,
            set: {
              desiredSeen: true, lastSetBy: "us", conflict: false, updatedAt: ctx.now(),
              reconcileStatus: sql`case when ${flagState.observedSeen} = true then 'reconciled' else 'pending' end`,
            },
          });
          // The mirror the client renders. `unread` is written by the API at mark-read time, never
          // by the reconciler (see `scripts/undo-runaway-reads.mjs`), so without this the lists
          // would still show the dismissed mail bold. `last_read_at` tracks the flag, as
          // `MessageService.markSeen` does, so the two read-paths file identically in "Earlier".
          await tx.update(messages)
            .set({ unread: false, lastReadAt: ctx.now(), updatedAt: ctx.now() })
            .where(and(eq(messages.id, m.messageId), eq(messages.accountId, ctx.accountId)));
          // The read-state delta the client applies — `op: "update"`, the same contract
          // `markSeen` emits for a read change. Distinct from the `move` above: one says where the
          // mail went, this says it is no longer unread.
          lastSeq = await recordChange(tx, {
            accountId: ctx.accountId, entityType: "message", entityId: m.messageId, op: "update", meta: null,
          });
        }
      }

      await this.learning.recordOn(tx, ctx.accountId, {
        triggeringActionId: `screener:${id}`,
        kind: "screener",
        senderAddress: scope === "domain" ? null : address,
        senderDomain: scope === "domain" ? domain : null,
        destination: appliedFolder,
        label: "positive",
      });

      const dto: ScreenDecisionResult = { messageId: id, appliedFolder, createdRuleId: rule!.id };

      // Store the verbatim response IN this tx so a commit-then-crash retry
      // replays the SAME 200 — never re-creating the promoted rule (the dup-rule
      // side effect the idempotency test guards against). Inserted directly since
      // services cannot import packages/api (copied from PushService/MessageService).
      if (opts.idempotency) {
        const claimed = await claimIdempotencyKey(tx, {
          accountId: ctx.accountId,
          key: opts.idempotency.key,
          requestHash: opts.idempotency.requestHash,
          responseStatus: 200,
          responseJson: dto,
          seq: Number(lastSeq),
          now: ctx.now(),
        });
        // A LOST claim = a concurrent same-key request committed first. Throwing rolls THIS
        // transaction back (effect included) and the caller replays the winner's response.
        if (!claimed) throw new IdempotencyRaceLost(ctx.accountId, opts.idempotency.key);
      }

      return dto;
    });

    // ── Physical IMAP move via the reconciler write-path, OUTSIDE the tx (step 3, idempotent) ──
    // Only when an adapter is injected. The serverless API path has none — the
    // folder_state row is left `pending` and the always-on worker drains it later.
    if (this.deps.adapter) {
      const adapter = this.deps.adapter;
      const repo = makeDrizzleRepo(ctx.db as unknown as Tx);
      // `rerouted`, never `heldMail`: a row the guard skipped belongs to whoever wrote it, and
      // moving it on IMAP would make the mailbox disagree with the database that just declined
      // to claim it. This is the one place a stale read could still reach the user's server.
      for (const m of rerouted) {
        await applyReconcileAction(
          { repo, adapter, accountId: ctx.accountId, mailboxId: "" },
          { messageId: m.messageId, locator: m.nativeLocator, state: { desiredFolder: appliedFolder, observedFolder: m.observedFolder, lastSetBy: "us" } },
          { type: "move", to: appliedFolder },
        );
      }
    }

    // AFTER the tx has committed, never inside it, and only on a REJECT. `onScreenOut`
    // never throws: a sender who cannot be unsubscribed is still screened out, because the
    // filing decision is the product and this is a courtesy on top of it.
    //
    // ── THE TRIGGER IS THE CONSENT, NOT THE FOLDER ──────────────────────────────────────────
    //
    // This read `appliedFolder === NO_FOLDER` while a reject could only ever land in
    // `ohmail/Screened`. Now that `dest: "ohmail/Quarantine"` is reachable, that predicate would
    // have gone quietly false for every SPAM press — a shipped behaviour dropped as a side
    // effect of a slice about destinations, which is exactly the class of change that has to be
    // deliberate or not at all.
    //
    // It is deliberate the other way, and the ruling is already written down:
    // `unsubscribe-service.ts` names its actionable set as "`ohmail/Screened` and
    // `ohmail/Quarantine` — the user said no. Every reject path lands in one of these two: **the
    // Screener's spam verb**, an explicit screen-out, a block rule." Spam is named there. So
    // `decision === "no"` is both the same set of senders this has always had and the sentence
    // that file is written against, and `sender-screening.ts`'s pre-click disclosure — which
    // tells the user a spam press arms auto-unsubscribe — stays true.
    //
    // The narrowing is still done twice: `onScreenOut` filters to those two folders itself
    // rather than trusting its caller, which is what keeps a future promote path from turning
    // this into an unsubscribe by passing the wrong ids.
    //
    // `rerouted` and not `heldMail`, for the reason the IMAP loop above gives: a row this
    // decision did not claim is not one it may leave a mailing list on behalf of.
    if (this.deps.unsubscribe && decision === "no") {
      await this.deps.unsubscribe.onScreenOut(ctx, rerouted.map((m) => m.messageId));
    }

    return result;
  }

  /**
   * All messages currently held in the Screener (desired folder = ohmail/Screener).
   *
   * **The sensitivity flags narrow NOTHING here, and they never did.** This WHERE has never
   * carried `no_ai = false AND sensitivity_category IS NULL` — the shape
   * `DraftingService.retrieveThreadContext` uses, and the obvious symmetry to reach for — because
   * it would be wrong twice over: it would HIDE a held sensitive message from the queue the user
   * is meant to triage, and `decide` reads the same rows, so that sender could never be screened
   * at all (404) and their mail would stay stuck in `ohmail/Screener` for ever.
   *
   * What HAS changed is what happened downstream. The SELECT used to compute an `aiEligible`
   * flag that travelled on the row so {@link ScreenerService.suggest} could refuse to ask about
   * it. Under the AI-OPEN ruling it asks about all of them, and the credential material is
   * redacted at the sink instead.
   */
  protected async heldRows(ctx: ServiceContext, extra?: SQL): Promise<ScreenerRow[]> {
    const filters: SQL[] = [
      eq(messages.accountId, ctx.accountId),
      eq(folderState.desiredFolder, SCREENER_FOLDER),
    ];
    if (extra) filters.push(extra);

    const rows = await ctx.db.select(HELD_COLUMNS).from(messages)
      .innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(...filters))
      .orderBy(desc(messages.date));

    return rows.map(toScreenerRow);
  }

  /**
   * ONE PAGE of the queue: the representative per sender, ordered, keyset-filtered and
   * LIMITed — **by Postgres**, which is the whole of the second defect.
   *
   * ## What this replaces
   *
   * `list` used to call {@link heldRows} with no predicate and no limit and then do all four
   * jobs in JavaScript. That is **every held message in the account** — thousands of rows on a
   * large mailbox, each carrying `subject` AND `snippet` — pulled into a serverless function
   * on every scroll, poll and reload, to return at most 200 of them. The cost of reading page
   * one grew with the size of the backlog, which is the same defect `decide` was cured of and
   * for the same reason: the Screener is the surface a user meets a stranger on, and it is the
   * surface that got slower the more strangers were waiting.
   *
   * ## THE KEYSET IS APPLIED AFTER THE `DISTINCT ON`, NEVER INSIDE IT
   *
   * This is the one composition that has to be right, and it is not the obvious one. The inner
   * query reduces the held set to one row per sender — their LATEST held message. Pushing the
   * cursor predicate down into that query would filter rows BEFORE the representative is
   * chosen, so a sender whose true representative sits ABOVE the cursor (already shown) but who
   * also has an older held message BELOW it would have that older message promoted to
   * representative and be **listed a second time**. The user would be asked about the same
   * stranger twice, on different mail. The predicate therefore sits in the outer query, over a
   * set that is already one-row-per-sender.
   *
   * A keyset and not `OFFSET`: the held set mutates under the reader (mail arrives, `decide`
   * removes a whole sender's bag), and `OFFSET n` over a shifting set silently skips rows when
   * something above the window disappears and repeats them when something is inserted. A skip
   * here is not a cosmetic paging artefact — it is a first-contact sender the user is never
   * asked about, whose mail then sits in `ohmail/Screener` unseen. That is why this is a
   * correctness fix and not a performance one.
   *
   * The keyset is not a promise that one pagination pass sees a consistent snapshot, and it is
   * not sold as one. A sender whose representative rotates mid-pass — new mail arrives, or the
   * rep message alone is moved out — can move relative to the cursor and be seen twice or not
   * until the next reload. Both resolve on re-read, and neither loses a sender permanently,
   * which is the property that matters here.
   *
   * ## The sort key is TRUNCATED TO MILLISECONDS on purpose
   *
   * The cursor round-trips the date through `Date.getTime()`, which is integer milliseconds. If
   * the column held more precision than the cursor can carry, the comparison would be made
   * against a value slightly BELOW the row's real timestamp, and any row falling in the gap
   * would satisfy neither page — a silent loss of exactly the kind the tiebreak below exists to
   * prevent. `date_trunc('milliseconds', …)` makes the SQL sort key exactly representable in
   * the cursor, and the ties that truncation can create are broken by `id`, which the cursor
   * also carries.
   *
   * `coalesce(…, to_timestamp(0))` and not `DESC NULLS LAST`: it is the literal translation of
   * the `?? 0` the JavaScript used, it matches what {@link encodeScreenerCursor} writes for an
   * undated row, and it keeps undated mail at the END of the queue. Postgres sorts NULLs FIRST
   * under `DESC`, so the naive spelling would let a sender who simply omits a `Date:` header —
   * a field they control — take the top of the consent queue.
   *
   * ## The representative is now chosen deterministically
   *
   * `ORDER BY lower(from_address), sort_key DESC, id DESC` inside the `DISTINCT ON` picks the
   * newest held message per sender and, on a date tie, the higher id. The JavaScript it
   * replaces kept the first row it happened to see at a tie, under an `ORDER BY date` that does
   * not order ties at all — so which message represented a sender was arbitrary and could
   * differ between two identical requests. A cursor cannot be built on that: the tuple it
   * encodes has to name the same row on the next request.
   */
  protected async heldSenderPage(
    ctx: ServiceContext,
    opts: { after: { time: number; messageId: string } | null; limit: number },
  ): Promise<ScreenerRow[]> {
    const sortKey = sql<Date>`date_trunc('milliseconds', coalesce(${messages.date}, to_timestamp(0)))`;
    const sender = sql`lower(${messages.fromAddress})`;

    // `account_id` LEADS the predicate rather than filtering a cross-account result (no cross-account disclosure).
    const reps = ctx.db.selectDistinctOn([sender], {
      ...HELD_COLUMNS,
      sortKey: sortKey.as("sort_key"),
    }).from(messages)
      .innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(
        eq(messages.accountId, ctx.accountId),
        eq(folderState.desiredFolder, SCREENER_FOLDER),
      ))
      .orderBy(sender, desc(sortKey), desc(messages.id))
      .as("reps");

    const rows = await ctx.db.select().from(reps)
      .where(opts.after
        // Row comparison, which is the `date desc, id desc` keyset written as one expression:
        // strictly "older" than the cursor tuple, with the id breaking a shared date. Bound as
        // TYPED parameters so the comparison is the DATABASE's ordering of a `timestamptz` and
        // a `uuid`, not a string comparison that happens to agree with it.
        ? sql`(${reps.sortKey}, ${reps.messageId}) < (${new Date(opts.after.time).toISOString()}::timestamptz, ${opts.after.messageId}::uuid)`
        : undefined)
      .orderBy(desc(reps.sortKey), desc(reps.messageId))
      .limit(opts.limit);

    return rows.map(toScreenerRow);
  }

  /**
   * ONE held row by message id — `decide`'s target lookup, on the primary key.
   *
   * The `desired_folder = ohmail/Screener` predicate is inherited from {@link heldRows} and is
   * the load-bearing half: it is what makes a message that has already left the gate a 404
   * rather than a silent second decision on mail nobody is holding.
   */
  private async heldRowById(ctx: ServiceContext, id: string): Promise<ScreenerRow | null> {
    const rows = await this.heldRows(ctx, eq(messages.id, id));
    return rows[0] ?? null;
  }

  /**
   * Every held row for ONE sender, matched case-insensitively on the address.
   *
   * `lower(from_address)` and not a bare `eq`: the queue is keyed by `fromAddress.toLowerCase()`
   * everywhere else in this file, and a sender who varies their capitalisation between messages
   * would otherwise have half their bag re-routed and half left at the gate — with a promoted
   * rule already saying they are allowed through.
   */
  protected async heldRowsForSender(ctx: ServiceContext, address: string): Promise<ScreenerRow[]> {
    return this.heldRows(ctx, sql`lower(${messages.fromAddress}) = ${address}`);
  }

  /**
   * Every held row for ONE DOMAIN — what a `scope: "domain"` decision re-routes.
   *
   * ── THIS PREDICATE IS `packages/core/src/rules.ts#domainOf`, TRANSLATED ──────────────────
   *
   * The set this moves and the set the promoted rule will COVER have to be the same set, and
   * the second one is not decided here — it is decided by `matches()` in `core/src/rules.ts`,
   * which fires a `kind:'domain'` rule when `r.match.toLowerCase() === domainOf(author)` with
   * `domainOf` = **everything after the FIRST `@`**, exact equality, no subdomains. So this is
   * `substring(… from position('@' …) + 1)`, which is that function character for character.
   *
   * Three shapes were rejected, each wrong in a way that only shows up on mail somebody sends
   * you deliberately:
   *
   *  · `like '%@' || domain` — `_` and `%` inside a domain are LIKE wildcards, and it also
   *    matches `a@mail.corp.com` for `corp.com`, importing subdomain semantics the core matcher
   *    does not have. Mail would move now and then never match the rule again.
   *  · `like '%' || domain` — additionally matches `evil-corp.com` for `corp.com`, so screening
   *    a domain would rule on a lookalike an attacker controls.
   *  · `split_part(lower(from_address), '@', 2)` — what `drizzle-repo.ts#listScreenerBacklog`
   *    and `sensitive-rescreen.ts#selectCandidates` use. It agrees with `domainOf` on every
   *    ordinary address and DISAGREES on `a@b@c.example`, where it answers `b` and the core
   *    matcher answers `b@c.example`. Copying it would have made this file agree with two
   *    backlog passes and disagree with the router that actually files the mail. **That
   *    divergence is pre-existing and is left alone here — it is those predicates' bug, in
   *    files this slice may not touch, and reproducing it to look consistent would put it in a
   *    third place.**
   *
   * The `position(…) > 0` guard is not redundant: Postgres' `substring(x from 1)` returns the
   * WHOLE string when `position` answers 0, so without it a malformed `from_address` of
   * `corp.com` — no `@` at all — would be swept into a decision about `corp.com` that the core
   * matcher (`domainOf("corp.com") === ""`) would never honour.
   *
   * `domain` is expected already lower-cased and non-empty; `decide` guarantees both before
   * calling (`domainOf` of a lower-cased address, plus the 422 above).
   */
  protected async heldRowsForDomain(ctx: ServiceContext, domain: string): Promise<ScreenerRow[]> {
    return this.heldRows(ctx, sql`
      position('@' in lower(${messages.fromAddress})) > 0
      and substring(
        lower(${messages.fromAddress})
        from position('@' in lower(${messages.fromAddress})) + 1
      ) = ${domain}
    `);
  }

  /**
   * The STORED suggestions for a page of representative messages — the whole read path.
   *
   * One query for the page, none for an empty one, and the newest row wins per message (see
   * {@link SUGGESTION_PROVENANCE} for why there can be more than one). `account_id` is in the
   * WHERE even though the ids are already this account's: the no-cross-account-disclosure rule
   * says the account leads every key, never a filter applied to a cross-account result.
   */
  protected async storedSuggestions(
    ctx: ServiceContext, messageIds: string[], ohboxPolicy: OhboxPolicy,
  ): Promise<Map<string, ScreenerItem["aiSuggestion"]>> {
    const out = new Map<string, ScreenerItem["aiSuggestion"]>();
    if (messageIds.length === 0) return out;

    const rows = await ctx.db.select({
      messageId: routingDecisions.messageId,
      destination: routingDecisions.destination,
      confidence: routingDecisions.confidence,
      rationale: routingDecisions.rationale,
      spam: routingDecisions.spam,
    }).from(routingDecisions)
      .where(and(
        eq(routingDecisions.accountId, ctx.accountId),
        eq(routingDecisions.inputProvenance, SUGGESTION_PROVENANCE),
        inArray(routingDecisions.messageId, messageIds),
      ))
      .orderBy(desc(routingDecisions.createdAt), desc(routingDecisions.id));

    for (const r of rows) {
      if (out.has(r.messageId)) continue;
      out.set(r.messageId, {
        ...suggestionAdvice(r.destination, r.spam, r.rationale ?? "", ohboxPolicy),
        confidence: r.confidence ?? 0,
        rationale: r.rationale ?? "",
      });
    }
    return out;
  }
}

/**
 * The Screener, INCLUDING the one operation that spends: {@link ScreenerService.suggest}.
 *
 * This is the type on `ApiServices.screener`, so every existing caller is unchanged and the
 * read half it inherits is the read half above — the one that cannot reach a model.
 */
export class ScreenerService extends ScreenerReadService {
  /**
   * PRIVATE FIELDS, and the deps handed DOWNWARD have neither.
   *
   * The classifier and the gate factory are destructured out of the incoming bag, so the object
   * `ScreenerReadService` holds does not carry them at runtime and its own type does not admit
   * them at compile time. `list` cannot reach `this.classifier` either — it is `private`, which
   * TypeScript enforces even through a cast to this class.
   */
  private readonly classifier?: ClassifierPort;
  private readonly credits?: (db: Tx, accountId: string) => AiCreditGate;
  /** The balance READ. Destructured out for the same reason as the two above. */
  private readonly remaining?: (db: Tx, accountId: string) => Promise<number>;

  constructor(deps: ScreenerSuggestDeps) {
    const { classifier, credits, remaining, ...readOnly } = deps;
    super(readOnly);
    this.classifier = classifier;
    this.credits = credits;
    this.remaining = remaining;
  }

  /**
   * **Buy suggestions for an EXPLICIT set of senders.** `POST /screener/suggest`,
   * `cost: "work"`.
   *
   * ## What it refuses, and why refusing is the feature
   *
   * A missing, empty, non-array or all-blank sender set is a 400. It is never read as "all",
   * and that is the rule this route exists to obey: on a large mailbox "all" can be well over a
   * thousand senders — a four-figure spend one malformed body away. Absent evidence must not
   * select the expensive branch.
   *
   * ## AI-OPEN — THE CURRENT RULING, AND WHAT IT REPLACED
   *
   * "There is not one single message for AI to not read justified… scan everything and remove the
   * exceptions; if someone wants to use AI, they can, if not, they won't."
   *
   * This method used to run `sensitivity → money → model`, skipping a `no_ai` or non-`ordinary`
   * row as `"withheld"` before the spend question was asked. **Every held sender is now
   * suggestable.** The consent argument that justified the exception does not survive contact with
   * what this endpoint is: nobody reaches it by accident. A person selected a set of senders, was
   * quoted a price, and pressed a button labelled "Suggest". Withholding there is not protecting
   * them from a disclosure they did not choose — it is declining to perform the one they did.
   *
   * What it cost, measured on the account that reported it: **293 of 1,698 waiting senders** could
   * not be suggested for, and the surface told them so in a sentence
   * ("This one is never sent to AI — it looks like it carries a login or a code") that read as a
   * safety promise while being, for most of those senders, a false positive in a detector.
   *
   * ## What still protects the credential, and where it moved to
   *
   * REDACTION, which is the half that was always doing the real work. `pipeline.ts` stores the
   * body and the snippet of this class of mail redacted, and the loop below applies the SAME
   * transform — `redactForModel`, over the live bytes — to the subject and the snippet before any
   * port sees them. So the model sees what the user's own client shows them, one representation
   * rather than two, and the code itself never leaves the building.
   *
   * The automatic routing path in `pipeline.ts` is UNCHANGED and still refuses. Nobody presses
   * anything there, so there is no consent to point at; see `SensitivePayloadPolicy`.
   *
   * ## The order of the remaining gates
   *
   * money → model, and the sink can no longer throw on this path. That pairing is deliberate:
   * a sink that refused AFTER `gate.spend()` would charge a credit and return
   * `model_unavailable`.
   *
   * ## Two clicks do not pay twice, at THREE independent layers
   *
   *  1. **A stored suggestion is served, not re-bought.** The cheapest layer and the only one
   *     that also protects OUR cost: a `duplicate` charges the user nothing but still spends
   *     tokens, so a second click over the same senders must not reach the model at all.
   *  2. `Idempotency-Key` — claimed once the work is done, so a retry after a lost response
   *     replays the answer instead of re-running the purchase.
   *  3. `classify:screener:<message_id>` — the ledger's own identity, and the backstop for
   *     everything the first two cannot see (two hosts, two keys, one message). It answers
   *     `duplicate`, which is why `charged` can be lower than `quoted` for an honest reason.
   *
   * ## The model calls happen OUTSIDE any transaction, and each verdict lands ALONE
   *
   * Network latency inside a tx holds a pooled connection for the duration of N model calls, so
   * no `classify` runs inside one. Each verdict is then persisted in its OWN small transaction
   * rather than batched into a closing one: on a serverless host 50 senders is 50 model
   * round trips, and a function that dies at sender 40 with one pending write loses all 40
   * results the account has already paid for. Per message, a death costs the writes that had
   * not happened yet — and the money already spent buys those back for free, because the
   * ledger source is the message.
   */
  async suggest(
    ctx: ServiceContext,
    body: ScreenerSuggestBody,
    opts: { idempotency?: ScreenIdempotency | null } = {},
  ): Promise<ScreenerSuggestResult> {
    const senders = parseSenderSet(body);
    const dryRun = body?.dryRun === true;
    const classifier = this.classifier;
    if (!classifier) {
      // The same grammar as `drafter_unconfigured`: a host with no model is not broken,
      // it is a host that does not sell this, and 200-with-nothing would say the opposite.
      // `retryable: false` — only an operator can clear it.
      throw new ServiceError(
        "suggest_unconfigured", 503,
        "this deployment has no AI classifier connected", undefined, false,
      );
    }

    // THE ACCOUNT'S OHBOX PREFERENCE, read ONCE for the whole call — the two axes the worker
    // pipeline threads into `planChange`, mirrored here so a suggestion answers the same question
    // routing does. The BAR (`ohboxBar`) reaches the model's USER turn on every classify below; the
    // POSTURE tightens the Yes/No reading of what comes back ({@link screenedOut}). A NULL bar is
    // OMITTED, never the UI placeholder — the truthy check the worker uses
    // (the worker's `row?.bar ? … : omit`) — and a NULL posture resolves to the
    // lenient default, so an account that set neither classifies exactly as before this change.
    const pref = await getScreeningPreference(ctx);
    const ohboxPolicy = resolveOhboxPolicy(pref.ohboxPolicy);
    const ohboxBar = pref.ohboxBar ?? undefined;

    // ONE query for the whole set, and the representative per sender chosen by the SAME rule
    // `list` presents — otherwise the page prices one message and the purchase buys another.
    const rows = await this.heldRows(
      ctx, inArray(sql`lower(${messages.fromAddress})`, senders),
    );
    // The tiebreak is the half that makes "the SAME rule" true. Without it this kept whichever
    // row the driver returned first at a shared date — arbitrary, because `heldRows` orders by
    // `date` alone — while `heldSenderPage` breaks the same tie on `id DESC`. The page would
    // then price one message and this would buy a different one, which is the exact failure the
    // paragraph above forbids: a suggestion stored against a message the row on screen is not
    // about.
    const rep = new Map<string, ScreenerRow>();
    for (const r of rows) {
      const key = r.fromAddress.toLowerCase();
      const prev = rep.get(key);
      const t = r.date?.getTime() ?? 0;
      const p = prev?.date?.getTime() ?? 0;
      if (!prev || t > p || (t === p && r.messageId > prev.messageId)) rep.set(key, r);
    }
    // What is already bought. Read ONCE for the set, and the reason it is read at all is that a
    // `duplicate` costs the user nothing and costs US a model call.
    const stored = await this.storedSuggestions(ctx, [...rep.values()].map((r) => r.messageId), ohboxPolicy);

    const gate = this.credits?.(asTx(ctx), ctx.accountId);
    const suggestions: ScreenerSuggestion[] = [];
    const skipped: ScreenerSuggestResult["skipped"] = [];
    let quoted = 0;
    let charged = 0;
    let stopped: ScreenerSuggestResult["stopped"];
    /** WHY the gate refused, kept undiminished for the status decision below the loop. */
    let refusal: { refusal: "state" | "quantity" | "fault"; reason?: string } | undefined;

    for (const sender of senders) {
      const r = rep.get(sender);
      if (!r) { skipped.push({ sender, reason: "not_held" }); continue; }
      // ── THERE IS NO SENSITIVITY GATE HERE ANY MORE. THAT IS THE FEATURE ────────────────────
      //
      // This line read `if (!r.aiEligible) { skipped.push({ sender, reason: "withheld" }); … }`
      // and it was the whole of the withholding on the user-requested path. It is gone under the
      // AI-OPEN ruling (see the method docblock). Nothing replaces it: every held sender the
      // caller names is priced, charged and asked about, and the credential material is dealt
      // with by REDACTING the payload at the sink (`classifyUserPayload(input, "redact")`),
      // which is the same transform that produced the snippet stored on `r` in the first place.
      //
      // Removing it in isolation would have been a billing defect rather than a policy change,
      // and that is worth stating where the money is: `gate.spend()` is eight lines below, and
      // the sink used to THROW for exactly these rows. A withheld sender would have been debited,
      // then caught as `model_unavailable`, and the user would have paid a credit for a sentence
      // saying the model did not answer. The sink's `"redact"` policy is what makes this line's
      // removal safe, not the other way round.

      // ALREADY BOUGHT — answer from the store. Not `quoted`, because a control must not price
      // what it will not be charged for, and not `skipped`, because the caller asked a question
      // this has the answer to.
      const already = stored.get(r.messageId);
      if (already) {
        suggestions.push({ sender, messageId: r.messageId, ...already });
        continue;
      }
      quoted++;

      // THE PRICE CHECK STOPS HERE — above the gate, so a quote cannot debit, and above the
      // model, so a quote cannot send mail to a third party. `quoted` is the whole answer.
      if (dryRun) continue;

      if (gate) {
        const outcome = await gate.spend(screenerLedgerSource(r.messageId), { messageId: r.messageId });
        if (!outcome.permitted) {
          const reason = outcome.refusal === "quantity" ? "out_of_credits" : "spend_unavailable";
          skipped.push({ sender, reason });
          stopped ??= reason;
          refusal ??= outcome.refusal === "fault"
            ? { refusal: "fault" }
            : { refusal: outcome.refusal, reason: outcome.reason };
          continue;
        }
        // `charged: false` is a free retry of an attempt already on record — a `duplicate`.
        // Reporting it as spend would tell the user they paid twice for one message.
        //
        // `+= AI_ACTION_COST` and not `++`: the field is documented as CREDITS and `spend()`
        // moves `AI_ACTION_COST` of them per call (`ai-gate.ts` — `opts.amount ?? AI_ACTION_COST`,
        // and no amount is passed here). The two agree at today's value of 1, so this changes
        // no number now; it is the increment that stays true if the constant ever moves, and
        // the alternative is a field whose name and its arithmetic disagree.
        if (outcome.charged) charged += AI_ACTION_COST;
      }

      let result;
      try {
        // ── THE CREDENTIAL IS REMOVED HERE, AT THE CALLER, AND NOT ONE LAYER DOWN ────────────
        //
        // `redactForModel` runs the outbound screen over these exact bytes and, only where it
        // fires, replaces code-shaped and token-shaped runs with `[REDACTED]` — the same
        // transform `classifySensitivity` used to produce the stored body and the stored
        // snippet. So there is ONE redacted representation of this message: the one on disk, the
        // one on the user's screen, and the one on the wire.
        //
        // **Why here and not in the classifier's parameter builder**, which is where it is
        // tempting to put it: `classifier` is a PORT. `makeHaikuClassifier` is one implementation
        // of it; the sidecar's local Ollama and Anthropic providers are two more, and they
        // receive this object directly. A redaction applied inside the bundled builder would
        // protect exactly one of the three and leave a local model reading the raw code.
        //
        // It is not gated on `messages.no_ai`. That column is known-wrong for historical rows
        // (`sensitive-backfill.ts` exists for it and repaired 2,111 in August) and `r.subject` is
        // stored RAW even where the body was stored redacted — which is the field an OTP is
        // usually in. The bytes are always current; the flag is a claim about them.
        const safe = redactForModel(r.subject, r.snippet);

        // THE SCREENING QUESTION, not the routing one — see `classify-prompt.ts`. Routing asks
        // "which folder does this belong in", and `ohmail/Screener` is that taxonomy's own
        // definition of a first-contact sender, which is every row this loop can reach. Asking it
        // here was a question with its answer built in, and the model gave that answer 89% of the
        // time on an account with no stated bar.
        //
        // The fallback is `classify` because a `ClassifierPort` is implemented outside this repo's
        // core too. It degrades the advice and cannot degrade the safety: routing's answer for a
        // stranger coerces to `hold`, never to an admission.
        const ask = classifier.screen?.bind(classifier) ?? classifier.classify.bind(classifier);
        result = await ask({
          from: { name: null, address: r.fromAddress },
          subject: safe.subject,
          snippet: safe.snippet,
          headersDigest: "",
          fewShot: [],
          // The declaration that goes WITH the redaction above, and the only thing that stops the
          // outbound sink refusing a payload this method has already made safe. Absent everywhere
          // else, which is what keeps the automatic routing path refusing — see
          // `ClassifierInput.outbound`.
          outbound: "prescreened" as const,
          // The account's own "who belongs in my Ohbox" words, into the model's USER turn only —
          // the same field `planChange` threads on the routing path. Absent ⇒ omitted (never the
          // placeholder), and `classifyUserPayload` drops a blank, so a NULL bar is byte-identical
          // to the pre-bar request. It sharpens what the model proposes; it never itself files mail.
          ohboxBar,
        });
      } catch (err) {
        console.error(`[screener] AI suggestion failed for message ${r.messageId}:`, err);
        // Not refunded, and the charge is what buys the retry: the source is stable, so the
        // next attempt over this message answers `duplicate` and costs nothing.
        skipped.push({ sender, reason: "model_unavailable" });
        continue;
      }

      // Persisted NOW, in its own transaction, before the next model call is made.
      await this.store(ctx, r.messageId, result);
      suggestions.push({
        sender,
        messageId: r.messageId,
        ...suggestionAdvice(result.destination, result.spam, result.rationale, ohboxPolicy),
        confidence: result.confidence,
        rationale: result.rationale,
      });
    }

    // ── A RUN THAT PRODUCED NOTHING BECAUSE OF THE GATE IS NOT A SUCCESS ────────────────────
    //
    // `DraftingService` already decides these three answers and they are decided the same way
    // here: 503 for OUR fault (we do not bill for our outage), 409 for the account's own off
    // switch (fully funded; nothing they could buy would change it), 402 for an empty balance.
    // The condition is `suggestions.length === 0` rather than "the first refusal": a set where
    // eight senders were served and two ran out of credit is a 200 that says where it stopped,
    // because throwing there would discard eight results the account has already paid for.
    if (refusal && suggestions.length === 0) {
      if (refusal.refusal === "fault") {
        throw new ServiceError(
          "ai_unavailable", 503, "AI suggestions are temporarily unavailable; please retry",
        );
      }
      if (refusal.reason === "ai_disabled") {
        // The ACCOUNT'S OWN off switch. 402 would demand money from a fully funded account for a
        // state they chose; 409 says the request conflicts with a setting, and names it.
        throw new ServiceError(
          "ai_disabled", 409, "managed AI is switched off for this account",
          { reason: refusal.reason },
        );
      }
      throw new ServiceError(
        "insufficient_credits", 402, "no AI actions remain on this account",
        { reason: refusal.reason },
      );
    }

    // ── WHAT IS LEFT, FROM THE LEDGER THE GATE READS ──────────────────────────────────────
    //
    // AFTER the loop, so it is the balance this run left behind and not the one it began with.
    // No arithmetic: the client is never handed material to subtract `charged` from, because a
    // client-side balance is a shadow ledger that goes wrong on a renewal, a refund, an expiry
    // or a second tab — and goes wrong upward, telling somebody they have credits they do not.
    //
    // A FAILED READ IS SILENCE, NOT ZERO. The run has already completed and its suggestions are
    // already paid for; a database hiccup on a courtesy read must not turn a successful purchase
    // into an error, and must not report an empty balance to a funded account. Absent means "no
    // answer", which is exactly what an unmetered deployment (no `remaining` dep at all) means
    // too, so the client needs one rule for both.
    let remainingCredits: number | undefined;
    if (this.remaining) {
      try {
        remainingCredits = await this.remaining(asTx(ctx), ctx.accountId);
      } catch (err) {
        console.error(`[screener] balance read failed for account ${ctx.accountId}:`, err);
      }
    }

    const dto: ScreenerSuggestResult = {
      dryRun, requested: senders.length, quoted, quotedCredits: quoted * AI_ACTION_COST, charged,
      ...(stopped ? { stopped } : {}),
      ...(typeof remainingCredits === "number" ? { remainingCredits } : {}),
      suggestions, skipped,
    };

    // Idempotency, as `decide` does it — with one difference forced by the loop above: the claim can no
    // longer share a transaction with the effect, because the effect is N transactions and a
    // model call sits between them. It is still the right claim to make. A LOST claim means a
    // concurrent same-key request committed first; its stored response is replayed, and the
    // rows this one wrote carry the same verdicts for the same messages (the model was asked
    // once — the loser's `spend` answered `duplicate`), so the two agree by construction.
    //
    // A dry run claims nothing. It changed nothing, so there is nothing a replay must protect,
    // and burning the key would make the confirmation click that follows it a 409.
    if (opts.idempotency && !dryRun) {
      const claimed = await asTx(ctx).transaction(async (tx) => claimIdempotencyKey(tx, {
        accountId: ctx.accountId,
        key: opts.idempotency!.key,
        requestHash: opts.idempotency!.requestHash,
        responseStatus: 200,
        responseJson: dto,
        seq: 0,
        now: ctx.now(),
      }));
      if (!claimed) throw new IdempotencyRaceLost(ctx.accountId, opts.idempotency.key);
    }

    return dto;
  }

  /**
   * ONE suggestion, in its own transaction. Delete-then-insert rather than an upsert: there is
   * no unique key to conflict on (see {@link SUGGESTION_PROVENANCE}), and the delete is scoped
   * to this provenance so a pipeline routing decision for the same message is never touched.
   *
   * **No `recordChange`.** A suggestion is advice about mail, not a change to it; emitting a
   * `change_log` row would put it in `/sync` and make every client's delta stream carry model
   * output nobody asked for.
   */
  private async store(ctx: ServiceContext, messageId: string, result: ClassifierResultLike): Promise<void> {
    await asTx(ctx).transaction(async (tx) => {
      await tx.delete(routingDecisions).where(and(
        eq(routingDecisions.accountId, ctx.accountId),
        eq(routingDecisions.messageId, messageId),
        eq(routingDecisions.inputProvenance, SUGGESTION_PROVENANCE),
      ));
      await tx.insert(routingDecisions).values({
        accountId: ctx.accountId,
        messageId,
        inputProvenance: SUGGESTION_PROVENANCE,
        destination: result.destination,
        confidence: result.confidence,
        rationale: result.rationale,
        spam: result.spam,
        status: SUGGESTION_STATUS,
      });
    });
  }
}

/** The classifier's answer, as much of it as this file stores. */
interface ClassifierResultLike {
  destination: string;
  confidence: number;
  rationale: string;
  spam: boolean;
}

/**
 * ── WHAT EACH ROUTING DESTINATION MEANS TO THE SCREENER ──────────────────────────────────────
 *
 * `Record<Destination, …>` and NOT a lookup with a default, because the default is what broke.
 * Adding a folder to the `Destination` union without deciding what it means for a stranger at the
 * gate is now a COMPILE error rather than a silent "yes".
 *
 * THE DEFECT THIS REPLACES, in full, because the shape recurs: this collapse used to be a
 * predicate called `screenedOut` — a DENYLIST that named spam, `ohmail/Screened` and
 * `ohmail/Quarantine` and answered `false` (⇒ admit to the Ohbox) for everything else.
 * `ohmail/Screener` was not on that list. But `ohmail/Screener` is what the taxonomy DEFINES as
 * the right answer for a first-contact sender, and every row this service reasons about is a
 * first-contact sender — so the model's "hold this one for a human" was both the most common
 * answer and the one the mapping got wrong: it was read as "admit them". A stored suggestion of
 * `ohmail/Screener` rendered as "Ohbox", with the model's own hold-this rationale printed
 * underneath it, at whatever confidence the model had reported. With "Apply all" that is a consent
 * gate granting consent in bulk — the same inversion `screener-state.ts#applyAll` documents having
 * already been fixed once at the surface, reached the second time through the mapping instead of
 * through a fallback.
 *
 * A denylist is the wrong shape for a question whose safe answer is "don't act".
 */
const SCREEN_DISPOSITION: Record<Destination, ScreenerSuggestion["decision"]> = {
  "INBOX": "yes",
  "ohmail/Reads": "yes",        // posture may tighten this to "no" — see below
  "ohmail/Receipts": "yes",     // idem
  "ohmail/Screened": "no",
  "ohmail/Quarantine": "no",
  // NOT "no". The model declined to place this sender, it did not decline the sender. Turning that
  // into a decline would auto-screen-out real first-contact people on the same bulk control that
  // used to auto-admit them — a different wrong answer, not a fix.
  "ohmail/Screener": "hold",
};

/**
 * The Yes/No/Hold reading of a classifier verdict, UNDER THE ACCOUNT'S OHBOX POSTURE — ONE
 * definition, written once and read at both the fresh (`suggest`) and the stored
 * ({@link ScreenerReadService.storedSuggestions}) sites so a bought suggestion cannot read one way
 * when fresh and another on the next page load. That shared-ness is also what makes this fix
 * retroactive: the 83 rows already on disk are re-read through it and answer "hold" with no
 * backfill.
 *
 * **"hold" is advice with no action attached.** It is not a third destination — the wire still has
 * only the two outcomes `POST /screener/:id` can perform — it is the model saying the decision is
 * the account owner's. A surface may show it; a BULK control may never act on it.
 *
 * **POSTURE TIGHTENS "YES".** Under `people_only` the account keeps its Ohbox for real people and
 * the service mail it actually acts on, so a first-contact sender the model files into an AUTOMATED
 * pile (`ohmail/Reads` / `ohmail/Receipts`) is NOT admitted — it reads "no". This is the same two
 * piles, and only those two, that `pipeline.ts`'s `people_only` demotion moves out of the Ohbox
 * ({@link policyDemotion} → {@link headerHeuristic} answers Reads/Receipts); it never touches INBOX,
 * the Screener, or a denial. The LENIENT default — `people_and_replied`, which every NULL preference
 * resolves to via {@link resolveOhboxPolicy} — demotes nobody, so Reads/Receipts stay "yes" exactly
 * as before this posture existed, and an account that never set a posture classifies as it did.
 *
 * **THE RATIONALE IS CROSS-CHECKED AGAINST THE FIELD.** A reply whose prose concludes "hold at the
 * Screener" while its `destination` names a folder past the gate is downgraded to "hold" rather
 * than acted on ({@link rationaleHoldsAtGate}). Two channels carry the answer and only one is
 * schema-checked; when they disagree, the one that costs a human glance wins over the one that
 * writes an allow rule.
 */
/**
 * ONE stored row, read as advice — the decision AND the answer the decision collapses.
 *
 * Both callers go through here ({@link ScreenerService.suggest} for a fresh answer,
 * {@link ScreenerReadService.storedSuggestions} for one off disk) so a suggestion cannot read one
 * way when it is bought and another on the next page load. That shared-ness is also what makes a
 * change here retroactive: rows already written are re-read through it with no backfill.
 *
 * `destination` is normalised against the taxonomy for the same reason `suggestionDecision` is
 * total over strings — this reads a `text` column, which a past version or a hand-run migration
 * may have written. An unrecognised label becomes the gate, which is `hold`: never a guess.
 */
function suggestionAdvice(
  destination: string, spam: boolean, rationale: string, ohboxPolicy: OhboxPolicy,
): Pick<ScreenerSuggestion, "decision" | "destination" | "spam"> {
  const dest: Destination = CLASSIFY_DESTINATIONS.includes(destination as Destination)
    ? (destination as Destination)
    : "ohmail/Screener";
  return {
    decision: suggestionDecision(dest, spam, rationale, ohboxPolicy),
    destination: dest,
    spam: spam === true,
  };
}

function suggestionDecision(
  destination: string, spam: boolean, rationale: string, ohboxPolicy: OhboxPolicy,
): ScreenerSuggestion["decision"] {
  // Spam is the model's own hard "no" and outranks everything, including the label.
  if (spam) return "no";
  // A label outside the taxonomy is not advice. `coerceClassifierResult` already maps an unknown
  // one to the gate, but this is read from a STORED row too — a column, written by a past version
  // or a hand-run migration, is a `string` and this must be total over strings, not over the union.
  const disposition = SCREEN_DISPOSITION[destination as Destination] ?? "hold";
  if (disposition !== "yes") return disposition;
  if (rationaleHoldsAtGate(rationale)) return "hold";
  if (ohboxPolicy === "people_only"
    && (destination === "ohmail/Reads" || destination === "ohmail/Receipts")) return "no";
  return "yes";
}

/**
 * The sender set, or a 400 — {@link ScreenerService.suggest}'s only input.
 *
 * Everything unparseable lands here rather than in the loop below it, so there is exactly one
 * place where "we could not read what you asked for" is decided, and its answer is refusal.
 * Normalised to lowercase and deduped because the queue is keyed that way everywhere else in
 * this file — and because `["A@x.com", "a@x.com"]` priced as two senders would charge for one.
 */
function parseSenderSet(body: ScreenerSuggestBody): string[] {
  const raw = body?.senders;
  if (!Array.isArray(raw)) {
    throw new ServiceError("validation_failed", 400, "senders must be an array of sender addresses");
  }
  if (raw.length > MAX_SUGGEST_SENDERS) {
    // Refused, not truncated: a control that priced 401 must not silently buy 400.
    throw new ServiceError(
      "payload_too_large", 413,
      `senders must contain at most ${MAX_SUGGEST_SENDERS} addresses`,
    );
  }
  const out = new Set<string>();
  for (const s of raw) {
    if (typeof s !== "string") {
      throw new ServiceError("validation_failed", 400, "senders must be an array of sender addresses");
    }
    const trimmed = s.trim().toLowerCase();
    if (trimmed) out.add(trimmed);
  }
  if (out.size === 0) {
    throw new ServiceError("validation_failed", 400, "senders must name at least one sender");
  }
  return [...out];
}

/** A row, plus whatever suggestion is on record for it. No I/O, and nothing to spend. */
function toItem(r: ScreenerRow, aiSuggestion: ScreenerItem["aiSuggestion"]): ScreenerItem {
  return {
    id: r.messageId,
    messageId: r.messageId,
    threadId: r.threadId,
    sender: { name: null, address: r.fromAddress },
    subject: r.subject,
    snippet: r.snippet,
    receivedAt: (r.date ?? r.updatedAt).toISOString(),
    aiSuggestion,
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function makeScreenerService(deps: ScreenerSuggestDeps): ScreenerService {
  return new ScreenerService(deps);
}
