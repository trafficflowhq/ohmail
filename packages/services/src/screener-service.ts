import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  messages,
  folderState,
  routingDecisions,
  claimIdempotencyKey, settleIdempotencyKey, releasePendingIdempotencyKey,
  IDEMPOTENCY_PENDING_STATUS, IDEMPOTENCY_PENDING_BODY,
  screenerAttemptKey,
  storeScreenerSuggestion,
  screenerSuggestionsBySender,
  SCREENER_SUGGESTION_PROVENANCE,
  UNPRICED,
  // 0.14.1, 0.14.1 — the request path. See `screener-apply.ts` and `organizer-role.ts` in
  // `@trafficflow/db` for why the transactional core and the eligibility read live there.
  resolveCutline, senderIsActiveSql, senderIsDecidedSql, senderIsOwnSql, type ResolvedCutline,
  heldRowById, applyScreenerDecision, AccountErasedError, readAccountErasedAt, domainOf,
  readRequestEligibility, decisionCanBeApplied,
  listOutstandingForAccount,
  OrganizedElsewhereError, MailboxNotFoundError, ringFilingDoorbell,
  type AppliedScreenerRow, type RequestEligibility, type OrganizedBy,
  type Tx,
} from "@trafficflow/db";
// Values from the root barrel's pure leaf, the GATE as a type only — see `drafting-service.ts`.
/* The PORT, from the root barrel — not `@trafficflow/db/cloud`, which is the half that
 * answers. This service names a gate it may be handed; it never builds one, and it must
 * compile in a deployment where no gate and no ledger exist. */
import type {
  AccessPort, ActionPricing, AiCreditGate, AiRefusalReason, SpendPort,
} from "@trafficflow/db";
import { carryDialect, dialect } from "@trafficflow/db/dialect";
import type {
  AdapterPort, ClassifierPort, Destination, NativeLocator, OhboxPolicy, SenderReasonCode,
  SenderSignals,
} from "@trafficflow/core/mail";
import {
  applyReconcileAction, askScreeningQuestion, canonicalDestination, capSuggestion, createLogger,
  effectForDestination,
  resolveOhboxPolicy, senderCheckAll, senderFacts,
} from "@trafficflow/core/mail";
/* The verdict derivation moved to its own leaf when `materializeScreenerSuggestion` became its
   third reader — one reading for the page, the purchase and the `/sync` entity. */
import { reasonDetail, suggestionAdvice } from "./screener-advice.js";
import { correspondentsAmong, makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
/* `capabilityForKind` — the ONE map from a request kind to the capability its holder must
   advertise (mail 0094). Imported rather than spelled as a constant here so that this door and
   the record it writes cannot disagree about what `screener.decide` requires. */
import { capabilityForKind } from "@trafficflow/core/adapters/organizer-lease";
import { planAccountFanOut, writeReaderRequest, type AccountFanOut, type FanOutTarget } from "./reader-request.js";
import { bridgeTx, type ServiceContext } from "./context.js";
import { ServiceError, IdempotencyRaceLost } from "./errors.js";
import { refuseAiSpend, type AiRefusalClass } from "./ai-refusal.js";
import { getScreeningPreference } from "./screening-preference.js";
import { LearningService } from "./learning-service.js";
import { clampLimit, decodeKeysetCursor, encodeListCursor } from "./pagination.js";
import type { Folder, Page, ScreenerItem } from "./dto/types.js";

/**
 * ONE SENDER'S REFUSAL, KEPT WHOLE UNTIL THE STATUS IS DECIDED.
 *
 * `verdict` is the gate's own word — or this service's, for the two refusals it makes before the
 * gate is asked (`no_slot`, `inflight`) — and it exists because the log line is the only record
 * of WHY: a refusal nobody logged is a refusal nobody can attribute, which is what left an
 * account's "no AI credits remain" unexplainable on a four-figure balance.
 */
type GateRefusal = { refusal: AiRefusalClass; verdict: string; reason?: AiRefusalReason };

/** The sort floor for a message with no date — the same instant `to_timestamp(0)` named. */
const EPOCH = new Date(0);

/**
 * Where a best-effort filing doorbell reports a throw. Module scope and not injected: it is a
 * single warn line on a path whose failure costs one rotation, and nothing reads it back.
 */
const doorbellLog = createLogger({ service: "filing" });

/** Where unknown first-contact senders are held (core routing, `source:"screener"`). */
export const SCREENER_FOLDER: Destination = "ohmail/Screener";
const YES_FOLDER: Destination = "INBOX";               // Imbox
const NO_FOLDER: Destination = "ohmail/Screened";

/**
 * THE FIVE PLACES A DECISION MAY FILE MAIL, AND THE SIXTH THAT IS NOT ONE. The DecisionBar has
 * five buttons; the wire used to carry two folders, so three buttons wrote a rule naming a place
 * the user had not chosen. `Destination`, not a screener-only vocabulary: `move` takes `{folder}`
 * and `POST /rules` takes `{destination}` — a second spelling is drift. `ohmail/Screener` IS
 * ABSENT ON PURPOSE: it is where mail is HELD, never a place consent files to — a promoted rule
 * pointing at it holds the sender at the gate for ever. Membership FIRST, agreement second:
 * `effectForDestination("ohmail/Screener")` is `"deny"`, so the agreement check alone would wave
 * it through on any `no`.
 */
const DECIDABLE_FOLDERS: ReadonlySet<string> = new Set<Destination>([
  YES_FOLDER, "ohmail/News", "ohmail/Receipts", NO_FOLDER, "ohmail/Quarantine",
]);

/**
 * What the READ half is allowed to hold. No `classifier`, no `credits` — the absences ARE the
 * gate: `ScreenerReadService` is constructed with exactly this bag, so inside `list`/`decide` the
 * expressions `this.deps.classifier` and `this.deps.credits` DO NOT COMPILE. `ScreenerService`
 * destructures both out before `super`, so they are unreachable at runtime too. The alternative
 * is a `limit` constant guarding a call the read path can still make — the someone-remembers
 * form. Nobody has to remember this one.
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
  unsubscribe?: {
    /**
     * Returns what it LOOKED AT, structurally rather than by importing the service's own type:
     * this port exists so the Screener does not depend on that module, and `considered` is the
     * one number a decision has to report — the difference between it and the target count is
     * what the hourly drain still owes.
     */
    onScreenOut(ctx: ServiceContext, messageIds: string[]): Promise<{ considered: number }>;
  };
}

/**
 * What the SUGGEST half additionally holds — the model and the money, together, one level
 * down from every read.
 */
export interface ScreenerSuggestDeps extends ScreenerDeps {
  /** The model. Absent ⇒ `POST /screener/suggest` answers 503; no read path is affected. */
  classifier?: ClassifierPort;
  /**
   * The AI spend gate FACTORY, per account like every other gate. Absent ⇒ unmetered. A factory
   * rather than a gate because this service is constructed ONCE per host bag and serves every
   * account, while a gate is per account by construction — it holds the account's refund markers.
   * It moved OUT of `ScreenerDeps` with the classifier, for the same reason: a read path that can
   * build a gate is a read path that can charge, and the two capabilities are only useful
   * together.
   */
  credits?: SpendPort;
  /**
   * THE ACCESS HALF, READ ONLY WHEN THE GATE HAS ALREADY REFUSED — never on the way in.
   *
   * It is what makes a 402 corroborated: a `state` refusal is cross-checked against a fresh read
   * of this account's access, and one that says AI is available answers 503 instead of demanding
   * money (`ai-refusal.ts` holds the rule for this call site and the drafting one). ABSENT is a
   * host that wired no such reader, and then a `state` refusal answers exactly what it always
   * answered — the cross-check narrows a payment demand, it never widens one.
   */
  access?: AccessPort;
  /**
   * THE WALL-CLOCK CEILING THIS HOST KILLS A REQUEST AT — declared by the composition root,
   * ABSENT for a host that has none. `suggest` admits lanes only while there is time left for the
   * work about to start (`admissionDeadline`): this − the spend call's budget − the model call's
   * ceiling − the store after it. Three hosts compose this service and ONE is killed by a
   * platform: the serverless API (`maxDuration = 60`); the desktop deliberately permits a sixty
   * second model call, so a window sized for serverless would refuse every sender after the first
   * round there. Absent means "nothing kills a request here" — a claim a deployment makes about
   * itself, stated and never inferred.
   */
  invocationBudgetMs?: number;
  /**
   * THE BALANCE READ that answers "how much is left", beside the gate that spends it. A separate
   * dep, not a method on `SpendPort`: the gate is the permission question, this is a read with no
   * decision — widening the port would make every implementation (the one-line test doubles
   * included) owe an answer about a ledger they do not have. A factory taking `(db, accountId)`
   * for `credits`' reason: constructed once per host, serves every account. ABSENT ⇒
   * `remainingCredits` is omitted and the surface says nothing — the correct answer for the local
   * install and any unwired window: silence, never `0`. Also why `balanceOf` is not imported
   * here: it lives in `@trafficflow/db/cloud`, the half this module must compile without.
   */
  remaining?: (db: Tx, accountId: string) => Promise<number>;
  /**
   * WHAT ONE SUGGESTION COSTS, asked of whoever meters this host — never a figure held here.
   * Read only when a gate is composed: an unmetered host charges nothing, so it quotes nothing.
   * ABSENT ⇒ {@link UNPRICED}, and a metered host with no price withholds the quote and refuses
   * the purchase before the gate is asked — nobody is charged a figure they were not shown.
   */
  pricing?: ActionPricing;
}

export interface ScreenBody {
  decision: "yes" | "no";
  /**
   * WHERE THE USER ASKED FOR IT — one of `DECIDABLE_FOLDERS`. Optional, and absence is the
   * endpoint's original behaviour: `yes` ⇒ `INBOX`, `no` ⇒ `ohmail/Screened`. Optional because a
   * shipped desktop mirror and the API's contract tests post `{decision}` alone, and a client
   * that cannot name a folder should still admit a sender. NOT "the server will guess": present,
   * it decides the folder outright; absent, the two-folder default stands and `appliedFolder`
   * says which.
   */
  dest?: Destination;
  scope?: "sender" | "domain";   // default "sender"
  /**
   * Also apply the PROMOTED rule to this sender's mail that has already left the gate. Absent is
   * `true`, the contract `POST /rules` already carries; a non-boolean is a 400 rather than a
   * coercion, because `"false"` is truthy and reading an attempt to decline as consent to
   * reorganize a mailbox is the failure that check exists for.
   */
  applyRetro?: boolean;
}

/** Idempotency handle threaded in by the route; the row is written IN the decide tx. */
export interface ScreenIdempotency {
  key: string;
  requestHash: string;
}


/** One queued half of an account-wide decision — which mailbox waits, on whom, under which request. */
export interface ScreenRequestedMailbox {
  mailboxId: string;
  requestId: string;
  holder: OrganizedBy;
}

/**
 * WHERE AN ACCOUNT-WIDE DECISION LANDED, PER MAILBOX (0.20). `filed` re-routed now; `requested`
 * queued on the request road for the named install. A mailbox in neither list either held nothing
 * from this sender or is held by an install that cannot take requests — those rows stay visibly
 * held, which is the truthful rendering. Optional on the wire: an older server omits it.
 */
export interface ScreenDecisionMailboxes {
  filed: string[];
  requested: ScreenRequestedMailbox[];
}

export interface ScreenDecisionResult {
  messageId: string;
  appliedFolder: Folder;
  createdRuleId: string | null;
  /** See {@link ScreenDecisionMailboxes}. Absent from an older server; never absent from this one. */
  mailboxes?: ScreenDecisionMailboxes;
  /**
   * WHAT THIS REQUEST'S UNSUBSCRIBE FAN-OUT DID, and what it left: `done` of `of` is the honest
   * half of a per-request ceiling, since the hourly drain finishes the rest.
   *
   * ABSENT MEANS THIS REQUEST STARTED NO FAN-OUT — a "yes", a deployment with no unsubscribe
   * port, a decision that re-routed nothing, or an IDEMPOTENT REPLAY, served from the stored row
   * before `decide` runs and therefore posting to nobody. It never means the fan-out finished.
   */
  unsubscribed?: { done: number; of: number };
}

/**
 * `POST /screener/:id`'s OTHER shape (0.14.1) — a reader's decision, accepted but not
 * yet applied. `202`, never `200`: "Rule saved" is never claimed before the organizer's own pass
 * actually applies it (the ruling's own words). `holder` is who the client names in "Decided —
 * <holder> files it on its next pass."
 */
export interface ScreenRequestResult {
  pending: true;
  requestId: string;
  holder: OrganizedBy;
  /**
   * The account-wide picture (0.20): `filed` is always empty on this shape (nothing was written
   * here), and `requested` names EVERY queued mailbox — the primary `requestId`/`holder` above
   * stay what they always were, the TARGET mailbox's, so an older client reads them unchanged.
   */
  mailboxes?: ScreenDecisionMailboxes;
}

/* ── The explicit suggestion purchase ───────────────────────────────────────────────────── */

/**
 * Where a bought suggestion is STORED — a `routing_decisions` row: the table already holds "what
 * was decided about this message" — per account, FK'd to `messages`, dropped on account deletion,
 * granted to NO staff role. The two vocabulary values are NEW, matching no existing reader: the
 * pipeline's `'screener'` means "routed to the gate", not "the model advised"; reusing it merges
 * the two in every count. No `UNIQUE (account_id, message_id)`: the write deletes-then-inserts
 * and two concurrent suggests can leave two rows; the read takes the newest — untidiness, not
 * ambiguity. The value and write moved to `@trafficflow/db` (`storeScreenerSuggestion`); this
 * file keeps the name because the WHERE below is what makes a suggestion readable.
 */
const SUGGESTION_PROVENANCE = SCREENER_SUGGESTION_PROVENANCE;

/**
 * The most senders ONE `POST /screener/suggest` may cover — the PER-REQUEST cap. A cap, not a
 * truncation: over it the request is REFUSED (413) — a control that quotes a price and silently
 * buys up to the cap has priced something the user did not do. Every sender is spend-gated
 * INDIVIDUALLY, so a larger N costs proportionally more. Not a size chosen to fit one invocation:
 * fifty senders measured 100.8 s serial, 20.2 s in lanes — but the size that fits the deadline is
 * the CLIENT's (`SUGGEST_CHUNK_SIZE`, 40, deliberately below this). The run is RESUMABLE per
 * message, so a cut-short request bills only what it finished and a re-press resumes free
 * (`duplicate` re-asks nothing stored). A DRY RUN makes no model call.
 */
export const MAX_SUGGEST_SENDERS = 50;

/**
 * How long ONE `POST /screener/suggest` waits, in total, for verdicts another caller is already
 * buying. The gate refuses a second caller on a source being worked on; waiting is what makes a
 * correct system look correct — the verdict is arriving within seconds (the worker's auto-suggest
 * pass or another tab is paying), and a skip sends the person back to press again for something
 * already on its way. 2.5 s, both bounds real: below it a typical classification (~1 s, the
 * client gives it 10 s with one retry) reads as unavailable while merely in progress; above it
 * the wait eats the 60 s invocation the rest of the set must classify inside. Per REQUEST, not
 * per sender. Exceeding it costs one honest "retry", and the retry is free.
 */
const INFLIGHT_WAIT_MS = 2_500;

/**
 * How often that wait re-reads the store. Small enough to return promptly once the holder commits,
 * large enough that a full budget is ~20 indexed point reads and not a spin.
 */
const INFLIGHT_POLL_MS = 120;

/**
 * HOW MANY SENDERS OF ONE REQUEST ARE BOUGHT AT THE SAME TIME. The serial loop's wall clock was a
 * model round trip spent idle (~2 s per sender). Nothing about the money requires serial: `spend`
 * serializes on the balance row anyway, and one request's sources are distinct, so lanes never
 * contend for a claim. Five, not `Promise.all` — the smallest of three ceilings decides: the
 * provider's per-account rate limit; the pooled connection (`max: 1` — lanes queue, fine while
 * transactions are short and none spans a model call); the invocation deadline (five lanes bring
 * fifty senders to ~20 s inside 60 s). Owned here, not configuration: a tunable would be tuned
 * into a rate-limit failure, and the binding ceiling is the provider's.
 */
const SUGGEST_LANES = 5;

/**
 * THE ADMISSION WINDOW — DERIVED, NOT CHOSEN. A request killed by the platform has no error
 * handling: no response, no `finally`, no idempotency row — a sender charged and claimed before
 * that is money moved for a verdict nobody sees, and the next attempt is told `duplicate`. So the
 * window is what is left after the worst case a lane is about to start: invocation − the SPEND
 * CALL's budget − the model call's ceiling − the store after it. A round 45 s was wrong by
 * construction. Measured from the TOP of `suggest` with `Date.now()`, not `ctx.now()` — a frozen
 * test clock would switch it off silently. The release AFTER the store is left out on purpose: a
 * kill there loses nothing, since the suggestion is durable and the claim expires on its own.
 */
/** `maxDuration` on the catch-all route this service is served from. */
const SUGGEST_INVOCATION_BUDGET_MS = 60_000;

/**
 * THE WORST CASE OF ONE `askScreeningQuestion`, in wall time.
 *
 * `callCeilingMs({ timeoutMs: 10_000, maxRetries: 1 })` — the hosted API's own classifier
 * configuration — which is `timeoutMs × (maxRetries + 1) + maxRetries × MAX_RETRY_AFTER_MS`,
 * because a `Retry-After` is honoured up to that cap between attempts. A test recomputes this from
 * the real function rather than trusting the arithmetic here, so a change to either the function or
 * the deployment's numbers reddens rather than silently shrinking the margin.
 */
const SUGGEST_MODEL_CALL_CEILING_MS = 40_000;

/** The verdict's own transaction and the response after it. */
const SUGGEST_STORE_MARGIN_MS = 3_000;

/**
 * THE SPEND CALL'S OWN BUDGET — the first thing an admitted lane does, and on a metered host it is
 * a network call to another program. It was never subtracted here, which put the worst case 3 s
 * past the invocation on its own. Restated rather than imported, because `src` may not name the
 * Cloud barrel: `suggest-lane-gate.test.ts` pins it to the client's `ENTITLEMENTS_CALL_BUDGET_MS`.
 */
const SUGGEST_SPEND_CALL_CEILING_MS = 5_000;

/** What is left to admit lanes in, on a host whose ceiling is {@link SUGGEST_INVOCATION_BUDGET_MS}. */
const SUGGEST_ADMISSION_WINDOW_MS =
  SUGGEST_INVOCATION_BUDGET_MS - SUGGEST_SPEND_CALL_CEILING_MS
  - SUGGEST_MODEL_CALL_CEILING_MS - SUGGEST_STORE_MARGIN_MS;

/**
 * THE WINDOW FOR A HOST THAT STATES ITS OWN CEILING — a dependency, not the constant above. Three
 * hosts compose `ScreenerService` and only the serverless API is killed by a platform. The
 * self-hosted server and the desktop engine run in ordinary processes, and the desktop
 * deliberately permits a SIXTY SECOND call because a local model is slow — the serverless window
 * there would refuse every sender after the first round, enforcing a ceiling that host does not
 * have. So the ceiling is DECLARED by the host that has one; absent means "nothing kills a
 * request here" — the `trustedAuthservIds`/`storageCap` shape: a fact about the deployment,
 * stated by the composition root, never inferred.
 */
export function admissionDeadline(invocationBudgetMs: number | undefined): number {
  if (invocationBudgetMs === undefined) return Number.POSITIVE_INFINITY;
  return Date.now()
    + Math.max(0, invocationBudgetMs - SUGGEST_SPEND_CALL_CEILING_MS
      - SUGGEST_MODEL_CALL_CEILING_MS - SUGGEST_STORE_MARGIN_MS);
}

/**
 * HOW LONG A PENDING KEY WAITS FOR ITS ANSWER before a retry may take it over. A run the platform
 * kills has no `finally`, so its claim must free itself: the host's own ceiling plus the store
 * margin, or a quarter hour where nothing kills a request (the desktop's slow local model
 * included). A run that outlives it is answered by whichever run settles first.
 */
export function pendingKeyTtlMs(invocationBudgetMs: number | undefined): number {
  return (invocationBudgetMs ?? 15 * 60_000) + SUGGEST_STORE_MARGIN_MS;
}

/**
 * The per-sender wall time this build sizes a request against — the measured ~2 s of model round
 * trip with a third on top, so an ordinary slow answer does not push a request past its own
 * admission window.
 */
const SUGGEST_PER_SENDER_BUDGET_MS = 3_000;

/**
 * WHAT THIS SERVER TELLS A CLIENT TO PUT IN ONE REQUEST — published as
 * `suggestable.recommendedPerRequest`, a fact about THIS BUILD. DERIVED like the window: lanes
 * admit in rounds of `SUGGEST_LANES`, each round one sender's wall time, so the largest request
 * that reliably finishes is lanes × floor(window / per-sender) = 5 × floor(12 s / 3 s) = 20. It
 * was 25 while the spend call cost the window nothing, which was never true. Deliberately BELOW
 * `MAX_SUGGEST_SENDERS`: that cap is the 413 boundary, this is the latency budget — equal would
 * leave no reserve.
 */
export const SUGGEST_RECOMMENDED_PER_REQUEST =
  SUGGEST_LANES * Math.floor(SUGGEST_ADMISSION_WINDOW_MS / SUGGEST_PER_SENDER_BUDGET_MS);

/**
 * The admission arithmetic, exported so a test can recompute it from the real
 * `callCeilingMs` and the deployment's own numbers rather than trusting the constants here.
 * Nothing in the product imports it.
 */
export const SUGGEST_ADMISSION = {
  invocationMs: SUGGEST_INVOCATION_BUDGET_MS,
  spendCallCeilingMs: SUGGEST_SPEND_CALL_CEILING_MS,
  modelCallCeilingMs: SUGGEST_MODEL_CALL_CEILING_MS,
  storeMarginMs: SUGGEST_STORE_MARGIN_MS,
  windowMs: SUGGEST_ADMISSION_WINDOW_MS,
  lanes: SUGGEST_LANES,
  perSenderBudgetMs: SUGGEST_PER_SENDER_BUDGET_MS,
} as const;

/**
 * …AND THE CEILING IS PER PROCESS, NOT PER REQUEST. A bound local to one `suggest` bounds nothing
 * a rate limit cares about: ten concurrent requests would each start five lanes — fifty calls in
 * flight, the fan-out `SUGGEST_LANES` exists to prevent. This is the admission control and it
 * wraps the MODEL CALL alone: a waiting lane holds no transaction and no connection, and the wait
 * is bounded by one round trip. One process: on a container that is the whole deployment; on
 * serverless it is one instance, so the fleet-wide ceiling is the platform's invocation
 * concurrency × this number. The honest consequence is stated: a provider 429 arrives as
 * `model_unavailable` with the charge standing, bought back free by the `duplicate` retry.
 */
/** Exported for its own unit test — the mechanism, driven directly. Not part of the service API. */
export class LaneGate {
  private live = 0;
  private readonly waiting: Array<{ resolve(ok: boolean): void }> = [];
  constructor(private readonly ceiling: number) {}

  /**
   * A slot, or FALSE because `deadline` passed first. THE DEADLINE IS THE HALF THAT KEEPS THIS
   * FROM BEING A NEW BUG: a queue with no deadline turns "too many requests at once" into "a
   * request that never answers" — four multiplexed forty-sender calls are 160 two-second model
   * calls through five slots, over two minutes against a sixty-second kill. Combined with
   * charging BEFORE the wait (the first version), that left senders debited and claimed with no
   * response and no idempotency row. Both halves fixed: the slot is taken BEFORE `gate.spend()`,
   * and a slot the budget cannot buy is a REFUSAL, per sender, that spent nothing.
   */
  async acquire(deadline: number): Promise<boolean> {
    // A NON-FINITE DEADLINE IS "THIS HOST HAS NO INVOCATION CEILING" — see
    // `ScreenerDeps.invocationBudgetMs`. It waits, and it waits without a timer: `setTimeout`
    // refuses a non-finite delay (it warns and fires on the next tick), which would turn "no
    // deadline" into "every deadline has already passed".
    const bounded = Number.isFinite(deadline);
    // THE DEADLINE IS CHECKED FIRST, and the order is the whole point. It used to test capacity
    // first, so once a run passed its budget the very next lane to finish handed its slot
    // straight to another sender — admitted, debited and started AFTER the window that exists to
    // stop exactly that. A free slot is not a reason to begin work there is no time to finish.
    const left = deadline - Date.now();
    if (bounded && left <= 0) return false;
    if (this.live < this.ceiling) { this.live++; return true; }
    if (!bounded) return new Promise<boolean>((resolve) => { this.waiting.push({ resolve }); });
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const entry = {
        resolve: (ok: boolean): void => { clearTimeout(timer); resolve(ok); },
      };
      timer = setTimeout(() => {
        // REMOVED FROM THE QUEUE, and this is the leak the timeout would otherwise create: a
        // `release` that handed its slot to a waiter which has already given up would decrement
        // nothing and admit nobody, shrinking the ceiling by one for the life of the process.
        const i = this.waiting.indexOf(entry);
        if (i >= 0) this.waiting.splice(i, 1);
        resolve(false);
      }, left);
      timer.unref?.();
      this.waiting.push(entry);
    });
  }

  /** FIFO, so a request that arrived first is not starved by one that arrived later. */
  release(): void {
    const next = this.waiting.shift();
    if (next) { next.resolve(true); return; }   // the slot is handed over, never returned and re-taken
    this.live--;
  }
}

/**
 * MODULE SCOPE, deliberately — see {@link LaneGate}. One per process, shared by every request.
 *
 * EXPORTED for one reason and it is a money reason: the property that a sender is never charged
 * for a queue position can only be driven by a test that can occupy the gate, and the gate a
 * purchase actually uses is this instance. Nothing in the product imports it.
 */
export const suggestLaneGate = new LaneGate(SUGGEST_LANES);
const laneGate = suggestLaneGate;

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
  /**
   * THE CEILING THE PERSON CONFIRMED, in credits — the figure the control showed beside the
   * button, handed back so the run cannot cost more than it. Ruled 2026-09-22: a confirmed run is
   * bounded by the QUOTE, with {@link MAX_SUGGEST_SENDERS} as the second and lower bound. The
   * quote and the confirm are two requests, and a stored suggestion can lapse between them — so a
   * set priced at 30 can price at 40 by the time somebody presses, and the press would buy ten
   * nobody was quoted for. ABSENT means unbounded by any quote: an older client, or a caller that
   * showed no figure. A present value that is not a non-negative integer is a 400 rather than an
   * ignored field — a money bound that silently disappears is worse than none claimed.
   */
  maxCredits?: unknown;
}

export interface ScreenerSuggestion {
  sender: string;
  messageId: string;
  /**
   * `hold` is the model declining to place this sender — see `screener-advice.ts`'s
   * `SCREEN_DISPOSITION`. It is
   * advice a surface may show and a BULK control may never act on.
   *
   * It stays three-valued now that {@link ScreenerSuggestion.destination} sits beside it, and that
   * is the point of the pair: this field is what a BULK control reads, so widening it would have
   * widened what one press of "Apply all" can do. The finer answer is carried, not acted on.
   */
  decision: "yes" | "no" | "hold";
  /**
   * The pile the model actually named, unreduced. `decision` answers "may a bulk control act, and
   * which way"; three values cannot also say WHICH of five piles — `ohmail/Receipts`,
   * `ohmail/Reads` and `ohmail/Quarantine` all reached the surface as "Screened out", so the
   * product looked as though it never suggested any of the three. `POST /screener/:id` already
   * accepts each as a `dest`, so a surface can offer the suggestion as a one-press filing. It
   * must not act WITHOUT a press — that is `decision`'s job, and `decision` still says `hold`
   * wherever the model declined.
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
  /**
   * WHICH FACT OHMAIL CHECKED DECIDED THIS — see `ScreenerItem.aiSuggestion.reasonCode`, the same
   * closed set for the same reason. Absent wherever the model's own answer stands, which is
   * nearly every sender; a client that ignores it behaves exactly as before.
   */
  reasonCode?: SenderReasonCode;
  /** The brand the mail claimed to be, for `impersonation` — ohmail's dictionary word, not the
   *  sender's. Absent for every other code. */
  reasonBrand?: string;
  /** How many unrelated senders carried this subject, for `campaign`. Absent otherwise. */
  reasonCount?: number;
}

/**
 * Why a requested sender produced nothing. Every one of these costs zero credits EXCEPT
 * `model_unavailable`, which is charged and then retried for free (the classify path's rule).
 */
export type ScreenerSuggestSkip =
  | "not_held"            // no mail from this sender is at the gate
  | "out_of_credits"      // the balance ran out part-way through the set
  | "over_quote"          // the run reached the number the person confirmed — see `maxCredits`
  | "spend_unavailable"   // see below — every "not now, ask again" the gate can produce
  | "model_unavailable";  // charged, the model faulted; the free retry honours it
/**
 * `spend_unavailable` COVERS ONE MORE THING since the double-buy fix, deliberately not a new wire
 * value: another caller holds the exclusive claim on this sender's message and did not finish
 * inside this request's wait budget. The cause differs from a subscription state or a gate fault;
 * the INSTRUCTION to the client is identical and is the whole content of the value — nothing
 * owed, nothing broken, ask again. A fourth reason would add a branch to every consumer to say
 * the same sentence in a rarer case. The one thing it must never be is `out_of_credits`: the
 * account is funded, and answering a concurrency overlap with a demand for money is the error
 * that would matter.
 */
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
   * What `quoted` COSTS, in credits — `quoted ×` the price the metering program states for one
   * Screener suggestion ({@link ScreenerSuggestDeps.pricing}); 0 on a host that meters nothing.
   * ABSENT when a metered host has no price: the client then offers no purchase, because a figure
   * nobody could state is not one anybody can consent to. Count and price are different numbers;
   * only the price is what a control names before it spends, which is why the client never
   * multiplies.
   */
  quotedCredits?: number;
  /** Credits this request moved. A re-run over the same mail is a `duplicate` and charges 0. */
  charged: number;
  /**
   * Set when the spend gate stopped the run PART-WAY. Absent when everything asked for was
   * served, and never the whole answer: a run that produced nothing because of the gate is a
   * 402/409/503 instead, because "you have no credits" is not a successful request.
   */
  stopped?: "out_of_credits" | "over_quote" | "spend_unavailable";
  /**
   * WHAT IS LEFT ON THE ACCOUNT AFTER THIS REQUEST — read from the ledger, never inferred. The
   * summary states what the run cost; "how much is left?" had no answer on this path, and a
   * client subtracting `charged` from a remembered figure keeps a shadow ledger: wrong after a
   * renewal, a refund, a second tab, an expiry — and wrong in the direction that claims credits
   * that are not there. Money is named by the side that moves it. OPTIONAL, and the optionality
   * is the contract: a deployment with no ledger supplies no reader, the field is ABSENT and the
   * client omits the clause — never `0` for "we do not know"; zero is a real balance with its own
   * sentence. Read AFTER the loop: the balance the run left behind.
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
/**
 * A PAGE CAN COME BACK EMPTY WITH A CURSOR STILL SET, AND THAT MEANS "KEEP GOING". `nextCursor`
 * is anchored to the last row the QUERY consumed, never the last row RETURNED — anchoring to
 * returned rows would re-offer or skip rows the next call already passed. The returned rows are
 * the query's rows MINUS every sender with a decision in flight, so a whole page's worth decided
 * on another door leaves `items` empty with plenty of queue behind it. Stop on `nextCursor ===
 * null`, never on `items.length === 0`: a client that stops on empty shows an empty Screener to
 * somebody whose queue is not.
 */
export interface ScreenerPage extends Page<ScreenerItem> {
  suggestable: {
    /** Page senders that are held, AI-eligible, and have no stored suggestion yet. No price: the
     *  figure a person consents to is the dry run's `quotedCredits` over the set they press. */
    senders: string[];
    /**
     * How many senders one `POST /screener/suggest` will accept — `MAX_SUGGEST_SENDERS`,
     * published so the client learns the PER-REQUEST cap by READING it rather than hardcoding a
     * constant that drifts. The webapp does not batch by the page — its queue derives from the
     * `/sync` mirror — and may offer a purchase LARGER than this cap, splitting it into requests
     * of at most this many, priced and bought each on its own (`screener-suggest.ts`). Not the
     * ladder's top: the CEILING on one chunk, and the only thing keeping a chunk under the 413.
     */
    maxPerRequest: number;
    /**
     * HOW MANY SENDERS THIS SERVER RECOMMENDS PER REQUEST — the latency budget, distinct from the
     * 413 cap above; a CAPABILITY SIGNAL, not a second limit. Server and clients release
     * separately, so during a rollout (or rollback) a new client can talk to an old server that
     * bought senders SERIALLY — a chunk sized for lanes would run past the deadline there and
     * leave a partly debited purchase with no response; `maxPerRequest` cannot reveal that, both
     * versions publish 50. ABSENT ⇒ the client keeps its own conservative fallback — an old
     * server omits the field, exactly as one deployed before the field existed.
     */
    recommendedPerRequest: number;
  };
  /**
   * SENDERS THIS INSTALL HAS ALREADY DECIDED ON, WAITING FOR THE ORGANIZER. A sender with a
   * `pending` or `sent` request in `organizer_requests` is EXCLUDED from `items` the instant the
   * decision is made — the sender leaves the reader's queue immediately — and named here instead,
   * so the client renders "Decided — <holder> files it on its next pass" rather than the same
   * sender twice under two states. Visible only on the door that made the decision:
   * `organizer_requests` is per-install bookkeeping, and another install's `GET /screener` reads
   * a different database with no row — that install truthfully shows the sender as held until the
   * organizer applies.
   */
  pendingDecisions: ScreenerPendingDecision[];
}

/** One entry of {@link ScreenerPage.pendingDecisions}. */
export interface ScreenerPendingDecision {
  /** The address (sender scope) or the domain (domain scope) the decision covers, lower-cased. */
  subject: string;
  scope: "sender" | "domain";
  decidedAt: string;
  /**
   * Has this install's own cycle appended it to the mailbox yet?
   *
   * KEPT ALONGSIDE {@link state} rather than replaced by it: a client written against the 0.14.1
   * shape reads this field, and `state === "sent"` is exactly what it always meant. Renaming it
   * would have been a wire break for a rename's worth of benefit.
   */
  sent: boolean;
  /**
   * WHERE THE DECISION ACTUALLY IS (mail 0090). `pending` — queued here, not yet handed to the
   * mailbox. `sent` — in the mailbox, waiting for the organizer. `refused` — the organizer said
   * no; THE SENDER IS BACK IN THE QUEUE, and this entry explains why the decision did not take
   * effect. `applied` and `expired` never appear: the first needs no explaining, the second
   * returns the sender to the queue with the ordinary "nobody is organizing this" notice.
   */
  state: "pending" | "sent" | "refused";
  /**
   * What the organizer said no to — a closed vocabulary this codebase defines (`unauthenticated`,
   * `conflict`, `wrong_mailbox`, `invalid_payload`, `unhandled_kind`, `stale`, `account_erased`),
   * never free text and never a stranger's. `null` outside `refused`, and also for a refusal whose
   * named reason this build does not recognise — a newer organizer's vocabulary reaches an older
   * reader as "refused, reason unknown" rather than as an unrendered string.
   */
  refusedReason: string | null;
}

interface ScreenerRow {
  /**
   * WHICH MAILBOX THIS MESSAGE IS IN. The role is asked per mailbox, never per account (an
   * account may hold an organized mailbox and a read-only one at once), so anything that has to
   * know whether a decision on this message could ever be APPLIED needs the mailbox it belongs
   * to. `suggest` is the caller that does.
   */
  mailboxId: string;
  messageId: string;
  threadId: string | null;
  fromAddress: string;
  /** The display name the sender chose, when the mirror parsed one. Read by the sender check. */
  fromName: string | null;
  /** `messages.auth_verdict` — NULL until that column is wired, and NULL is permissive. */
  authVerdict: string | null;
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
 * The columns a `ScreenerRow` is built from — named ONCE. ONE query produces this row:
 * `heldSenderReps`, the representative-per-sender window that `list` pages and `suggest` narrows
 * to the senders a person named. It and `toScreenerRow` are why nothing can drift about what a
 * held row IS. (`decide` reads one row by id through `@trafficflow/db#heldRowById`.) `no_ai` and `sensitivity_category` used to be selected to compute an `aiEligible` flag;
 * both are gone under AI-OPEN, and the field was deleted rather than left unread: an unread
 * eligibility boolean is an invitation to gate on it again — `screener-ai-open.test.ts` plants
 * the old gate and watches it go red. The COLUMNS stay in the database and still drive stored
 * redaction; this is about what the suggestion path reads.
 */
const HELD_COLUMNS = {
  messageId: messages.id, threadId: messages.threadId, fromAddress: messages.fromAddress,
  // THE TWO THE SENDER CHECK READS. `from_name` is the identity the sender asserted and
  // `auth_verdict` the one fact on the row nobody outside could write; both are read by
  // `sender-check.ts` so the reason this page RENDERS is derived from the same inputs the
  // worker's pass capped the stored row with. Selecting fewer here would show a capped
  // suggestion with no sentence under it.
  fromName: messages.fromName, authVerdict: messages.authVerdict,
  subject: messages.subject, snippet: messages.snippet, date: messages.date,
  nativeLocator: messages.nativeLocator, observedFolder: folderState.observedFolder,
  updatedAt: messages.updatedAt, unread: messages.unread, mailboxId: messages.mailboxId,
} as const;

function toScreenerRow(r: {
  messageId: string; threadId: string | null; fromAddress: string; subject: string;
  snippet: string; date: Date | null; nativeLocator: unknown; observedFolder: string;
  updatedAt: Date; unread: boolean; mailboxId: string;
  fromName?: string | null; authVerdict?: string | null;
}): ScreenerRow {
  return {
    mailboxId: r.mailboxId,
    messageId: r.messageId,
    threadId: r.threadId ?? null,
    fromAddress: r.fromAddress,
    fromName: r.fromName ?? null,
    authVerdict: r.authVerdict ?? null,
    subject: r.subject,
    snippet: r.snippet,
    date: r.date,
    observedFolder: r.observedFolder,
    nativeLocator: (r.nativeLocator as NativeLocator | null) ?? { folder: r.observedFolder, ref: "0:0" },
    updatedAt: r.updatedAt,
    unread: r.unread,
  };
}

const asTx = (ctx: ServiceContext): Tx => bridgeTx(ctx.db);

/**
 * The `(date, messageId)` keyset for the Screener's `date desc, messageId desc` order — same
 * shape and encoding as `MessageService`'s. The tuple, not the id alone: senders share dates (an
 * ESP sends a batch in one second), so a date-only cursor would skip every sender after the first
 * at that instant; `?? 0` maps undated mail to the epoch, where the sort puts it too. The
 * encodings match; the two lists do NOT page identically over UNDATED mail, in this file's
 * favour: `MessageService.list` orders by bare `desc(date)` (NULLS FIRST) and drops undated rows
 * after page one; here the sort key is `coalesce(date, epoch)` in BOTH the ORDER BY and the
 * keyset, so undated mail sorts last and pages like everything else.
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
  // The shape checks this used to make itself now live in `decodeKeysetCursor`, which every
  // (date, id) family shares — including the epoch RANGE, which none of them checked.
  const { millis, id } = decodeKeysetCursor(cursor);
  return { time: millis, messageId: id };
}

/**
 * The READ half of the Screener — the queue and the decision, NOTHING that spends. `list` used to
 * call the model per held sender per page: a read that charged, cost scaling with scrolling,
 * first-contact subjects shipped to a third party by LOOKING. Generation is now a purchase
 * (`suggest`); this class returns what is stored — `ScreenerDeps` has no classifier and no gate
 * factory, so a model call or debit does not compile here. The queue is DERIVED: every message
 * whose desired folder is `ohmail/Screener`, one entry per distinct sender. `decide` re-routes
 * ALL the sender's held mail and creates a `provenance:'promoted'` rule; yes marks the sender
 * known, no arms auto-unsubscribe. The IMAP move runs outside the tx.
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
    /* ── THE ACCOUNT'S POSTURE AND ITS CUTLINE, ON ONE READ, BEFORE THE QUEUE QUERY ──────────
     *
     * This read used to sit BELOW the queue query, because nothing in the query needed it. The
     * cutline does: a sender the cutline has retired is not a row of this page. Read once here so
     * the queue and `GET /consent`'s count cannot be measured from different fetches — the rule
     * `screeningBaselineAt`'s own comment states about the two halves of the cutoff, applied to
     * the two surfaces that show the same number.
     */
    const preference = await getScreeningPreference(ctx);
    const cutline = resolveCutline({
      baselineAt: preference.screeningBaselineAt,
      dormancyDays: preference.dormancyDays,
      scope: preference.screeningScope,
      now: ctx.now(),
    });
    const windowed = await this.heldSenderPage(ctx, { after, limit: limit + 1, cutline });
    const unfiltered = windowed.slice(0, limit);

    // ── A SENDER THIS INSTALL HAS ALREADY DECIDED ON LEAVES THE QUEUE (0.14.1) ────
    //
    // ONE extra query for the whole page, on `list`'s own established rule beside it. Small by
    // construction: `organizer_requests` holds at most a handful of in-flight decisions per
    // account, drained within a cycle or two of being written. A `scope:"domain"` decision
    // excludes every held sender AT that domain, not only the one address the decision named —
    // the same "the whole bag follows the scope" rule `decide` itself enforces.
    const outstanding = await listOutstandingForAccount(asTx(ctx), ctx.accountId, ctx.now());
    // ── A REFUSAL DOES NOT EXCLUDE, AND THAT IS THE WHOLE DIFFERENCE ────────────────────────
    //
    // `pending` and `sent` mean "the person has answered for this sender and we are carrying it
    // out", so the sender leaves the queue. `refused` means the organizer said NO — the decision
    // did not happen, so the sender must come BACK and be answerable again. Excluding it would
    // hide a sender the person still has to deal with, which is the same class of lie as
    // reporting a refusal as applied.
    const stillWaiting = outstanding.filter((o) => o.state !== "refused");
    const outstandingSenders = new Set(stillWaiting.filter((o) => o.scope === "sender").map((o) => o.match));
    const outstandingDomains = new Set(stillWaiting.filter((o) => o.scope === "domain").map((o) => o.match));
    const isDecided = (address: string): boolean => {
      const lower = address.toLowerCase();
      return outstandingSenders.has(lower) || outstandingDomains.has(domainOf(lower));
    };
    const pageRows = unfiltered.filter((r) => !isDecided(r.fromAddress));
    /**
     * ONE ENTRY PER SUBJECT (0.20): an account-wide decision queues one request PER MAILBOX, and
     * mapping rows 1:1 rendered the same sender N times — the exact double this field's contract
     * forbids. While ANY of a subject's requests is still in flight the decision IS in flight
     * (`pending` until every one has travelled, then `sent`), and a refusal is shown only once no
     * sibling is carrying the decision — beside an excluded sender it would read as a
     * contradiction; when the last one refuses, the sender is back and the reason shows.
     */
    const bySubject = new Map<string, typeof outstanding>();
    for (const o of outstanding) {
      const key = `${o.scope}:${o.match}`;
      const bag = bySubject.get(key);
      if (bag) bag.push(o); else bySubject.set(key, [o]);
    }
    const pendingDecisions: ScreenerPendingDecision[] = [...bySubject.values()].map((bag) => {
      const inFlight = bag.filter((o) => o.state !== "refused");
      const rows = inFlight.length > 0 ? inFlight : bag;
      const o = rows.reduce((a, b) => (a.decidedAt <= b.decidedAt ? a : b));
      const state = inFlight.length === 0 ? "refused"
        : inFlight.every((r) => r.state === "sent") ? "sent" : "pending";
      return {
        subject: o.match, scope: o.scope, decidedAt: o.decidedAt.toISOString(),
        // KEPT, and kept meaning exactly what it always meant, so a client written against the
        // 0.14.1 shape does not change behaviour: "this install has handed the decision over".
        sent: state === "sent",
        state,
        refusedReason: state === "refused" ? o.refusedReason : null,
      };
    });

    // The account's posture, resolved the same way the worker and the API read it — NULL/absent ⇒
    // {@link resolveOhboxPolicy}'s lenient default. It changes only how a STORED verdict reads as
    // Yes/No ({@link screenedOut}), never what was bought: a sender the model filed under Reads is
    // "yes" while the posture is lenient and "no" once it is `people_only`, with no re-purchase.
    const posture = resolveOhboxPolicy(preference.ohboxPolicy);

    // ONE extra query for the whole page, none for an empty one. BY SENDER, NOT BY
    // REPRESENTATIVE: the row on screen is a SENDER and the advice bought is about that sender,
    // so the page asks "does this account hold advice about them" — whichever message the verdict
    // was generated from. Asking about the representative alone (the sender's NEWEST held
    // message) meant one more message from them hid paid-for advice: no chip, no "Apply all", and
    // the automatic on-open batch — whose buy list is "senders with no answer" — bought them
    // again. One sender, re-sending, priced once per Screener open. The verdict may come from
    // mail older than the row on screen; a person who wants the newer mail read has the re-ask
    // ladder, priced per message.
    const stored = await this.senderSuggestions(
      ctx, pageRows.map((r) => r.fromAddress.toLowerCase()), posture,
    );

    // WHO THESE SENDERS REALLY ARE, over the page the person is reading — see
    // `senderSignalsByMessage`. Free (no query, no model) and applied to advice that is already
    // on record, so a suggestion bought before this shipped says why it was wrong here too.
    const checked = senderSignalsByMessage(pageRows);
    await markCorrespondents(ctx, pageRows, checked);
    const items = pageRows.map((r) => toItem(r, withSenderCheck(
      stored.get(r.fromAddress.toLowerCase()) ?? null, checked.get(r.messageId), posture,
    )));

    // The quote. A sender is priced when not already paid for (`!stored`) — the WHOLE rule; the
    // fact is in hand, so this costs no query. It used to also require `r.aiEligible`, and the
    // halves had to agree with `suggest`'s own loop or the page priced a set the purchase would
    // not buy; they still agree, by both having one clause. Under AI-OPEN every held sender is
    // suggestable, so a quote that subtracted credential-bearing ones would under-price a
    // purchase that then charged for them. A SENDER WHOSE STORED VERDICT BELONGS TO AN OLDER
    // REPRESENTATIVE IS NO LONGER PRICED HERE: this field is what an UNPRESSED batch reads as its
    // buy list, so pricing them made a re-sending stranger a recurring charge — they appear in
    // the re-ask ladder instead, where the price is seen before it is spent.
    const suggestable = pageRows
      .filter((r) => !stored.has(r.fromAddress.toLowerCase()))
      .map((r) => r.fromAddress.toLowerCase());

    // The CURSOR is anchored to the last row the QUERY consumed (`unfiltered`), never to the
    // last row this page actually RETURNS (`pageRows`, which can be shorter once a decided
    // sender is filtered out) — anchoring it to `pageRows` would re-offer or skip rows the next
    // call already passed, exactly the failure the keyset exists to avoid.
    const last = unfiltered[unfiltered.length - 1];
    const nextCursor = windowed.length > limit && last ? encodeScreenerCursor(last) : null;
    return {
      items,
      nextCursor,
      suggestable: {
        senders: suggestable,
        maxPerRequest: MAX_SUGGEST_SENDERS,
        recommendedPerRequest: SUGGEST_RECOMMENDED_PER_REQUEST,
      },
      pendingDecisions,
    };
  }

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  VALIDATE — pure input-format checks, shared by the organizer's direct write and the
   *  reader's request. 0.14.1: extracted so the SAME function refuses a malformed
   *  decision whichever door it arrives through, rather than one door's checks drifting from
   *  the other's.
   * ══════════════════════════════════════════════════════════════════════════════════════════
   */
  private async validateScreenerDecision(ctx: ServiceContext, id: string, b: ScreenBody): Promise<{
    scope: "sender" | "domain"; decision: "yes" | "no"; dest: Destination | undefined;
    target: AppliedScreenerRow; address: string; domain: string; appliedFolder: Destination;
    applyRetro: boolean;
  }> {
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
    // AND SO IS `dest`, TWICE, IN THIS ORDER — two refusals, two mistakes. A folder outside
    // `DECIDABLE_FOLDERS` is a client naming a place a decision may not file to — an invented
    // string, or `ohmail/Screener`, which would promote a rule holding the sender at the gate for
    // ever. A DECIDABLE folder on the wrong side of the gate (`{decision:"yes",
    // dest:"ohmail/Quarantine"}`) is the second: coercing either way files mail under a consent
    // the user did not give, and which half to trust is a coin toss. MEMBERSHIP FIRST:
    // `effectForDestination("ohmail/Screener")` is `"deny"`, so the agreement check alone accepts
    // it for any `no`.
    // The past-mail answer — checked, never coerced, on `decision`'s reasoning one paragraph up:
    // this decides whether a whole backlog is re-filed, and `"false"` is truthy.
    if (b.applyRetro !== undefined && typeof b.applyRetro !== "boolean") {
      throw new ServiceError("validation_failed", 400, "applyRetro must be a boolean");
    }
    const applyRetro = b.applyRetro ?? true;
    // A pre-0.22 client's decision still names the News pile `ohmail/Reads` — the same pile.
    const destRaw = typeof b.dest === "string" ? canonicalDestination(b.dest) : b.dest;
    if (destRaw !== undefined) {
      if (typeof destRaw !== "string" || !DECIDABLE_FOLDERS.has(destRaw)) {
        throw new ServiceError(
          "validation_failed", 400,
          `dest must be one of ${[...DECIDABLE_FOLDERS].join(", ")}`,
        );
      }
      // `effectForDestination` and not a second hand-written table: it is exhaustive over
      // `Destination`, so a seventh folder is a compile error there until somebody decides
      // which side of the consent gate it is on.
      const admits = effectForDestination(destRaw as Destination) === "allow";
      if (admits !== (decision === "yes")) {
        throw new ServiceError(
          "validation_failed", 400,
          `dest '${destRaw}' does not belong to decision '${decision}'`,
        );
      }
    }
    // Validated as a member of the canonical set above, or absent.
    const dest = destRaw as Destination | undefined;
    // ONE INDEXED READ, NOT THE WHOLE QUEUE. This used to be `heldRows(ctx)` — every held
    // message, thousands of rows each carrying `subject` and `snippet`, pulled into a serverless
    // function before the decision did any work; a delay scaling with the backlog is
    // unpredictable by construction, and an action landing at an unpredictable time is
    // indistinguishable from one that failed. The lookup stays HELD-ONLY, so the 404 still means
    // "not in the Screener" — deciding on mail not at the gate would promote a rule for a sender
    // nobody was asked about. `@trafficflow/db#heldRowById`, the ONE implementation the drain
    // also reads through, and the one that carries `mailboxId`, which the role branch needs.
    const target = await heldRowById(asTx(ctx), ctx.accountId, id);
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

    return { scope, decision, dest, target, address, domain, appliedFolder, applyRetro };
  }

  /**
   * DECIDE — a decision is about the SENDER and applies ACCOUNT-WIDE (owner ruling, 0.20). The
   * roles are still asked PER MAILBOX, but the branch is the account's: `planAccountFanOut` splits
   * every live mailbox into organized-here / request-a-holder, and the write path runs whenever
   * ANYTHING is organized here — the representative message's own mailbox no longer decides,
   * because on a mixed account it is whichever mailbox got the sender's newest mail. Where this
   * install may not write, the decision travels the request road (`organizer_requests` →
   * `ohmail/_meta` → the holder's drain) and the response names both halves per mailbox.
   */
  async decide(
    ctx: ServiceContext, id: string, b: ScreenBody,
    opts: { idempotency?: ScreenIdempotency | null } = {},
  ): Promise<ScreenDecisionResult | ScreenRequestResult> {
    const v = await this.validateScreenerDecision(ctx, id, b);

    /* THE CAPABILITY THIS DOOR NEEDS, NAMED (mail 0094). A Screener decision is `screener.decide`,
       whose capability is `requests` — the spelling every organizer in the field already
       advertises, so nothing about this door's answer moves. It is passed through
       `capabilityForKind` rather than written as the constant so that the door and the record it
       writes can never disagree about which capability that kind requires. */
    const eligibility = await readRequestEligibility(
      asTx(ctx), ctx.accountId, v.target.mailboxId, capabilityForKind("screener.decide"),
    );
    if (!eligibility) throw new MailboxNotFoundError(v.target.mailboxId);
    // A TOMBSTONE IS NOT A READER. A removed mailbox keeps whatever `organizer_role` it had, so
    // it reads `capable: false` and would fall to the reader branch — which refuses with "another
    // install is organizing this mailbox", names whoever held it before the removal, and offers a
    // takeover of something that no longer exists. Every clause of that is false. Not-found is
    // what the row actually says.
    if (eligibility.status === "disabled") throw new MailboxNotFoundError(v.target.mailboxId);

    /**
     * THE ACCOUNT'S ROLES DECIDE THIS BRANCH — `capable` of the target MUST NOT APPEAR HERE.
     * `capable` answers a READER's question about the install HOLDING its mailbox; it says
     * nothing about whether THIS install may write to a mailbox it organizes, and reading it that
     * way puts a header an ATTACKER can write in front of the organizer's own press. The plan is
     * a PLAIN read, right for choosing a branch; every write below re-reads the role it needs
     * under a `FOR SHARE` lock (`applyScreenerDecision`, per mailbox). `planAccountFanOut` throws
     * `OrganizedElsewhereError` itself when nothing anywhere could take this decision.
     */
    const fanOut = await planAccountFanOut(asTx(ctx), ctx.accountId, "screener.decide");
    if (fanOut.organized.length > 0) {
      return this.applyAsOrganizer(ctx, id, v, fanOut, opts);
    }
    return this.requestAsReader(ctx, id, v, eligibility, fanOut, opts);
  }

  /**
   * THE ORGANIZER'S DIRECT WRITE — `decide`'s pre-0.14.1 transaction, its core moved to
   * `@trafficflow/db#applyScreenerDecision` (contacts, the screening baseline, the promoted
   * rule, the held-bag re-route guarded on `desired_folder = 'ohmail/Screener'`,
   * mark-read-on-decide, the learning signal) so the organizer's own door and its request drain
   * are ONE implementation. Everything that stays HERE is either HTTP-specific (the idempotency
   * claim-and-replay) or needs a dependency the drain does not have (the injected IMAP adapter,
   * the unsubscribe courtesy).
   */
  private async applyAsOrganizer(
    ctx: ServiceContext, id: string,
    v: {
      scope: "sender" | "domain"; decision: "yes" | "no"; address: string; domain: string;
      appliedFolder: Destination; target: AppliedScreenerRow; applyRetro: boolean;
    },
    fanOut: AccountFanOut,
    opts: { idempotency?: ScreenIdempotency | null },
  ): Promise<ScreenDecisionResult> {
    const { scope, decision, address, domain, appliedFolder, target, applyRetro } = v;
    let rerouted: AppliedScreenerRow[] = [];
    let filed: string[] = [];

    const result = await asTx(ctx).transaction(async (tx) => {
      // THE ERASURE FENCE FIRST — `applyScreenerDecision` takes `accounts FOR SHARE` first and
      // `deleteAccount` takes the same row first: this transaction must reach `accounts` before
      // `mailboxes` or the orders cross and deadlock. The single-mailbox role assert that stood
      // here moved INTO `applyScreenerDecision`, which now locks every held mailbox's role
      // `FOR SHARE` and writes only where it reads `organizer` — the same demotion interleaving
      // `assertOrganizerRole`'s header records, closed per mailbox instead of once.
      const erasedAt = await readAccountErasedAt(tx, dialect(ctx.db), ctx.accountId);
      if (erasedAt != null) {
        throw new ServiceError("account_erased", 410,
          "this account has been deleted; its settings cannot be changed");
      }

      let applied;
      try {
        applied = await applyScreenerDecision(carryDialect(ctx.db, tx) as typeof tx, {
          accountId: ctx.accountId, scope, address, appliedFolder, decision,
          triggeringActionId: `screener:${id}`, now: ctx.now(), applyRetro,
        });
      } catch (err) {
        // `applyScreenerDecision` fences the account itself, first — see its own header. Its
        // `AccountErasedError` is a db-layer type; the HTTP contract here has always been this
        // exact `ServiceError`, so it is translated rather than let escape as an unrecognised 500.
        if (err instanceof AccountErasedError) {
          throw new ServiceError("account_erased", 410,
            "this account has been deleted; its settings cannot be changed");
        }
        throw err;
      }
      rerouted = applied.rerouted;
      filed = [...new Set(applied.rerouted.map((m) => m.mailboxId))];

      /**
       * THE REQUEST HALF, IN THE SAME TRANSACTION (0.20): the decision travels to every capable
       * holder — mailboxes with held mail AND mailboxes with none, because the promoted rule is
       * account-wide and a holder that never hears of it screens this sender again tomorrow. The
       * plan's `requestTo` is a plain read, so a mailbox the plan called ours that the apply's
       * lock read as somebody's (demoted mid-flight) is re-asked here rather than silently
       * covered by nobody. The drain NEVER queues (see `applyScreenerDecision`'s result doc);
       * only this door does, which bounds the mesh at one hop.
       */
      const payload = {
        scope, address, appliedFolder, decision,
        match: scope === "domain" ? domain : address, applyRetro,
      };
      const holders = new Map<string, OrganizedBy>(
        fanOut.requestTo.map((t: FanOutTarget) => [t.mailboxId, t.holder]),
      );
      for (const h of applied.heldElsewhere) {
        if (holders.has(h.mailboxId)) continue;
        const e = await readRequestEligibility(
          tx, ctx.accountId, h.mailboxId, capabilityForKind("screener.decide"),
        );
        if (decisionCanBeApplied(e) && e!.role !== "organizer") holders.set(h.mailboxId, e!.by);
      }
      const requested: ScreenRequestedMailbox[] = [];
      for (const [mailboxId, holder] of holders) {
        const r = await writeReaderRequest(tx, ctx, {
          mailboxId, kind: "screener.decide", payload, holder, decidedAt: ctx.now(),
        });
        requested.push({ mailboxId, requestId: r.requestId, holder });
      }

      // NOTHING FILED AND NOTHING QUEUED while the sender's mail is held elsewhere: every
      // organized mailbox was demoted between the plan and the locks and no holder can take a
      // request. The old single-mailbox refusal, kept — the throw rolls the promoted rule back,
      // so a 409 never leaves dead configuration behind.
      if (filed.length === 0 && requested.length === 0 && applied.heldElsewhere.length > 0) {
        const h = applied.heldElsewhere[0]!;
        const e = await readRequestEligibility(
          tx, ctx.accountId, h.mailboxId, capabilityForKind("screener.decide"),
        );
        throw new OrganizedElsewhereError(
          h.mailboxId, e?.by ?? { kind: null, name: null, since: null },
          (e?.by.kind ?? null) === null ? "no_organizer" : "organizer_outdated",
        );
      }

      const dto: ScreenDecisionResult = {
        messageId: id, appliedFolder, createdRuleId: applied.createdRuleId,
        mailboxes: { filed, requested },
      };

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
          seq: Number(applied.lastSeq),
          now: ctx.now(),
        });
        // A LOST claim = a concurrent same-key request committed first. Throwing rolls THIS
        // transaction back (effect included) and the caller replays the winner's response.
        if (!claimed) throw new IdempotencyRaceLost(ctx.accountId, opts.idempotency.key);
      }

      return dto;
    });

    /**
     * RING THE WORKER'S DOORBELL FOR WHAT THIS VERDICT NOW OWES — OUTSIDE THE TX. A Screener
     * press waited for the ROTATION like any filing decision — the rail said "Filing 1 message…"
     * for minutes at the product's front door. OUTSIDE, because inside the tx
     * `applyScreenerDecision` holds row locks on `rules`, every rerouted `folder_state` and the
     * settings — a `mailboxes` lock at the end closed a cycle: real Postgres answered `40P01` for
     * two concurrent domain decisions on one mailbox; PGlite saw none of it. ONCE, not per
     * message; GUARDED ON `rerouted`, so a verdict that moved nothing wakes nobody; BEST-EFFORT —
     * the verdict has committed and the poll is the floor.
     */
    // ONE RING PER FILED MAILBOX — an account-wide verdict owes each mailbox its own
    // ask-the-organizer-sooner stamp, and `filed` is exactly the set that moved.
    for (const mailboxId of filed) {
      try {
        await ringFilingDoorbell(bridgeTx(ctx.db), mailboxId, ctx.now());
      } catch (err) {
        /* Swallowed for the caller, never for the log — `MessageService.ringFiledMailbox` carries
           the argument in full. The verdict has committed; a throw here costs one rotation and
           must still be visible, or a doorbell that threw and one that was never rung read the
           same from outside. */
        doorbellLog.warn("filing_doorbell_failed", {
          accountId: ctx.accountId,
          mailboxId,
          err,
          reason: "the Screener's verdict COMMITTED; only the ask-the-organizer-sooner stamp "
            + "failed, so the reroute lands on the next rotation instead of within seconds",
        });
      }
    }

    // ── Physical IMAP move via the reconciler write-path, OUTSIDE the tx (step 3, idempotent) ──
    // Only when an adapter is injected. The serverless API path has none — the
    // folder_state row is left `pending` and the always-on worker drains it later.
    if (this.deps.adapter) {
      const adapter = this.deps.adapter;
      const repo = makeDrizzleRepo(bridgeTx(ctx.db));
      // `rerouted`, never `heldMail`: a row the guard skipped belongs to whoever wrote it, and
      // moving it on IMAP would make the mailbox disagree with the database that declined to
      // claim it — the one place a stale read could still reach the user's server. A STALE SOURCE
      // LOCATOR DOES NOT END THIS LOOP, and the verdict does not become an error: the transaction
      // has committed the decision AND `desired_folder` with `reconcile_status: 'pending'`, so
      // the physical move is owed by the organizer whether or not this opportunistic pass lands
      // it. Until `applyReconcileAction` learned to defer, one recycled folder threw and the
      // reader saw a 500 for a decision that had committed and was converging.
      for (const m of rerouted) {
        // TARGET MAILBOX ONLY: the injected adapter dials the ONE mailbox this door was opened
        // for. Another mailbox's rows keep `reconcile_status: 'pending'` and the install that
        // organizes THAT mailbox moves them on its own rotation — the pre-account-wide behaviour,
        // per mailbox.
        if (m.mailboxId !== target.mailboxId) continue;
        await applyReconcileAction(
          { repo, adapter, accountId: ctx.accountId, mailboxId: "" },
          { messageId: m.messageId, locator: m.nativeLocator as NativeLocator, state: { desiredFolder: appliedFolder, observedFolder: m.observedFolder, lastSetBy: "us" } },
          { type: "move", to: appliedFolder },
        );
      }
    }

    // AFTER the tx has committed, never inside, and only on a REJECT; `onScreenOut` never throws
    // — a sender who cannot be unsubscribed is still screened out. THE TRIGGER IS THE CONSENT,
    // NOT THE FOLDER: this read `appliedFolder === NO_FOLDER`, which `dest: "ohmail/Quarantine"`
    // would have made quietly false for every SPAM press. `unsubscribe-service.ts` names its
    // actionable set as `ohmail/Screened` and `ohmail/Quarantine` — the user said no — so
    // `decision === "no"` is the same senders and the sentence that file is written against. The
    // narrowing is still done twice: `onScreenOut` filters to those two folders itself.
    // `rerouted`, not `heldMail`: a row this decision did not claim may not be unsubscribed for.
    // NOT performed on the drain's apply of a reader's request — see `applyScreenerDecision`'s
    // header.
    if (this.deps.unsubscribe && decision === "no") {
      const targets = rerouted.map((m) => m.messageId);
      // The sweep is REPORTED now rather than discarded. It used to be awaited and thrown away,
      // which was honest only while the fan-out ran every target: under a per-request ceiling the
      // caller would otherwise be told a decision was applied with no way to know that the
      // courtesy it started is still running somewhere. `considered` is what this request
      // actually looked at; the rest are the drain's.
      const sweep = await this.deps.unsubscribe.onScreenOut(ctx, targets);
      if (targets.length > 0) {
        result.unsubscribed = { done: sweep.considered, of: targets.length };
      }
    }

    return result;
  }

  /**
   * THE READER'S DECISION — a REQUEST, waiting for the organizer to apply it. Offered only while
   * `eligibility.capable` — the holder's claim advertises `CAPABILITY_REQUESTS` AND
   * `organizer_state = 'held'`; otherwise `409 organized_elsewhere`, naming which of the two is
   * missing so the client renders the right sentence and the claim CTA — never a silent queue
   * nobody drains. `match` — `address` for a sender-scope decision, `domain` for domain — is what
   * `listOutstandingForAccount` keys the list's exclusion on and what the drain's validator
   * re-checks before applying: the payload is untrusted the instant it leaves this process,
   * travelling through an RFC822 header another install wrote.
   */
  private async requestAsReader(
    ctx: ServiceContext, id: string,
    v: {
      scope: "sender" | "domain"; decision: "yes" | "no"; address: string; domain: string;
      appliedFolder: Destination; target: AppliedScreenerRow; applyRetro: boolean;
    },
    eligibility: RequestEligibility,
    fanOut: AccountFanOut,
    opts: { idempotency?: ScreenIdempotency | null },
  ): Promise<ScreenRequestResult> {
    if (!eligibility.capable) {
      throw new OrganizedElsewhereError(
        v.target.mailboxId, eligibility.by,
        eligibility.by.kind === null ? "no_organizer" : "organizer_outdated",
      );
    }

    const { scope, decision, address, domain, appliedFolder, applyRetro } = v;
    const requestId = randomUUID();
    const match = scope === "domain" ? domain : address;
    const decidedAt = ctx.now();

    const dto: ScreenRequestResult = {
      pending: true,
      requestId,
      holder: eligibility.by,
    };

    try {
      await asTx(ctx).transaction(async (tx) => {
        /* THE ERASURE FENCE AND THE INSERT NOW BELONG TO `reader-request.ts` (mail 0094).
         *
         * They were written here first, for the one kind that existed in 0.14.1. The three new
         * families need the identical sequence, and four copies of "fence the account, then write
         * the row" is how one of them ends up without the fence — so the sequence moved to the one
         * helper every door calls and this door became its first caller rather than its only
         * implementation. What is still HERE is what is genuinely the Screener's: the payload's
         * shape, and the idempotency claim below.
         */
        await writeReaderRequest(tx, ctx, {
          mailboxId: v.target.mailboxId,
          kind: "screener.decide",
          // Exactly what the drain needs to call `applyScreenerDecision` again, unchanged — see
          // that function's `ApplyScreenerDecisionInput`. `match` rides along for
          // `listOutstandingForAccount`'s own read; the drain does not use it.
          payload: { scope, address, appliedFolder, decision, match, applyRetro },
          holder: eligibility.by,
          requestId,
          decidedAt,
        });

        // EVERY OTHER CAPABLE HOLDER GETS THE SAME REQUEST (0.20): the decision is about the
        // sender, account-wide, and each holder's drain files its own mailbox's bag and learns
        // the promoted rule. The primary `requestId`/`holder` above stay the target's, so a
        // client written against the 0.14.1 shape reads exactly what it always did.
        const requested: ScreenRequestedMailbox[] = [
          { mailboxId: v.target.mailboxId, requestId, holder: eligibility.by },
        ];
        for (const t of fanOut.requestTo) {
          if (t.mailboxId === v.target.mailboxId) continue;
          const r = await writeReaderRequest(tx, ctx, {
            mailboxId: t.mailboxId, kind: "screener.decide",
            payload: { scope, address, appliedFolder, decision, match, applyRetro },
            holder: t.holder, decidedAt,
          });
          requested.push({ mailboxId: t.mailboxId, requestId: r.requestId, holder: t.holder });
        }
        // Set BEFORE the idempotency claim below stores `dto` verbatim — a replay must carry the
        // same per-mailbox answer the live call did.
        dto.mailboxes = { filed: [], requested };

        // Same replay contract as the organizer's own door — a lost response must not queue a
        // second request for the same press.
        if (opts.idempotency) {
          const claimed = await claimIdempotencyKey(tx, {
            accountId: ctx.accountId,
            key: opts.idempotency.key,
            requestHash: opts.idempotency.requestHash,
            responseStatus: 202,
            responseJson: dto,
            seq: null,
            now: ctx.now(),
          });
          if (!claimed) throw new IdempotencyRaceLost(ctx.accountId, opts.idempotency.key);
        }
      });
    } catch (err) {
      // Same translation as `applyAsOrganizer`'s own catch, and for the same reason: a db-layer
      // type must not escape as an unrecognised 500.
      if (err instanceof AccountErasedError) {
        throw new ServiceError("account_erased", 410,
          "this account has been deleted; its settings cannot be changed");
      }
      throw err;
    }

    return dto;
  }

  /**
   * ONE HELD MESSAGE PER SENDER, AS A WINDOW — the subquery both the page and the purchase read,
   * which is what makes them name the same message rather than merely agree about it.
   *
   * `row_number() over (partition by k order by o) = 1` rather than `distinct on`: the second
   * exists only on the server, and the representative must be chosen the same way on both stores.
   * The ordering lives INSIDE the window — a leading `k` in an outer ORDER BY satisfies the
   * clause, not the answer. `extra` narrows which senders are considered and cannot change WHICH
   * row represents one: the partition is per sender, so a subset leaves every partition intact.
   */
  // `account_id` LEADS the predicate rather than filtering a cross-account result (no cross-account disclosure).
  // The return type is INFERRED: the subquery's row type is what makes `reps.fromAddress` and
  // `reps.rank` typed at the two call sites, and any annotation wide enough to write by hand
  // erases it to `{ [x: string]: any }`.
  protected heldSenderReps(ctx: ServiceContext, extra?: SQL) {
    const d = dialect(ctx.db);
    // THE EPOCH THROUGH THE SEAM: `to_timestamp(0)` is the server's name for it and the device
    // store has no such function — there the instant IS the number, which is what `d.ts` knows.
    const sortKey = d.truncMs(sql`coalesce(${messages.date}, ${d.ts(EPOCH)})`) as SQL<Date>;
    const sender = sql`lower(${messages.fromAddress})`;
    const filters: SQL[] = [
      eq(messages.accountId, ctx.accountId),
      eq(folderState.desiredFolder, SCREENER_FOLDER),
      // Mail 0065: a held message whose every watched copy was expunged is tombstoned by the
      // reaper, applied where the representative is CHOSEN — a tombstoned newest message must not
      // stand in for a sender whose older mail is live.
      isNull(messages.deletedAt),
    ];
    if (extra) filters.push(extra);
    // scoped-by: `filters` above leads with eq(messages.accountId, ctx.accountId)
    const reps = ctx.db.select({
      ...HELD_COLUMNS,
      sortKey: sortKey.as("sort_key"),
      rank: sql<number>`row_number() over (
        partition by ${sender} order by ${sortKey} desc, ${messages.id} desc
      )`.as("rank"),
    }).from(messages)
      .innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(...filters))
      .as("reps");
    return { reps, sortKey, d };
  }

  /**
   * ONE PAGE of the queue: representative per sender, ordered, keyset-filtered and LIMITed — BY
   * POSTGRES, replacing four jobs in JavaScript over thousands of rows per scroll. THE KEYSET IS
   * APPLIED AFTER THE `DISTINCT ON`: pushed inside, it filters BEFORE the representative is
   * chosen, and a sender with an older held message below the cursor is LISTED TWICE. A keyset,
   * not `OFFSET`: the held set mutates under the reader, and a skip is a first-contact sender
   * never asked about. The sort key is TRUNCATED TO MILLISECONDS — the cursor round-trips through
   * `getTime()`; ties break on `id`. `coalesce(…, epoch)`, not `DESC NULLS LAST`: NULLs sort
   * FIRST under `DESC`, and omitting `Date:` must not take the top of the consent queue.
   */
  protected async heldSenderPage(
    ctx: ServiceContext,
    opts: {
      after: { time: number; messageId: string } | null;
      limit: number;
      /**
       * THE CUTLINE, resolved once for the page. Absent ⇒ no cutline ⇒ byte-identical to the
       * query before it existed, which is what every caller that reads no `account_settings`
       * gets. See below for why it sits in the OUTER query.
       */
      cutline?: ResolvedCutline;
    },
  ): Promise<ScreenerRow[]> {
    const { reps, sortKey, d } = this.heldSenderReps(ctx);

    /* ── THE CUTLINE, WITH THE RANK AND BEFORE THE LIMIT ────────────────────────────────────
     *
     * A retired sender must not occupy a row of the page, so it is a WHERE and not a filter over
     * the result. Out here beside the rank rather than inside the window: the test is about the
     * SENDER, so it is invariant across their held rows and cannot change which message
     * represents them, and the correlated read then runs once per representative rather than once
     * per held message. `senderIsActiveSql` is the SAME expression `cutlineCounts` counts
     * through — that is what makes this list and the count beside it one rule rather than two
     * that happen to agree.
     */
    const active = opts.cutline
      ? senderIsActiveSql(d, ctx.accountId, sql`lower(${reps.fromAddress})`, opts.cutline)
      : undefined;
    /* A SENDER THIS ACCOUNT ALREADY KNOWS IS NOT A FIRST-TIME SENDER. Beside the cutline and not
       folded into it: the cutline asks whether a sender is worth ASKING about, this asks whether
       they were already ANSWERED. UNCONDITIONAL, unlike `active` — the cutline is a SETTING a
       caller may not have read, and this is not. Their held mail is not hidden by it: the
       held-releases surface and the gate-release pass both reach the rows this excludes. */
    // scoped-by: `reps` is the account-scoped messages subquery defined above (eq messages.accountId, ctx.accountId)
    const rows = await ctx.db.select().from(reps)
      .where(and(
        eq(reps.rank, 1),
        active,
        sql`not ${senderIsDecidedSql(d, ctx.accountId, sql`lower(${reps.fromAddress})`)}`,
        // The account is not one of its own correspondents: its mail at the gate is no decision.
        sql`not ${senderIsOwnSql(d, ctx.accountId, sql`lower(${reps.fromAddress})`)}`,
        opts.after
          // Row comparison, which is the `date desc, id desc` keyset written as one expression:
          // strictly "older" than the cursor tuple, with the id breaking a shared date. Bound
          // through the seam so the comparison is the STORE's ordering of its own timestamp and id
          // types, not a string comparison that happens to agree with it.
          ? sql`(${reps.sortKey}, ${reps.messageId}) < (${d.ts(new Date(opts.after.time))}, ${d.castUuid(opts.after.messageId)})`
          : undefined,
      ))
      .orderBy(desc(reps.sortKey), desc(reps.messageId))
      .limit(opts.limit);

    return rows.map(toScreenerRow);
  }

  /**
   * `heldRowById` / `heldRowsForSender` / `heldRowsForDomain` USED TO LIVE HERE, and now live in
   * `@trafficflow/db#screener-apply.ts` — see that module's own header (0.14.1):
   * `decide`'s validate step and `applyScreenerDecision`'s own internals both read through them,
   * and the organizer's request drain (`apps/worker/src/request-drain.ts`) needs the identical
   * queries without importing this package. `decide` was their only caller in this class; moving
   * them left nothing behind to keep.
   */

  /**
   * THE STORED SUGGESTIONS FOR A SET OF SENDERS — what `list` draws. Two reads, two questions,
   * and the difference is the money: this asks "does this account hold advice ABOUT THIS SENDER";
   * `storedSuggestions` asks "has THIS MESSAGE been advised on". One read doing both was wrong
   * for the display: one more message from a sender hid advice already bought, and every
   * unpressed buyer reading "senders with no answer" bought it again. The per-message read stays
   * right in `suggest`, where "Suggest again" is a purchase. The query lives in `@trafficflow/db`
   * (`screenerSuggestionsBySender`) — the worker's pass needs the same identity. `senders` must
   * already be lower-cased: raw addresses get misses, not a silent mismatch.
   */
  protected async senderSuggestions(
    ctx: ServiceContext, senders: string[], ohboxPolicy: OhboxPolicy,
  ): Promise<Map<string, ScreenerItem["aiSuggestion"]>> {
    const out = new Map<string, ScreenerItem["aiSuggestion"]>();
    const rows = await screenerSuggestionsBySender(asTx(ctx), ctx.accountId, senders);
    for (const [sender, r] of rows) {
      out.set(sender, {
        ...suggestionAdvice(r.destination, r.spam, r.rationale ?? "", ohboxPolicy),
        confidence: r.confidence ?? 0,
        rationale: r.rationale ?? "",
      });
    }
    return out;
  }

  /**
   * The STORED suggestions for a set of MESSAGES — the purchase path's "already bought" read. One
   * query for the set, none for an empty one; the newest row wins per message (see
   * `SUGGESTION_PROVENANCE` for why there can be more than one). `account_id` is in the WHERE
   * even though the ids are this account's: the account leads every key, never a filter over a
   * cross-account result. PER MESSAGE ON PURPOSE — `senderSuggestions` is the other question;
   * every caller here is inside a purchase a person pressed for, where "already bought" has to
   * mean the mail the model would read.
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
  private readonly credits?: SpendPort;
  /** The access half for the refusal cross-check. See {@link ScreenerSuggestDeps.access}. */
  private readonly access?: AccessPort;
  /** The balance READ. Destructured out for the same reason as the two above. */
  private readonly remaining?: (db: Tx, accountId: string) => Promise<number>;
  /** This host's own invocation ceiling, or absent. See {@link ScreenerSuggestDeps}. */
  private readonly invocationBudgetMs?: number;
  /** The price question. See {@link ScreenerSuggestDeps.pricing}. */
  private readonly pricing: ActionPricing;

  constructor(deps: ScreenerSuggestDeps) {
    const { classifier, credits, access, remaining, invocationBudgetMs, pricing, ...readOnly } = deps;
    super(readOnly);
    this.classifier = classifier;
    this.credits = credits;
    this.access = access;
    this.remaining = remaining;
    this.invocationBudgetMs = invocationBudgetMs;
    this.pricing = pricing ?? UNPRICED;
  }

  /**
   * Buy suggestions for an EXPLICIT set of senders. A missing, empty or all-blank set is a 400,
   * never "all" — a four-figure spend one malformed body away. AI-OPEN: every held sender is
   * suggestable; the old sensitivity skip is gone — a person chose senders, saw a price, pressed
   * the button. REDACTION protects the credential (`redactForModel`); the automatic routing path
   * still refuses. FOUR LAYERS against paying twice: stored suggestion served; `Idempotency-Key`;
   * the ledger identity `classify:screener:<message_id>`; the EXCLUSIVE CLAIM — the only layer
   * that sees a caller not yet finished. Each verdict lands in its OWN small transaction — a
   * death mid-run loses only unwritten results.
   */
  async suggest(
    ctx: ServiceContext,
    body: ScreenerSuggestBody,
    opts: { idempotency?: ScreenIdempotency | null } = {},
  ): Promise<ScreenerSuggestResult> {
    /* THE INVOCATION'S CLOCK STARTS HERE — the first statement of the method, before the
       preference read, the held-rows query and the stored-suggestion snapshot. Anchoring it after
       those makes the window longer than the invocation allows by exactly however long they took,
       which is the shape the review found. See {@link SUGGEST_ADMISSION_WINDOW_MS}. */
    const laneDeadline = admissionDeadline(this.invocationBudgetMs);
    const senders = parseSenderSet(body);
    const dryRun = body?.dryRun === true;
    /* Read here, beside `dryRun`, so a malformed ceiling refuses before any read or spend. */
    const ceiling = parseConfirmedCeiling(body);
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

    /* THE PRICE OF ONE SUGGESTION, asked once, before anything is read or spent. A host with no
       gate charges nothing, so it quotes 0. A metered host asks the program's card; with no card
       the dry run answers without a quote and a purchase is refused here, before the gate — the
       program would charge its own price, and nobody consented to a figure nobody stated. */
    const price = this.credits ? await this.pricing.priceOf(ctx.accountId, "screener") : 0;
    if (price === null && !dryRun) {
      await refuseAiSpend({ refusal: "fault", verdict: "unpriced" }, {
        event: "screener_suggest_refused",
        accountId: ctx.accountId,
        unavailable: "AI suggestions are temporarily unavailable; please retry",
      });
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

    /**
     * A READER BUYS SUGGESTIONS TOO — BUT ONLY WHERE THE ANSWER COULD BE ACTED ON. This used to
     * refuse a reader outright: `decide` refused a reader one door over, so the purchase bought
     * nothing. `decide` now turns a reader's decision into a REQUEST, so the blanket refusal is
     * wrong — but the reasoning survives: it holds only while some organizer will take the
     * request. A reader whose holder is an older build (or whose mailbox has no holder) gets `409
     * organizer_outdated` from `decide` — money spent, first-contact subjects sent to a model,
     * advice that cannot be applied. The gate is "could a decision here ever land", asked PER
     * MAILBOX — the same question `decide` asks, through the same function.
     */

    /**
     * ONE ROW PER NAMED SENDER, CHOSEN BY POSTGRES — the window {@link heldSenderReps} holds.
     *
     * AND IT IS BOUNDED, which it was not: this read used to take the whole held bag for up to
     * {@link MAX_SUGGEST_SENDERS} senders, every row carrying its `subject` and `snippet`, to
     * pick one per sender in JavaScript. At most one row per named sender comes back now — a
     * bound by construction, not a limit somebody has to remember to raise.
     */
    const { reps } = this.heldSenderReps(
      ctx, inArray(sql`lower(${messages.fromAddress})`, senders),
    );
    // scoped-by: `heldSenderReps` leads its predicate with eq(messages.accountId, ctx.accountId)
    const rows = (await ctx.db.select().from(reps).where(eq(reps.rank, 1))).map(toScreenerRow);
    const rep = new Map<string, ScreenerRow>(
      rows.map((r) => [r.fromAddress.toLowerCase(), r]),
    );

    /**
     * THE ELIGIBILITY GATE, BEFORE A SINGLE MODEL CALL. One read per DISTINCT mailbox in the set,
     * not per sender: forty senders in one mailbox ask once. Senders whose mailbox could never
     * have the decision applied are dropped from the purchase, not answered and billed. REFUSED,
     * not silently emptied, when nothing survives: a 200 with no suggestions is what "the model
     * had nothing to say" looks like, and "your other install is too old" is a different sentence
     * naming something fixable — the same refusal `decide` gives, so the two doors cannot
     * disagree.
     */
    const eligibilityByMailbox = new Map<string, RequestEligibility | null>();
    for (const mailboxId of new Set([...rep.values()].map((r) => r.mailboxId))) {
      eligibilityByMailbox.set(
        mailboxId, await readRequestEligibility(
          asTx(ctx), ctx.accountId, mailboxId, capabilityForKind("screener.decide"),
        ),
      );
    }
    /**
     * WHETHER THERE WAS ANYTHING TO GATE, captured BEFORE the filter runs.
     *
     * `rep` is already empty when none of the named senders is still held — a stale Screener page,
     * a sender the worker's own pass screened out a moment ago, another tab. That is an ordinary
     * 200 with nothing to buy, and it has nothing to do with who organizes the mailbox. Reading
     * the post-filter emptiness alone turned it into `409 organized_elsewhere` naming an EMPTY
     * mailbox id and a holder of `null` — every clause false, on a request that used to succeed.
     */
    const hadCandidates = rep.size > 0;
    /**
     * THE FIRST INELIGIBLE MAILBOX, AND ITS OWN ELIGIBILITY, AS ONE VALUE. These were two
     * variables latched by two `??=` — which do NOT latch together: `null` is a legitimate
     * eligibility (no row at all), so the id latched on the first ineligible mailbox while the
     * eligibility stayed null and latched on a LATER one; the sentence reaching the person named
     * one mailbox's id beside a different mailbox's holder. One object, latched once, makes "both
     * halves come from the same mailbox" true by construction — the object is always truthy, so
     * `??=` captures exactly the first.
     */
    let ineligibleAt: { mailboxId: string; eligibility: RequestEligibility | null } | null = null;
    for (const [sender, row] of [...rep.entries()]) {
      const e = eligibilityByMailbox.get(row.mailboxId) ?? null;
      // THE ONE PREDICATE, and the reason it is a call: the worker's automatic pass spends on the
      // same question, and the day this was three clauses here it was zero clauses there.
      if (decisionCanBeApplied(e)) continue;
      ineligibleAt ??= { mailboxId: row.mailboxId, eligibility: e };
      rep.delete(sender);
    }
    if (hadCandidates && rep.size === 0) {
      const ineligible = ineligibleAt?.eligibility ?? null;
      throw new OrganizedElsewhereError(
        ineligibleAt?.mailboxId ?? "",
        ineligible?.by ?? { kind: null, name: null, since: null },
        // `?? null` first: `ineligible?.by.kind` short-circuits to UNDEFINED when the eligibility
        // read itself returned null, and `undefined === null` is false — so the `no_organizer` arm
        // was unreachable in exactly the case it names.
        (ineligible?.by.kind ?? null) === null ? "no_organizer" : "organizer_outdated",
      );
    }

    // What is already bought. Read ONCE for the set, and the reason it is read at all is that a
    // `duplicate` costs the user nothing and costs US a model call.
    const stored = await this.storedSuggestions(ctx, [...rep.values()].map((r) => r.messageId), ohboxPolicy);

    // NOT a factory over the request's handle any more: the port holds its own, deliberately, so
    // a money answer is never taken inside somebody else's transaction. See the local adapter.
    const gate = this.credits;
    /**
     * THE WHOLE REQUEST'S patience for senders another caller is already buying — a deadline, not
     * a per-sender allowance. Per-sender multiplies: forty senders held by the worker's pass
     * would wait forty × the budget and time the invocation out — killed by its own politeness.
     * One deadline means the first overlap waits and the rest answer immediately; if the holder
     * is slower than this, it is slower for every sender. `Date.now()`, NOT `ctx.now()`: this
     * measures elapsed real time against `setTimeout`, and a test clock frozen at a literal would
     * put the deadline in the past and switch the wait off silently — the gate's docs record the
     * same trap for `retryWindowMs`.
     */
    const waitUntil = Date.now() + INFLIGHT_WAIT_MS;
    const suggestions: ScreenerSuggestion[] = [];
    const skipped: ScreenerSuggestResult["skipped"] = [];
    let quoted = 0;
    let charged = 0;
    let stopped: ScreenerSuggestResult["stopped"];
    /** WHY the gate refused, kept undiminished for the status decision below the loop. */
    let refusal: GateRefusal | undefined;

    /**
     * TWO PASSES; THE SPLIT MAKES THE SECOND SAFE TO RUN CONCURRENTLY. PASS 1 resolves everything
     * and touches nothing — representatives, already-bought, `quoted`; no IO, so a DRY RUN
     * answers from it alone. PASS 2 is the paid work, concurrent because: the balance cannot be
     * overspent (`spend` takes `FOR UPDATE` on the balance row); the claim is per SOURCE and one
     * request's sources are distinct; no lane holds a transaction across a model call; an
     * exhausted balance refuses each remaining `spend` without one. ORDER-INDEPENDENT: results
     * land in position-indexed slots, flattened in `senders` order; `stopped`/`refusal` take the
     * LOWEST INDEX.
     */
    interface Purchase { index: number; sender: string; row: ScreenerRow }
    const answered: Array<ScreenerSuggestion | undefined> = senders.map(() => undefined);
    const refused: Array<ScreenerSuggestResult["skipped"][number] | undefined> = senders.map(() => undefined);
    const stops: Array<ScreenerSuggestResult["stopped"] | undefined> = senders.map(() => undefined);
    const refusals: Array<GateRefusal | undefined> = senders.map(() => undefined);
    const purchases: Purchase[] = [];
    // The same check the always-on pass runs, over the senders THIS press named — the pressed
    // path asks the same question about the same mail, so withholding the facts here would leave
    // the defect standing on the path a person pays for.
    const checked = senderSignalsByMessage([...rep.values()]);
    await markCorrespondents(ctx, [...rep.values()], checked);

    // ── PASS 1 — RESOLUTION ONLY ────────────────────────────────────────────────────────────
    senders.forEach((sender, index) => {
      const r = rep.get(sender);
      if (!r) { refused[index] = { sender, reason: "not_held" }; return; }
      // THERE IS NO SENSITIVITY GATE HERE ANY MORE — THAT IS THE FEATURE. This line read `if
      // (!r.aiEligible) { skipped … "withheld" }` and was the whole of the withholding on the
      // user-requested path; it is gone under AI-OPEN and nothing replaces it: every held sender
      // named is priced, charged and asked about, the credential handled by REDACTING at the sink
      // (`classifyUserPayload(input, "redact")`), the same transform that produced the stored
      // snippet. Removing it in isolation would have been a billing defect: `gate.spend()` is
      // below, and the sink used to THROW for these rows — a withheld sender would pay a credit
      // for "the model did not answer". The sink's `"redact"` policy is what makes the removal
      // safe, not the other way round.

      // ALREADY BOUGHT — answer from the store. Not `quoted`, because a control must not price
      // what it will not be charged for, and not `skipped`, because the caller asked a question
      // this has the answer to.
      const already = stored.get(r.messageId);
      if (already) {
        // THROUGH THE CHECK LIKE EVERY OTHER ANSWER. A verdict served from the store is still an
        // answer this request hands back, so it carries the reason for the same cap the write
        // path applied — otherwise pressing Suggest on an already-advised sender would REPLACE
        // the sentence on their row with silence, which is the surface losing a fact it had.
        answered[index] = {
          sender, messageId: r.messageId,
          ...withSenderCheck(already, checked.get(r.messageId), ohboxPolicy)!,
        };
        return;
      }
      /**
       * THE QUOTE IS THE CEILING — the first of two bounds, and the lower one is
       * {@link MAX_SUGGEST_SENDERS}, which caps the set before this loop sees it.
       *
       * Checked BEFORE `quoted++`, so the number this request reports is the number it will
       * actually buy: a sender past the ceiling is not priced, not charged and not asked about.
       * It happens when a stored suggestion lapsed between the quote and the press, which makes
       * the same set cost more the second time — and a run that costs more than the figure
       * somebody pressed is the overstatement this whole surface exists to avoid.
       */
      if (ceiling !== null && price !== null && (quoted + 1) * price > ceiling) {
        refused[index] = { sender, reason: "over_quote" };
        stops[index] = "over_quote";
        return;
      }
      quoted++;

      // THE PRICE CHECK STOPS HERE — above the gate, so a quote cannot debit, and above the
      // model, so a quote cannot send mail to a third party. `quoted` is the whole answer.
      if (dryRun) return;
      purchases.push({ index, sender, row: r });
    });

    /** One sender's purchase, end to end. Everything below used to be the body of the loop. */
    const buy = async ({ index, sender, row: r }: Purchase): Promise<void> => {
      /**
       * THE LANE SLOT IS TAKEN BEFORE THE MONEY — THAT ORDER IS THE WHOLE OF ITS SAFETY. The
       * first version took the slot around the MODEL CALL, after `gate.spend()`: a multiplexing
       * host's FIFO can hold a lane past the invocation deadline, and a killed request has no
       * response, no `finally`, no idempotency row — a charged, claimed sender nobody is ever
       * shown. Charging for a queue position is the defect; charging only for admitted work is
       * the fix. A slot the budget could not buy is an ordinary per-sender REFUSAL
       * (`spend_unavailable`) that spent nothing; `refusal: "fault"` so a run producing nothing
       * answers 503, not a demand for money.
       */
      if (!(await laneGate.acquire(laneDeadline))) {
        refused[index] = { sender, reason: "spend_unavailable" };
        stops[index] = "spend_unavailable";
        refusals[index] = { refusal: "fault", verdict: "no_slot" };
        return;
      }
      try {
        await buyAdmitted({ index, sender, row: r });
      } finally {
        laneGate.release();
      }
    };

    /** The purchase itself, inside a lane slot. */
    const buyAdmitted = async ({ index, sender, row: r }: Purchase): Promise<void> => {
      // The BARE key: the MESSAGE, which is what makes a re-ask of the same held mail free and
      // what makes the cron and this press claim the same work. The source is composed by
      // whoever answers.
      const attemptKey = screenerAttemptKey(r.messageId);
      /**
       * WHAT A RELEASE MUST NAME, AND THE REFUND FLAG. Set when this lane charged; cleared once
       * the work is delivered or a model fault leaves the charge standing to buy a free retry.
       * Still set at the door means the lane charged and delivered nothing — the store faulted —
       * so the one release reverses it.
       */
      let chargedAttempt: string | null = null;
      /** Set only where the gate hands this lane the claim; `inflight` names another holder. */
      let claimed = false;
      let released = false;
      /** Give the claim back ONCE — `released` set before the await, so a fault is not retried. */
      const releaseClaim = async (): Promise<void> => {
        if (!gate || !claimed || released) return;
        released = true;
        const meta = { messageId: r.messageId };
        await gate.release(ctx.accountId, chargedAttempt === null
          ? { action: "screener", attemptKey, refund: false, meta }
          : { action: "screener", attemptKey, refund: true, attempt: chargedAttempt, meta });
      };
      try {
        if (gate) {
          const outcome = await gate.spend(
            ctx.accountId, "screener", attemptKey, { messageId: r.messageId });

          // SOMEBODY ELSE IS BUYING THIS ONE RIGHT NOW — the FOURTH layer, the only one that can
          // see a caller not yet finished. The three above describe work already OVER (a stored
          // suggestion, a claimed key, a committed ledger row), and an overlapping request passes
          // all of them; the ledger even answers `duplicate` — "already paid for, proceed" — which
          // is how N simultaneous requests made N paid calls against ONE credit. The holder is the
          // user's other tab or the worker's auto-suggest pass (the cron and a press select the
          // same held sender by construction). SO IT WAITS for the answer rather than reporting a
          // failure: a verdict is arriving within seconds, and a skip makes a correct system look
          // broken. Bounded, per-REQUEST budget — a large set held elsewhere degrades to one wait,
          // and lanes overlap several waits inside it.
          if (outcome.verdict === "inflight") {
            const settled = await this.awaitHeldSuggestion(ctx, r.messageId, ohboxPolicy, waitUntil);
            if (settled) {
              // Charged NOTHING and asked NOTHING, and the sender is answered. `quoted` stays as it
              // was: this request priced the sender honestly and then did not have to pay.
              answered[index] = {
                sender, messageId: r.messageId,
                ...withSenderCheck(settled, checked.get(r.messageId), ohboxPolicy)!,
              };
              return;
            }
            // The holder is slower than the budget, or died mid-call and its claim has not expired
            // yet. Both are temporary and both are cleared by asking again, which is what
            // `spend_unavailable` already tells a client — so no new wire value is minted for a
            // state whose whole content is "retry". It is NOT `out_of_credits`: this account is
            // fully funded, and a 402 here would be a bill for somebody else's concurrency.
            refused[index] = { sender, reason: "spend_unavailable" };
            stops[index] = "spend_unavailable";
            // `fault`, so a run that produced nothing at all answers 503 "temporarily unavailable;
            // please retry" rather than 402. Refusing to demand money for this is the point.
            refusals[index] = { refusal: "fault", verdict: "inflight" };
            return;
          }

          if (outcome.verdict !== "ok" && outcome.verdict !== "duplicate") {
            const reason = outcome.verdict === "insufficient" ? "out_of_credits" : "spend_unavailable";
            refused[index] = { sender, reason };
            stops[index] = reason;
            // The wire words the client already reads, from the port's own verdict: `quantity` for
            // an empty balance, `state` for a subscription (or the account's switch) that may not
            // spend, `fault` for "we do not know" — which is never a payment demand.
            refusals[index] = outcome.verdict === "fault"
              ? { refusal: "fault", verdict: outcome.verdict }
              : {
                  refusal: outcome.verdict === "insufficient" ? "quantity" : "state",
                  verdict: outcome.verdict,
                  reason: outcome.reason,
                };
            return;
          }
          // THE CLAIM IS THIS LANE'S FROM HERE: `ok` and `duplicate` are the two verdicts that hand
          // it over, and the door below gives back nothing without this line.
          claimed = true;
          // `charged: false` is a free retry of an attempt already on record — a `duplicate`;
          // reporting it as spend would say the user paid twice. `+= price`, not `++`: the field is
          // CREDITS, and the price is the program's own card, the figure it debits. A purchase never
          // reaches here unpriced (refused above), so `?? 0` only satisfies the type. A plain `+=`
          // across lanes is sound: JavaScript runs one lane at a time between `await`s.
          if (outcome.verdict === "ok") {
            charged += price ?? 0;
            chargedAttempt = outcome.attempt;
          }

          // A FREE RETRY LOOKS FOR THE RESULT IT IS A RETRY OF, BEFORE RE-BUYING TOKENS. `charged:
          // false` means the gate found the work already paid for; taking that as leave to call the
          // model was the LAST way N requests could buy one credit's work N times — through the
          // preflight SNAPSHOT, read once before the passes: a racer that stored its verdict after
          // that read leaves the next caller seeing nothing, told `duplicate`, buying the same
          // tokens again (measured on two racers over five senders). So the check is re-made HERE,
          // inside the exclusive region, where every earlier commit is visible — layer 1 asked at
          // the only authoritative moment. NOT run when `charged` is true: a new attempt purchases
          // a FRESH verdict; serving the old row takes the money and hands back what the customer
          // already had.
          if (outcome.verdict === "duplicate") {
            const settled = (await this.storedSuggestions(ctx, [r.messageId], ohboxPolicy)).get(r.messageId);
            if (settled) {
              answered[index] = {
                sender, messageId: r.messageId,
                ...withSenderCheck(settled, checked.get(r.messageId), ohboxPolicy)!,
              };
              return;
            }
          }
        }

        let result;
        try {
          // THE REQUEST — `askScreeningQuestion`, ONE definition, in `@trafficflow/core/mail`. The
          // redaction (at the CALLER, because a port has implementations outside this repo), the
          // `outbound: "prescreened"` declaration, the screening question rather than the routing
          // one, and the account's Ohbox bar into the model's user turn — four lines a second
          // caller (the worker's always-on pass) would have to get independently right, four ways
          // to send a credential or ask the wrong question. THIS IS THE ONLY AWAIT THAT OVERLAPS
          // BETWEEN LANES in any meaningful way, and it is the point: no connection, no lock, no
          // claim-blocking transaction, ~2 s long.
          const facts = senderFacts(checked.get(r.messageId) ?? { senderDomain: "", urgency: false });
          result = await askScreeningQuestion(classifier, {
            fromAddress: r.fromAddress,
            subject: r.subject,
            snippet: r.snippet,
            ...(ohboxBar ? { ohboxBar } : {}),
            ...(facts ? { senderFacts: facts } : {}),
          });
        } catch (err) {
          console.error(`[screener] AI suggestion failed for message ${r.messageId}:`, err);
          refused[index] = { sender, reason: "model_unavailable" };
          // The claim goes back at the door and the CHARGE STANDS: the source is stable, so the
          // next attempt over this message answers `duplicate` and is free.
          chargedAttempt = null;
          return;
        }

        // THE FACTS CAP THE ANSWER, and the cap is what is stored and what is answered — the same
        // `capSuggestion` the worker's pass and the read path call. No signal ⇒ `capped` IS
        // `result`, so an ordinary sender's stored row is byte-for-byte the one this path always
        // wrote.
        const capped = capSuggestion(result, checked.get(r.messageId) ?? { senderDomain: "", urgency: false });
        // Persisted NOW, in its own transaction, before this lane takes another sender.
        await this.store(ctx, r.messageId, capped);
        // DELIVERED, so the charge stands; the claim goes back at the door, after this write.
        chargedAttempt = null;
        answered[index] = {
          sender,
          messageId: r.messageId,
          ...suggestionAdvice(capped.destination, capped.spam, capped.rationale, ohboxPolicy),
          confidence: capped.confidence,
          rationale: capped.rationale,
          ...(capped.reasonCode
            ? { reasonCode: capped.reasonCode, ...reasonDetail(checked.get(r.messageId) as SenderSignals) }
            : {}),
        };
      } finally {
        // ONE DOOR, AFTER THE STORE: every exit of this lane — a served duplicate, a model fault, a
        // throw from the store, and any exit added later — gives the claim back here, never in the
        // window before the verdict is durable. A release that faults is logged once and never
        // replaces the error this lane is already carrying.
        try {
          await releaseClaim();
        } catch (err) {
          console.error(`[screener] claim release failed for message ${r.messageId}:`, err);
        }
      }
    };

    // ── THE KEY, CLAIMED BEFORE THE FIRST SPEND ─────────────────────────────────────────────
    //
    // Bound to this body's hash as PENDING, so another body under the same key is refused before
    // the gate is asked, and a same-body twin replays (the renderer answers it 409 "still
    // running" until the answer is settled onto the row). Every exit that is not the settle hands
    // the key back through `releaseKey`, once, so a run with no answer never leaves it bound. A
    // dry run claims nothing: it changed nothing, and burning the key would make the confirmation
    // click that follows it a 409.
    const key = opts.idempotency && !dryRun ? opts.idempotency : null;
    let keyHeld = false;
    if (key) {
      keyHeld = await asTx(ctx).transaction(async (tx) => claimIdempotencyKey(tx, {
        accountId: ctx.accountId, key: key.key, requestHash: key.requestHash,
        responseStatus: IDEMPOTENCY_PENDING_STATUS, responseJson: IDEMPOTENCY_PENDING_BODY,
        seq: null, now: ctx.now(), ttlMs: pendingKeyTtlMs(this.invocationBudgetMs),
      }));
      if (!keyHeld) throw new IdempotencyRaceLost(ctx.accountId, key.key);
    }
    /** Hand the key back, once; the latch is cleared before the await, as the settle clears it. */
    const releaseKey = async (): Promise<void> => {
      if (!key || !keyHeld) return;
      keyHeld = false;
      await asTx(ctx).transaction(async (tx) => releasePendingIdempotencyKey(tx, {
        accountId: ctx.accountId, key: key.key, requestHash: key.requestHash,
      }));
    };

    try {
      // ── PASS 2 — THE PAID WORK, IN BOUNDED LANES ────────────────────────────────────────────
      //
      // A hand-rolled pool rather than `Promise.all` over the whole set, because the bound IS the
      // feature: `Promise.all(purchases.map(buy))` would put fifty model calls in flight at once
      // against a per-account rate limit and a single pooled connection, which is how an
      // acceleration becomes a 429 and a queue.
      //
      // `next` is read-and-incremented with no `await` between the two, so a lane cannot take a
      // sender another lane already has — the same single-threaded argument the `charged` increment
      // above relies on, stated once here because it is the load-bearing one.
      let next = 0;
      /**
       * THE FIRST THROW STOPS ADMISSION, AND EVERY LANE IS AWAITED BEFORE IT IS RE-RAISED. `buy`
       * catches the model's faults per sender; what reaches here is `this.store` rejecting or the
       * database going away. `Promise.all` rejects on the first error and leaves the other lanes
       * RUNNING — a transient storage fault would go on dequeuing and DEBITING while the caller
       * gets a 500 with no idempotency row: money moved for work nobody sees. So a fatal error
       * closes the queue (`fatal` checked before each dequeue; the read-modify-write of `next` has
       * no `await`), `allSettled` waits for mid-call lanes to land their verdicts, and the FIRST
       * error re-raises. Paid-for senders are still stored.
       */
      let fatal: unknown;
      const lanes = Math.max(1, Math.min(SUGGEST_LANES, purchases.length));
      await Promise.allSettled(Array.from({ length: lanes }, async () => {
        for (;;) {
          if (fatal !== undefined) return;
          const i = next++;
          const p = purchases[i];
          if (!p) return;
          try {
            await buy(p);
          } catch (err) {
            fatal ??= err ?? new Error("a suggestion lane failed with no error value");
            return;
          }
        }
      }));
      if (fatal !== undefined) throw fatal;

      // ── FLATTENED IN THE CALLER'S OWN ORDER ─────────────────────────────────────────────────
      for (let i = 0; i < senders.length; i++) {
        const a = answered[i];
        if (a) suggestions.push(a);
        const s = refused[i];
        if (s) skipped.push(s);
        stopped ??= stops[i];
        refusal ??= refusals[i];
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
        // ONE PLACE DECIDES, for this call site and the drafting one — see `ai-refusal.ts`. It
        // writes the line naming the verdict and the reason (neither was logged anywhere before,
        // so a refusal could not be attributed at all), and it refuses to turn a `state` refusal
        // the account's own access view contradicts into a payment demand.
        await refuseAiSpend(
          { refusal: refusal.refusal, verdict: refusal.verdict, reason: refusal.reason },
          {
            event: "screener_suggest_refused",
            accountId: ctx.accountId,
            ...(this.access ? { access: this.access } : {}),
            unavailable: "AI suggestions are temporarily unavailable; please retry",
          },
        );
      }

      // WHAT IS LEFT, FROM THE LEDGER THE GATE READS. AFTER the loop, so it is the balance this run
      // left behind. No arithmetic: a client handed material to subtract `charged` from keeps a
      // shadow ledger that goes wrong on a renewal, a refund, an expiry or a second tab — and wrong
      // upward, claiming credits that are not there. A FAILED READ IS SILENCE, NOT ZERO: the run
      // has completed and its suggestions are paid for — a hiccup on a courtesy read must not turn
      // a purchase into an error or report an empty balance to a funded account. Absent means "no
      // answer", the same rule an unmetered deployment gives.
      let remainingCredits: number | undefined;
      if (this.remaining) {
        try {
          remainingCredits = await this.remaining(asTx(ctx), ctx.accountId);
        } catch (err) {
          console.error(`[screener] balance read failed for account ${ctx.accountId}:`, err);
        }
      }

      const dto: ScreenerSuggestResult = {
        dryRun, requested: senders.length, quoted,
        ...(price !== null ? { quotedCredits: quoted * price } : {}), charged,
        ...(stopped ? { stopped } : {}),
        ...(typeof remainingCredits === "number" ? { remainingCredits } : {}),
        suggestions, skipped,
      };

      // THE ANSWER, SETTLED ONTO THE KEY. The latch is cleared first: a settle that loses or
      // faults never deletes a row that may now be another run's. LOST means another run's
      // answer is on the key (a same-body twin that outlived this claim's TTL, or an erasure's
      // stamp); the request replays whatever the key holds.
      if (key) {
        keyHeld = false;
        const settled = await asTx(ctx).transaction(async (tx) => settleIdempotencyKey(tx, {
          accountId: ctx.accountId, key: key.key, requestHash: key.requestHash,
          responseStatus: 200, responseJson: dto, seq: 0, now: ctx.now(),
        }));
        if (!settled) throw new IdempotencyRaceLost(ctx.accountId, key.key);
      }
      return dto;
    } finally {
      // ONE DOOR for the key: a fatal lane, a refusal or any throw above leaves through here.
      try {
        await releaseKey();
      } catch (err) {
        console.error(`[screener] idempotency key release failed for account ${ctx.accountId}:`, err);
      }
    }
  }

  /**
   * ONE suggestion, in its own transaction — `storeScreenerSuggestion`, unchanged in behaviour.
   *
   * The body of this method moved to `@trafficflow/db` when the worker's always-on pass became a
   * second writer of these rows: the delete-then-insert, the provenance it is scoped to and the
   * per-message transaction are the row's definition, and the worker cannot reach this class. See
   * that module for the argument; this stays a method so the call sites above read the same.
   */
  /**
   * WAIT FOR THE CALLER THAT HOLDS THIS MESSAGE TO FINISH, then read what they bought. Reached
   * only from `suggest`'s `inflight` branch — the spend gate has said, on a committed claim row,
   * that another caller is inside a model call for this message. It polls the STORE, not the
   * claim: the claim disappearing means the holder stopped, not succeeded (a model fault releases
   * it too), and what a caller can serve is a stored suggestion — which also covers the worker's
   * auto-suggest pass. A poll because `LISTEN`/`NOTIFY` is unavailable through a
   * transaction-pooling pooler; a bounded poll of an indexed point read is ~twenty reads worst
   * case, none in the common uncontended one.
   */
  private async awaitHeldSuggestion(
    ctx: ServiceContext, messageId: string, ohboxPolicy: OhboxPolicy, deadline: number,
  ): Promise<ScreenerItem["aiSuggestion"] | undefined> {
    // The budget is checked BEFORE the first sleep, so a request that has already spent it on an
    // earlier sender does exactly one read here and returns — not one read plus a pointless wait.
    for (;;) {
      const stored = await this.storedSuggestions(ctx, [messageId], ohboxPolicy);
      const found = stored.get(messageId);
      if (found) return found;
      if (Date.now() >= deadline) return undefined;
      await new Promise<void>((resolve) => { setTimeout(resolve, INFLIGHT_POLL_MS); });
    }
  }

  private async store(ctx: ServiceContext, messageId: string, result: ClassifierResultLike): Promise<void> {
    await storeScreenerSuggestion(asTx(ctx), {
      accountId: ctx.accountId,
      messageId,
      destination: result.destination,
      confidence: result.confidence,
      rationale: result.rationale,
      spam: result.spam,
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
 * THE SENDER CHECK OVER A SET OF HELD ROWS, keyed by message. One call for the whole page or the
 * whole purchase, because `campaign` — one subject arriving from unrelated strangers — is a fact
 * about the SET and invisible to a check that sees one message at a time. The set is therefore
 * what the caller is looking at: the page a person is reading, or the senders a press named.
 */
function senderSignalsByMessage(rows: readonly ScreenerRow[]): Map<string, SenderSignals> {
  const signals = senderCheckAll(rows.map((r) => ({
    fromAddress: r.fromAddress,
    fromName: r.fromName,
    subject: r.subject,
    snippet: r.snippet,
    authVerdict: r.authVerdict,
  })));
  return new Map(rows.map((r, i) => [r.messageId, signals[i] as SenderSignals]));
}

/**
 * WHO OF THESE THIS ACCOUNT WROTE TO — `correspondent.ts`, one read for the set, onto the signals
 * the check already produced. The fact is the mailbox's, never the sender's, and it decides the
 * reason unless the message failed authentication: then it is not evidence about this message.
 */
async function markCorrespondents(
  ctx: ServiceContext, rows: readonly ScreenerRow[], checked: Map<string, SenderSignals>,
): Promise<void> {
  if (rows.length === 0) return;
  const found = await correspondentsAmong(asTx(ctx), {
    accountId: ctx.accountId, senders: rows.map((r) => r.fromAddress), references: "held",
  });
  for (const r of rows) {
    const evidence = found.get(r.fromAddress.trim().toLowerCase());
    const signals = checked.get(r.messageId);
    if (!evidence || !signals) continue;
    signals.correspondent = { sentAt: evidence.sentAt.toISOString() };
    if (signals.auth !== "fail") signals.reasonCode = "correspondent";
  }
}

/**
 * THE FACTS, APPLIED TO WHAT IS ON RECORD. The worker's pass caps the row it STORES; this caps
 * what is SHOWN, and both call the same `capSuggestion`, so the two can never disagree about a
 * verdict — the cap is idempotent, and running it here is what lets a suggestion bought before
 * this shipped be corrected on the screen the person is looking at rather than re-bought. With no
 * signal the advice object is returned UNTOUCHED, which is nearly every sender.
 */
function withSenderCheck(
  advice: ScreenerItem["aiSuggestion"], signals: SenderSignals | undefined, ohboxPolicy: OhboxPolicy,
): ScreenerItem["aiSuggestion"] {
  if (!advice || !signals?.reasonCode) return advice;
  const capped = capSuggestion({
    destination: advice.destination, confidence: advice.confidence,
    rationale: advice.rationale, spam: advice.spam,
  }, signals);
  return {
    ...suggestionAdvice(capped.destination, capped.spam, capped.rationale, ohboxPolicy),
    confidence: capped.confidence,
    rationale: capped.rationale,
    ...(capped.reasonCode ? { reasonCode: capped.reasonCode, ...reasonDetail(signals) } : {}),
  };
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

/**
 * The confirmed ceiling, or `null` for "no quote was shown". See {@link ScreenerSuggestBody.maxCredits}.
 */
function parseConfirmedCeiling(body: ScreenerSuggestBody): number | null {
  const raw = body?.maxCredits;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
    throw new ServiceError(
      "validation_failed", 400, "maxCredits must be a non-negative whole number of credits",
    );
  }
  return raw;
}

/**
 * A row, plus whatever suggestion is on record for it. No I/O, and nothing to spend.
 *
 * It used to drop two facts the row already carried: `mailboxId`, so no client could say which of
 * the account's addresses a stranger wrote to, and `fromName`, the display name the sender
 * asserted — screening signal the sheet renders where it has it. Both are selected by
 * `HELD_COLUMNS` and were thrown away here, which is why the gap was invisible from every surface.
 */
function toItem(r: ScreenerRow, aiSuggestion: ScreenerItem["aiSuggestion"]): ScreenerItem {
  return {
    id: r.messageId,
    messageId: r.messageId,
    mailboxId: r.mailboxId,
    threadId: r.threadId,
    sender: { name: r.fromName, address: r.fromAddress },
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
