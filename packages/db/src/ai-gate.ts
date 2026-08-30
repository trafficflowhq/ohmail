import { and, desc, eq, or, sql } from "drizzle-orm";
import { entitlementsFor, effectiveSubscriptionOf, type Entitlements } from "./billing.js";
import { debitCredits, refundCredits, type DebitReason } from "./credits.js";
import { lockExistingBalance } from "./spend-lock.js";
import { AI_CLAIM_TTL_MS, claimAiAttempt, releaseAiAttempt } from "./ai-claim.js";
import { aiActionCost, ledgerSources, type WeightedDebitReason } from "./ledger-source.js";
import { isSuspended } from "./suspension.js";
import { accounts, auditLog, creditLedger } from "./schema.js";
import type { LedgerTx, Tx } from "./change-log.js";

/**
 * THE AI SPEND GATE. The one place money is asked for before a model is
 * called, and the one place that answer is turned into "proceed" or "degrade".
 *
 * ## Why it lives in `packages/db` and not in `packages/services`
 *
 * The same argument that put {@link debitCredits} here, one layer up: the WORKER is where most
 * AI happens (the classify branch in `core/src/pipeline.ts`, the workflow drain, the proposal
 * pass) and the worker may import **core + db only**. The worker's dependency test pins that
 * list (RECURSIVELY — see its own note) because a `@trafficflow/services` import typechecks,
 * resolves through the vitest alias, and then throws `MODULE_NOT_FOUND` inside the worker's
 * Docker image, where `services` is not installed. `packages/services` (the drafting path) and
 * `packages/core` both already import db, so db is the only home every consumer can reach — and
 * it is the right one anyway, since everything the gate decides with (`credit_ledger`,
 * `billing_subscriptions`) is defined here.
 *
 * One implementation, five call sites. Two copies of "may this account spend?" would diverge
 * into either overcharging the user or giving tokens away.
 *
 * ## THE CONTRACT: it degrades, it never throws
 *
 * {@link AiCreditGate.tryDebit} answers a boolean and **swallows every error**. That is not
 * defensive habit, it is a hard requirement of the gate's contract: `pipeline.ts` has no try/catch around the
 * classify call, so a throw out of the gate would abort the whole message's ROUTING — the
 * message would not be ingested at all — rather than fall back to the deterministic rules. A
 * billing fault must cost the user their AI suggestion, never their mail.
 *
 * "Swallows every error" is meant literally, and it now includes the ERROR REPORTER: `report`
 * is invoked through {@link safely}, because the default reporter is `console.error` and
 * `console.error` throws `EPIPE` when stdout is closed — a real container condition, and one
 * that would otherwise propagate out of the catch block whose entire job is to contain it.
 *
 * The same reasoning forbids implementing this as a throwing decorator around `ClassifierPort`,
 * which is the shape that first suggests itself and which the never-throw contract rules out
 * by name.
 *
 * ## The outcome mapping, which is the ledger's law and not a choice
 *
 *  · `ok`           → **proceed**, charged now;
 *  · `duplicate`    → **proceed** IF the recorded attempt is still OPEN — this exact work is
 *                     already paid for, so never charge twice and never refuse. `duplicate` is
 *                     decided BEFORE sufficiency inside {@link debitCredits} precisely so that
 *                     a worker reprocessing a message (restart, `reconcileOnRestart`, re-sync,
 *                     redeploy) at balance 0 is not told `insufficient` for work the customer
 *                     already bought. When the recorded attempt is CLOSED, a fresh attempt is
 *                     charged instead — see "the attempt, not the source" below;
 *  · `insufficient` → **degrade**: skip the AI branch entirely and let the deterministic rules
 *                     decide. This is the graceful out-of-credits path the tier promise names
 *                     ("out of AI actions ⇒ rules-only degradation, never a surprise charge").
 *
 * Anything else — a `LedgerIdentityConflictError`, a dropped connection, a `NotInTransaction`
 * bug — is a fault, and a fault degrades too. It is reported through
 * {@link AiCreditGateOptions.onError} rather than swallowed silently, because "AI quietly
 * stopped working" must be diagnosable. It is also DISTINGUISHABLE from a refusal by anyone who
 * asks for the detail: see {@link AiCreditGate.spend}.
 *
 * ## THE ATTEMPT, NOT THE SOURCE — what a charge actually buys
 *
 * This is the correction the gate's first cut got wrong, and it is worth stating as a rule
 * because two obvious-looking behaviours compose into a giveaway:
 *
 *   **a charge buys one unit of WORK, and every retry of that work is free** — that is what
 *   `duplicate → proceed` means, and it is right; and
 *   **a refund reverses a charge whose work was never delivered** — also right.
 *
 * Compose them on a RETRY-STABLE source and the customer gets the work for nothing: charge,
 * model throws, refund, retry ⇒ the retry sees the surviving (append-only) debit row, answers
 * `duplicate`, proceeds, and delivers. A model outage would have classified an entire retry
 * backlog free.
 *
 * The fix is to stop conflating "the work" with "the charge for one attempt at it". The ledger
 * source names an ATTEMPT: `<work>` is attempt 1, `<work>~2` is attempt 2, and so on. An
 * attempt is **open** — retries of it are free — until it is **closed**, which happens in
 * exactly two ways:
 *
 *  · it was REFUNDED (`refund:<attempt>` exists). The money came back, so the next try is new
 *    work and is charged;
 *  · it AGED OUT of {@link AiCreditGateOptions.retryWindowMs}, where the caller declared one.
 *
 * The suffix keeps the namespace prefix intact, so `credit_ledger_source_reason_check` and the
 * `credit_ledger_refund_origin` trigger are unaffected (`classify:…~2` is still `classify:%`,
 * and its refund still names a real debit). The resolution costs ONE extra indexed read, and
 * only on the `duplicate` path — the first-charge hot path is untouched.
 *
 * ### Which callers refund, and why the classify path deliberately does NOT
 *
 * A refund is only worth making when the retry might never come. That is a property of the
 * CALLER, so the gate offers `refund` and the call sites decide:
 *
 *  · **classify (`pipeline.ts`) — no refund.** A classifier fault RETHROWS out of `planChange`,
 *    which leaves the message un-ingested and the sync cursor unadvanced, so the next cycle
 *    re-plans the same mail by construction. The retry is guaranteed, and it is free, and that
 *    free retry is what honours the charge. Refunding as well was the giveaway above — and it
 *    would have written a debit+refund pair per message per poll for the whole outage.
 *  · **drafting (`DraftingService`) — refund.** The retry belongs to a human who has just been
 *    shown a 500 and may simply give up, so an un-refunded charge could buy nothing at all.
 *  · **proposals (`proposal-cron.ts`) — refund.** The next pass falls in a later period bucket
 *    and is charged again, so this pass's charge has no future retry to honour it.
 *  · **workflow steps (`executor.ts`) — refund.** For DraftingService's reason, arrived at from
 *    the opposite direction. This row used to read "neither", on the grounds that the charge ran
 *    on the step's own transaction and a failure rolled it back with itself. That was true of the
 *    database and false of the money: the model call sat inside the same transaction, so a
 *    post-call failure reversed the charge and not the cost — one unpaid Anthropic call per
 *    failure. The charge now commits before the call, which makes it a HOLD, and a `failed`
 *    run is terminal: `workflowDrainPass` selects `status='pending'` only and nothing resets a
 *    run back to it (a standing limitation), so there is no guaranteed free retry to honour the
 *    charge and it must come back.
 *
 * ### Losing a refund is self-healing; losing a charge is not
 *
 * A crash between the debit and the refund leaves the attempt OPEN, so the retry is free and
 * delivers the work the charge paid for. That is why {@link AiCreditGate.refund} consumes its
 * marker only AFTER the grant is durable: the failure mode it protects against (a transient
 * fault during the refund, which is exactly the class most likely to co-occur with the model
 * outage that triggered it) would otherwise lose the refund permanently, with no retry able to
 * reissue it. Retrying the grant is safe for the same three reasons the refund was always
 * exactly-once: `UNIQUE (account_id, source)` on `refund:<attempt>`, the
 * `credit_ledger_refund_origin` trigger, and the marker itself.
 *
 * ## Two questions, asked by two different layers — and the split is load-bearing
 *
 * "May this account spend?" is really two questions, and the gate is careful about which one
 * it answers itself:
 *
 *  · **STATE** — is the subscription in a condition that may spend at all? A `canceled`,
 *    `unpaid`, `paused` or past-grace `past_due` account can still HOLD credits it bought
 *    (dunning never revokes credits already paid for — that is an explicit rule), and this is
 *    what stops it spending them.
 *    {@link spendState} answers it, before any write, so a refusal leaves the ledger empty.
 *    **One PART of that question is asked TWICE, and deliberately: SUSPENSION.**
 *    `spendState` is a read-then-act, and under READ COMMITTED it is not ordered against the
 *    `account_suspensions` writers at all — so the answer is re-read with the balance row lock
 *    HELD, where it is decisive. Both suspension writers take that same lock before inserting,
 *    which is the half that turns a narrower window into no window. See the re-read's own note
 *    in {@link makeAiCreditGate}, and the lock order in `spend-lock.ts`.
 *  · **QUANTITY** — is there anything left? That belongs to {@link debitCredits} and nowhere
 *    else, because it is the question `duplicate`-before-sufficiency exists to get right.
 *    Re-asking it here is a bug with a name: see {@link spendState}.
 *
 * The subscription snapshot comes from `effectiveSubscriptionOf` — the LIVE row if there is one,
 * else the newest row whatever its status. Never from `liveSubscriptionOf` alone, whose
 * deliberate exclusion of `canceled` would make a cancelled account look like it never
 * subscribed ("THE SEAM" in `billing.ts`); and no longer from `newestSubscriptionOf` alone,
 * under which a dead `incomplete_expired` row carrying a later `stripe_event_ts` than the
 * account's live `active` one made this gate refuse EVERY AI action for a paying customer.
 *
 * The two are reported separately ({@link AiSpendOutcome}) rather than collapsed into `false`,
 * because a STATE refusal is an operator's problem and a QUANTITY refusal is the customer's:
 * see {@link AiCreditGateOptions.onRefusal}, which exists so that "every account lost AI on
 * deploy day because none of them has a `billing_subscriptions` row" cannot be silent.
 *
 * ## Sensitivity is decided upstream of this file, and that is on purpose
 *
 * On the paths that still refuse, a `no_ai` / sensitive message must produce **zero
 * `credit_ledger` rows**. The gate cannot enforce that — it has no idea what a message is. Those
 * callers therefore decide sensitivity BEFORE they ask about money, and the orderings are
 * structural rather than conventional: `pipeline.ts` puts the `tryDebit` call LAST in a `&&`
 * chain that begins with `!sensitivity.flags.no_ai`, so `&&`'s short-circuit is the enforcement;
 * `DraftingService` throws its 422 before the gate is reached; the workflow executor's
 * pre-flight and per-step re-check both run before a tool's `apply` is entered. The assertion
 * that this holds is made against the LEDGER after a real message is processed, not against a
 * classifier spy — a spy proves a call did not happen, the ledger proves no money moved.
 *
 * **`ScreenerService` was in that list and is not any more.** On `POST /screener/suggest` a person selected senders, read a price and pressed a
 * button, so the press is the consent and every held sender is charged and asked about. The
 * credential is removed from the payload instead of the sender being refused, and the ordering
 * that matters there is the mirror of this one: because the caller redacts and the sink therefore
 * cannot throw, no charge can be followed by a refusal — which would have been a debit for a
 * model call never made.
 *
 * And all of that rests on `classifySensitivity` actually recognising the mail, which is why
 * its test corpus (`sensitive.test.ts`, beside the classifier) is part of this gate's surface
 * even though the function predates it.
 */

export {
  AI_ACTION_WEIGHTS, WEIGHTED_DEBIT_REASONS, aiActionCost, assertWeightedScheduleActive,
  classifyLedgerSource, screenerLedgerSource, type WeightedDebitReason,
} from "./ledger-source.js";

/* THE PORT — the shapes every call site names — lives in `ai-gate-port.ts`; everything that
 * DECIDES lives here. The split exists because the callers are shared: the ingest pipeline, the
 * Screener and the drafting path run both in a hosted deployment that meters AI and in a local
 * install that has no subscription, no ledger and nobody to ask. They must be able to name the
 * gate they may be handed without depending on the tables behind it.
 *
 * Re-exported, so every existing importer of this module is unaffected. */
export type {
  EntitlementReason, AiRefusalReason, AiSpendOutcome, AiCreditGate,
} from "./ai-gate-port.js";
import type { AiRefusalReason, AiSpendOutcome, AiCreditGate } from "./ai-gate-port.js";


export interface AiCreditGateOptions {
  /**
   * Which spend this gate books. Pins the `source` namespace via the ledger's CHECK — and, since
   * debits became weighted, pins the PRICE too.
   *
   * Narrower than the ledger's `DebitReason` on purpose: only the four reasons a gate can mint
   * have a weight. `period_expiry`, `setup_expiry` and `adjustment_debit` are debits nobody buys,
   * so a gate for one of them would have no price to charge — and this narrowing is what makes
   * that a compile error at the call site rather than an `undefined` amount that `assertAmount`
   * throws on, inside a transaction, where the gate's contract turns it into a silent degrade.
   */
  reason: WeightedDebitReason;
  /**
   * Credits per action; defaults to {@link aiActionCost} of {@link AiCreditGateOptions.reason}.
   *
   * **No production call site passes this, and the schedule depends on that staying true.**
   * {@link AI_ACTION_WEIGHTS} is the price of every metered action precisely because every gate
   * takes the default; an `amount` here is a local override of the published price list. It
   * survives for tests and for a future caller that genuinely charges a multiple of one action.
   */
  amount?: number;
  /** The gate's clock — the entitlement decision and the retry window read it. */
  now?: () => Date;
  /**
   * How long a charged attempt keeps paying for FREE RETRIES. Absent ⇒ forever.
   *
   * ## Only set this where the attempt identity is CLIENT-chosen
   *
   * "Forever" is the right default and it is not laziness: `classify:<mailbox>:<hash(dedupKey)>`
   * is derived from immutable mail, so a message re-planned months later after a mailbox
   * re-sync is genuinely the SAME work, and charging again would re-break the free-retry rule (see
   * {@link spendState}). Nothing about the passage of time makes that a second classification.
   *
   * `debit_draft` is the exception, because half of its identity is the caller's own
   * `Idempotency-Key`: `draft:<messageId>:<hash(attemptKey)>`. A client that replays one key
   * indefinitely would otherwise mint unlimited free drafts — every replay answers `duplicate`,
   * proceeds, calls the model and stores a NEW draft, charging nothing, for ever.
   *
   * The bound that closes it is not arbitrary: it is `IDEMPOTENCY_TTL_MS`, the exact window in
   * which the HTTP layer still honours that key. Inside it, a repeat IS a retry and must not be
   * charged twice — including the case this protects that nothing else does, where the model
   * succeeded but the storing transaction was lost. Outside it the key means nothing to the
   * request path any more, so a request carrying it is new intent and pays like one.
   *
   * **The age is measured against `credit_ledger.created_at`, which the DATABASE writes.** So
   * setting this makes {@link AiCreditGateOptions.now} meaningful in a way it otherwise is not:
   * an injected test clock that is not near wall time will not line up with `now()` in Postgres.
   * Every production caller passes no `now` at all (wall clock both sides); tests that exercise
   * the window must anchor their clock on `Date.now()` rather than on a fixed literal.
   */
  retryWindowMs?: number;
  /**
   * ONE CALLER AT A TIME PER SOURCE. Absent ⇒ the historic behaviour: the ledger
   * decides, and a concurrent second caller is waved through as a free retry.
   *
   * ## What it fixes, and why the ledger could not
   *
   * `duplicate → proceed` is a statement about the PAST: a debit row proves this work was paid
   * for. It cannot say whether the caller that paid has FINISHED, so a genuine free retry (the
   * worker re-planning after a restart) and a second caller still inside its model call arrive
   * looking identical — and the second one was given leave to spend on a paid model call nobody
   * bought. With `POST /screener/suggest` accepting distinct `Idempotency-Key`s and no edge rate
   * limit in front of it, N simultaneous requests bought N model calls for ONE credit.
   *
   * With this on, {@link makeAiCreditGate} takes a durable claim on the source in the same
   * transaction as the money decision, BEFORE the model call, and a second arrival is answered
   * `refusal: "inflight"` instead of `permitted`. The free retry is unchanged in every sequential
   * case: the claim is released when the work ends, and the ledger still answers `duplicate`.
   *
   * ## Where it is on, and why not everywhere yet
   *
   * The Screener's two spenders — the request path and the worker's auto-suggest pass — share one
   * ledger source (`classify:screener:<message_id>`) and are reached by two independent
   * producers, a cron and a button, which makes the collision an everyday event rather than an
   * attack. They are the proven case and they have it on.
   *
   * The other four call sites (classify, draft, propose, workflow steps) are NOT switched on in
   * the same change. Each needs its loser path designed rather than inherited — degrading ingest
   * routing to rules because another worker holds the claim is a different decision from
   * answering a person's draft request — and shipping that untested alongside the money fix would
   * be trading a measured defect for four unmeasured ones. The mechanism is here for them; the
   * per-caller decision is not this slice's to make.
   *
   * Callers that set this MUST call {@link AiCreditGate.release} when the work ends. Forgetting
   * costs at most {@link claimTtlMs} of exclusivity on one source and never any money.
   */
  exclusive?: boolean;
  /**
   * How long an exclusive claim is honoured before another caller may take it over. Defaults to
   * `AI_CLAIM_TTL_MS`; see there for why 60 s and not less.
   *
   * Unlike {@link AiCreditGateOptions.retryWindowMs} this bound is measured by POSTGRES, not by
   * {@link AiCreditGateOptions.now} — the holders are separate processes, so the clock has to be
   * the one they share. A test may shorten it; nothing in production does.
   */
  claimTtlMs?: number;
  /**
   * Where a swallowed fault goes. Absent ⇒ `console.error`. A gate that degrades silently is
   * a gate nobody can debug when "AI stopped working" arrives as a support ticket.
   *
   * Invoked through {@link safely}: a reporter that throws must not escape the catch block it
   * was called from (`console.error` raises `EPIPE` on a closed stdout).
   */
  onError?: (err: unknown, ctx: { phase: "debit" | "refund"; accountId: string; source: string }) => void;
  /**
   * Where a REFUSAL goes — the hook the module doc's "AI quietly stopped working must be
   * diagnosable" requirement actually needs.
   *
   * A refusal is not a fault, so `onError` never sees it, and it writes no ledger row, so the
   * money record cannot show it either. Without this, the single most likely production cause
   * of silent AI-off is invisible: {@link spendState} refuses every account with no
   * `billing_subscriptions` row (`entitlementsFor` returns `aiEnabled: false` for `sub === null`),
   * and both hosts wire the gate unconditionally — so on the day metering ships, every
   * pre-billing account loses AI, with nothing logged and nothing counted.
   *
   * The DEFAULT reports `state` refusals and stays quiet about `quantity` ones. That asymmetry
   * is the point: an empty balance is a normal, expected, customer-visible condition already
   * surfaced as a 402 and a rules-only degradation, whereas "this account cannot spend at all"
   * is an operator's problem that nothing else in the system would ever mention. Pass a
   * function to count both.
   */
  onRefusal?: (ctx: {
    kind: "state" | "quantity"; reason: AiRefusalReason; accountId: string; source: string;
  }) => void;
}

/**
 * How many "I charged this attempt" markers one gate remembers.
 *
 * The map exists to distinguish *"I just charged this"* from *"this was already charged"* —
 * both of which `tryDebit` reports as `true`, because both mean "proceed". Refunding the second
 * is a real leak: a message classified successfully in June and reprocessed in July would have
 * its June charge handed back the moment July's call happened to fail.
 *
 * Entries are consumed within one AI call (charge → call → refund on throw) and, since the
 * attempt-tracking correction, are also CLEARED by any later non-charging decision about the same source — so a
 * marker can no longer outlive its attempt even on the happy path, and the live size is
 * effectively one per in-flight call. The cap only bounds memory in a long-lived worker whose
 * successful calls never come back to claim their marker. Overflowing it can only make a refund
 * NOT happen, which is the safe direction (an un-refunded charge leaves the attempt open, and
 * an open attempt retries free), and it takes 512 consecutive un-reconsidered charges inside
 * one process to reach.
 */
const MAX_TRACKED_CHARGES = 512;

/** The separator between a unit of work and its attempt ordinal in a ledger `source`. */
const ATTEMPT_SEP = "~";

/**
 * Build a per-account spend gate over a TOP-LEVEL db handle.
 *
 * `db` must be the top-level handle, not someone else's transaction: the gate opens its own
 * short transaction per call, because {@link debitCredits} is transaction-only (its
 * `SELECT … FOR UPDATE` is the serializer, and on an autocommit handle that lock dies with its
 * own statement). Opening its own is also what makes the gate safe to call from
 * `planChange` — that phase is kept strictly outside the persist transaction by design, so
 * the money is committed by itself and the AI call that follows never sits inside a
 * seq/change_log tx.
 *
 * ## NEVER CALL THIS GATE FROM INSIDE A CALLER'S TRANSACTION. HOIST THE CALL OUT.
 *
 * Kept verbatim from the charge-on-the-caller's-transaction method since deleted, because the lesson
 * outlives it and the next caller holding an open transaction will otherwise rediscover it the
 * same expensive way (the method is named in that commit; it is deliberately not named here, so a
 * grep for it stays empty and finds no doc that still recommends the shape):
 *
 * > {@link AiCreditGate.tryDebit} opens its own transaction, which is right for every caller
 * > that has none — `planChange` runs outside one by construction (the classify call is kept
 * > out of the persist transaction), and so do the drafting request path and the
 * > proposal pass. The workflow executor is the exception: each step runs INSIDE
 * > `db.transaction`, and asking for a second one from in there is a self-deadlock. It is not
 * > a theoretical one — the worker's metering test hung on it, three cases at once, before this
 * > method existed. On PGlite (one connection) it blocks forever; against a real pool it takes
 * > a second connection that may need locks the outer transaction is holding.
 *
 * One correction the original text got wrong, established while reviewing that deletion: at the instant the
 * step gate ran, the step transaction held **no row locks at all** — every statement before it
 * was a plain `SELECT`. So it was never a lock-graph deadlock. What hung was the CONNECTION: an
 * inner `BEGIN` queued behind an outer transaction that could not finish until its own callback
 * returned. That distinction matters, because it means the answer is structural — do not nest —
 * and not "acquire the locks in a better order".
 *
 * That method was the wrong answer to the right observation. Sharing the caller's transaction
 * did remove the nesting, but it also made the CHARGE roll back with the caller's writes, and the
 * paid model call in between does not roll back: we lost the revenue and kept the cost. The
 * executor now charges in a `prepare` phase that runs strictly between transactions
 * (`packages/core/src/ai/workflows/executor.ts`), so there is nothing left in the product that
 * needs to hand this gate a transaction.
 */
export function makeAiCreditGate(
  db: Tx,
  accountId: string,
  opts: AiCreditGateOptions,
): AiCreditGate {
  const amount = opts.amount ?? aiActionCost(opts.reason);
  const now = opts.now ?? (() => new Date());
  const report = opts.onError ?? ((err, ctx) => {
    console.error(`[credits] ${ctx.phase} failed for account ${ctx.accountId} (${ctx.source}):`, err);
  });
  const reportRefusal = opts.onRefusal ?? ((ctx) => {
    // STATE only, by default — see `onRefusal`. One line, machine-greppable prefix.
    if (ctx.kind !== "state") return;
    // ...and NOT the account's own off switch. `ai_disabled` is a state refusal by mechanism but
    // a customer choice by meaning: it is expected, it is customer-visible, and it recurs on
    // every unclear message for as long as the switch is off. Logging it would emit one warn
    // line per message received, for ever, and bury the line this reporter exists for — "every
    // account lost AI on deploy day because none of them has a billing_subscriptions row".
    if (ctx.reason === "ai_disabled") return;
    console.warn(
      `[credits] AI refused for account ${ctx.accountId} (${ctx.source}): subscription state ` +
        `'${ctx.reason}' may not spend. No ledger row is written for this, so this line is the ` +
        "only record it happened.",
    );
  });
  /**
   * base ledger source → the ATTEMPT source this gate charged for it and has not refunded.
   * See {@link MAX_TRACKED_CHARGES}.
   */
  const openAttempts = new Map<string, string>();

  /** Never let a reporter's own failure escape the handler that called it. */
  function safely(fn: () => void): void {
    try { fn(); } catch { /* a reporter that throws is not allowed to become the outcome */ }
  }

  /**
   * The decision itself, on whatever transaction it is handed. The two public entry points
   * differ only in who owns that transaction and in what they do with a fault.
   */
  async function decide(
    tx: LedgerTx, source: string, meta: Record<string, unknown>,
  ): Promise<AiSpendOutcome> {
    const at = now();
    // The SUBSCRIPTION-STATE gate runs first and writes nothing: a `canceled`, `unpaid`,
    // `paused` or past-grace account may still hold credits it bought — dunning never
    // revokes them, explicitly — and this is what stops it SPENDING them. A refusal here
    // leaves such an account's ledger empty.
    const state = await spendState(tx, accountId, at);
    if (!state.spendable) {
      safely(() => reportRefusal({ kind: "state", reason: state.reason, accountId, source }));
      return { permitted: false, refusal: "state", reason: state.reason };
    }

    // ── THE EXCLUSIVE CLAIM, TAKEN BEFORE THE MONEY AND NOT AFTER IT ─────────────────────────
    //
    // The ORDER here is the whole safety argument, and the other one is a money leak.
    //
    // Claiming AFTER the debit reads better — decide the money, then reserve the work — and it
    // admits a state nothing can undo: a caller that CHARGED and then lost the claim would hold a
    // committed debit for a model call it must not make. Claiming first means the loser has
    // written nothing at all when it is turned away, so there is no window in which money has
    // moved for work that will not happen.
    //
    // It also makes the block cheaper. `INSERT … ON CONFLICT` blocks the second arrival on this
    // tuple until the holder's (short, model-free) transaction ends, which is the same
    // serialization `claimIdempotencyKey` relies on — and it happens before the balance row lock
    // rather than behind it.
    //
    // The claim names the BASE source, never the resolved attempt: `<base>` and `<base>~2` are
    // two tries at ONE unit of work and exactly one caller may be trying at a time.
    if (opts.exclusive) {
      const held = await claimAiAttempt(tx, accountId, source, opts.claimTtlMs ?? AI_CLAIM_TTL_MS);
      if (!held) return { permitted: false, refusal: "inflight", source };
    }

    // ── THE LOCKED REGION, AND THE SUSPENSION RE-READ INSIDE IT ──────────────────────────────
    //
    // `spendState` above is a PRE-CHECK. It is worth keeping — it refuses an `ai_disabled` or
    // `canceled` account for the price of two indexed reads and without touching the balance row
    // at all — but on its own it is a read-then-act, and READ COMMITTED gives it no ordering
    // whatsoever against the two writers of `account_suspensions`. The window is not narrow: the
    // whole point of the balance row lock is that concurrent spenders QUEUE on it, so a spend that
    // read "not suspended" can sit waiting behind other spends while a signed
    // `charge.refunded` / `charge.dispute.funds_withdrawn` webhook suspends the account, and then
    // debit and answer `permitted` with the revenue already reversed. That was the defect, and the
    // exposure was every credit the customer had bought.
    //
    // Two halves close it and NEITHER IS SUFFICIENT ALONE:
    //
    //  · this re-read, taken with the balance lock HELD, catches a suspension that committed
    //    before we got the lock — including one that committed while we queued behind it;
    //  · `suspension.ts`' two writers take the SAME lock before they insert, so a suspension
    //    cannot become durable between this re-read and this transaction's commit. Without that
    //    half the re-read would just be a narrower window; with it there is no window.
    //
    // So a spend either commits BEFORE the suspension is durable — and STANDS, because the
    // standing rule is suspend-not-clawback and a committed charge is not retroactively undone — or it
    // observes the suspension and refuses. There is no third outcome. The lock order both sides
    // obey, and why it cannot deadlock, is written out in `spend-lock.ts`.
    //
    // It reports `state` / `suspended`: the same kind and the same word `spendState` would have
    // used had it seen the row, so `onRefusal` counts it with the other operator-visible refusals
    // and `aiRefusalReason` cannot answer differently about the same account.
    //
    // The cost on the hot path is one point lookup on `account_suspensions`' primary key and
    // nothing else — the `FOR UPDATE` here is the SAME row lock `debitCredits` takes two statements
    // later, so re-locking it is free.
    //
    // ── AND IT IS THE NON-WRITING DOOR, WHICH IS A DECISION AND NOT AN OVERSIGHT ─────────────
    //
    // `lockAccountBalance` would guard-INSERT so the lock is unconditionally real. It is the wrong
    // door HERE, because this lock is taken on the way to a decision that is usually a refusal, and
    // a refusal from this gate has to leave the database untouched: the metering assertion
    // (`ai-metering.test.ts`, in the services suite) compares every row of every table in a refused
    // world against a world with no gate wired at all, and a zero-balance `credit_balances` row is a
    // difference even though the schema defines it as the same state as no row. That assertion is
    // worth more than the convenience.
    //
    // So a `null` — no row, therefore NO LOCK — is refused outright rather than reasoned around.
    // That costs nothing, because `null` means the account has no committed ledger history at all
    // (the deferred `credit_ledger_coupled` trigger will not commit history without a balance row),
    // so `debitCredits` could only have answered `insufficient` anyway. The refusal is the same
    // outcome one statement earlier, and it keeps the invariant sharp: **whenever this gate permits,
    // it held a real row lock and re-read the suspension underneath it.**
    if (await lockExistingBalance(tx, accountId) === null) {
      await unclaim(tx, source);
      safely(() => reportRefusal({ kind: "quantity", reason: "out_of_credits", accountId, source }));
      return { permitted: false, refusal: "quantity", reason: "out_of_credits" };
    }
    if (await isSuspended(tx, accountId)) {
      // GIVE THE CLAIM BACK, for the reason the `insufficient` path below does: this request spent
      // nothing and did nothing, and holding a claim over it would wedge the source for a full TTL.
      await unclaim(tx, source);
      safely(() => reportRefusal({ kind: "state", reason: "suspended", accountId, source }));
      return { permitted: false, refusal: "state", reason: "suspended" };
    }

    // Attempt 1 is the bare source, so the overwhelmingly common first charge costs exactly
    // the queries it always did. Only a `duplicate` pays for the attempt resolution below.
    let outcome = await debitCredits(tx, accountId, amount, opts.reason, source, meta);
    if (outcome.ok) return { permitted: true, charged: true, attempt: source };
    if (outcome.reason === "insufficient") {
      // GIVE THE CLAIM BACK ON THE WAY OUT. A refusal that kept it would wedge this source for a
      // full TTL over a request that spent nothing and did nothing — and the account is about to
      // be topped up, which is exactly when the next attempt arrives. Same transaction, so the
      // release and the refusal are one atom.
      await unclaim(tx, source);
      safely(() => reportRefusal({ kind: "quantity", reason: "out_of_credits", accountId, source }));
      return { permitted: false, refusal: "quantity", reason: "out_of_credits" };
    }

    // `duplicate`: an attempt at this work is on record. Is it still OPEN (⇒ its retries are
    // free, which is the free-retry rule's whole point) or CLOSED (⇒ refunded or aged out, so this is a new
    // attempt and must be paid for)?
    //
    // On an exclusive gate this line is now reached only by a caller that HOLDS the claim, which
    // is what makes "proceed, free" safe to say: the earlier attempt is not merely paid for, it
    // is also finished or dead. That is the sentence the ledger alone could never say.
    const resolved = await resolveAttempt(tx, accountId, source, opts.reason, at, opts.retryWindowMs);
    if (!resolved.closed) return { permitted: true, charged: false, attempt: resolved.attempt };

    outcome = await debitCredits(
      tx, accountId, amount, opts.reason, resolved.attempt, { ...meta, attempt: resolved.ordinal },
    );
    if (outcome.ok) return { permitted: true, charged: true, attempt: resolved.attempt };
    if (outcome.reason === "insufficient") {
      await unclaim(tx, source);
      safely(() => reportRefusal({ kind: "quantity", reason: "out_of_credits", accountId, source }));
      return { permitted: false, refusal: "quantity", reason: "out_of_credits" };
    }
    // A concurrent caller claimed this attempt between our read and our insert. It is paid for
    // and open, so this is a free retry of it — the same answer `duplicate` always means.
    //
    // Unreachable on an exclusive gate (that caller could not have held the claim we are holding)
    // and kept anyway, because the branch is still right for the gates that have no claim.
    return { permitted: true, charged: false, attempt: resolved.attempt };
  }

  /** Undo a claim taken earlier in THIS transaction. A no-op on a gate that takes none. */
  async function unclaim(tx: LedgerTx, source: string): Promise<void> {
    if (opts.exclusive) await releaseAiAttempt(tx, accountId, source);
  }

  /** Record or clear the refund marker for `source`, given what the decision actually did. */
  function track(source: string, out: AiSpendOutcome): void {
    if (out.permitted && out.charged) {
      if (openAttempts.size >= MAX_TRACKED_CHARGES) {
        openAttempts.delete(openAttempts.keys().next().value as string);   // FIFO
      }
      openAttempts.set(source, out.attempt);
      return;
    }
    // A fault proves nothing about an earlier charge, so its marker is left alone. Every other
    // outcome proves THIS attempt charged nothing, which makes any marker we hold stale.
    if (!out.permitted && out.refusal === "fault") return;
    openAttempts.delete(source);
  }

  /**
   * THE decision, as one function. `tryDebit` is this with the detail dropped — written that
   * way rather than as two implementations so a request path and the worker cannot come to
   * different conclusions about the same customer.
   */
  async function spend(source: string, meta: Record<string, unknown>): Promise<AiSpendOutcome> {
    try {
      const out = await db.transaction(async (tx) => decide(tx as LedgerTx, source, meta));
      track(source, out);
      return out;
    } catch (err) {
      safely(() => report(err, { phase: "debit", accountId, source }));
      return { permitted: false, refusal: "fault", error: err };   // DEGRADE. Never throw — the gate's contract.
    }
  }

  return {
    // Read by decorators — `withSetupPool` is the one in the tree — so a layer that can answer
    // `permitted` without reaching this gate knows it owes the same claim. See the port.
    exclusive: opts.exclusive === true,
    spend: (source, meta = {}) => spend(source, meta),

    async tryDebit(source, meta = {}) {
      return (await spend(source, meta)).permitted;
    },

    async refundAttempt(attempt, meta = {}) {
      // No marker consulted and none cleared: the caller holds the attempt id from its own
      // `spend()`, which is a stronger claim than the marker ever was. Exactly-once is still
      // enforced by `UNIQUE (account_id, source)` on the refund row and by the
      // `credit_ledger_refund_origin` trigger. A source this gate is ALSO tracking is dropped
      // from the marker set, so a later `refund()` for the same work cannot pay twice.
      for (const [source, tracked] of openAttempts) {
        if (tracked === attempt) openAttempts.delete(source);
      }
      try {
        // The NAMED primitive: it builds the `refund:` source itself and refuses — with
        // a typed throw, landed in this catch — a refund of nothing or one larger than the
        // debit it reverses. `amount` here is the same constant `spend()` debited, so the cap
        // binds at equality and this path's behaviour is unchanged.
        await db.transaction(async (tx) =>
          refundCredits(tx as LedgerTx, accountId, amount, attempt, { ...meta, refundOf: attempt }));
      } catch (err) {
        safely(() => report(err, { phase: "refund", accountId, source: attempt }));
      }
    },

    async refund(source, meta = {}) {
      const attempt = openAttempts.get(source);
      if (attempt === undefined) return;
      try {
        // Replay-safe and exactly-once at THREE layers: this marker; `UNIQUE (account_id,
        // source)` on `refund:<attempt>`, which makes a crashed-and-retried refund path
        // report `duplicate` instead of paying twice; and the refund-origin checks — the typed
        // ones inside `refundCredits` and the `credit_ledger_refund_origin` trigger behind it —
        // which refuse a refund that does not name a real DEBIT on this account, or that is
        // LARGER than the debit it reverses (`amount` is the same constant `spend()` charged,
        // so the cap binds at equality).
        await db.transaction(async (tx) =>
          refundCredits(tx as LedgerTx, accountId, amount, attempt, { ...meta, refundOf: attempt }));
        // Consumed only now that the grant is DURABLE. Deleting first — which is what the
        // three layers above make merely redundant, not necessary — would turn a transient
        // fault inside the grant into a permanently unretryable refund.
        openAttempts.delete(source);
      } catch (err) {
        safely(() => report(err, { phase: "refund", accountId, source }));
      }
    },

    async release(source) {
      // A gate with no exclusivity took no claim, so this is a no-op rather than a stray DELETE
      // behind every AI call in the product.
      if (!opts.exclusive) return;
      try {
        await db.transaction(async (tx) => releaseAiAttempt(tx as LedgerTx, accountId, source));
      } catch (err) {
        // SWALLOWED, on this module's own contract, and the failure is BOUNDED rather than
        // ignored: a claim that could not be released expires on its own and the next caller
        // takes it over. This runs in `finally` blocks whose job is to let the real outcome —
        // a stored suggestion, or the model error that explains a skip — reach the caller.
        safely(() => report(err, { phase: "refund", accountId, source }));
      }
    },
  };
}

/**
 * The balance the STATE probe pretends the account has. See {@link spendState}.
 *
 * Any positive number does; `1` is written out rather than computed so the reason for it is
 * impossible to miss at the call site.
 */
const STATE_PROBE_BALANCE = 1;

/**
 * May this account's SUBSCRIPTION STATE spend at all — ignoring how much it has? And if not,
 * what is the state's own word for why?
 *
 * ## Why the balance is deliberately excluded here, and why that is a bug fix
 *
 * `entitlementsFor` folds TWO questions into one `aiEnabled` boolean: *"is this subscription
 * in a state that may spend?"* and *"is there anything left?"* (`aiEnabled = balance > 0`).
 * Only the first belongs in front of {@link debitCredits}. The second is `debitCredits`' own
 * job, and it answers it with **`duplicate` decided BEFORE sufficiency** — which is the entire
 * point of the free-retry rule.
 *
 * Asking `entitlementsFor` about the balance too silently re-broke that, one layer up, and the
 * ledger test caught it: charge the last credit for a message, then reprocess it on a worker
 * restart. The debit would answer `duplicate` — already paid for, proceed — but a pre-check
 * reading `balance > 0` never let it be asked, so the worker **refused work the customer had
 * already bought**, precisely when the account is out of credits and cannot buy it again. A
 * guard in front of a correct decision is not free; it can only ever be wrong in a way the
 * decision is not.
 *
 * So the probe hands `entitlementsFor` a nominal balance, takes only the state verdict, and
 * leaves every question about *quantity* to the primitive. The status truth table stays in one
 * place — reimplementing the switch here is the drift this avoids.
 *
 * **The asymmetry is intended.** A STATE refusal outranks "already paid": a cancelled account
 * reprocessing an old message would be receiving a fresh classification under a plan it no
 * longer has, and nothing is charged either way. A BALANCE refusal must not, because
 * exhaustion is exactly the state in which the customer's earlier payment is all they have.
 *
 * `reason` is the entitlement's own word, and it is a pure function of the STATUS — never of
 * the probe balance — which is what makes it identical to {@link aiRefusalReason}'s answer for
 * the same account. That equality is pinned by `test/ai-offswitch.test.ts` ("`aiRefusalReason`
 * cannot drift from the gate") and, across every refusing status, by the metering suite
 * (`ai-metering.test.ts`). It matters more than it looks: the two functions
 * make the SAME subscription read, and the dead-row-refuses-a-paying-customer defect is what
 * happens when one reader of that question answers differently from another. (This pointer once
 * named a test file that does not exist and, per the git history, never has.)
 */
async function spendState(
  tx: Tx, accountId: string, now: Date,
): Promise<{ spendable: boolean; reason: AiRefusalReason }> {
  // THE OFF SWITCH (migration 0022), asked FIRST — before the subscription read and before any
  // write. Reading it here rather than at the five call sites is what makes it enforcement: the
  // pipeline, the drafting route, the workflow executor, the proposal cron and the Screener all
  // reach a model only through this gate, so one row answers for all of them and there is no
  // per-call-site wiring anyone can forget. A refusal here leaves the ledger untouched, so an
  // account with AI off produces ZERO credit_ledger rows — the same structural property the
  // sensitivity rule gives sensitive mail, and asserted the same way.
  //
  // It also short-circuits `effectiveSubscriptionOf`, so an account with AI off costs ONE indexed
  // primary-key read per decision rather than two reads and an entitlement computation.
  if (!(await aiEnabledFor(tx, accountId))) {
    return { spendable: false, reason: "ai_disabled" };
  }
  // LIVE-preferred, falling back to newest-of-any-status. This read was
  // `newestSubscriptionOf`, and on an account holding both a live `active` row and a newer dead
  // one (an expired abandoned Checkout) it refused every AI action for a paying customer.
  const sub = await effectiveSubscriptionOf(tx, accountId);
  // An admin suspension overrides every subscription state — no spend. Read
  // here, on the same handle, so `aiRefusalReason` (which reads it too) cannot answer differently
  // for the same account; the pinned equality below depends on both asking the same question.
  const suspended = await isSuspended(tx, accountId);
  const ent = entitlementsFor({ sub, balance: STATE_PROBE_BALANCE, suspended, now });
  return { spendable: ent.aiEnabled, reason: ent.reason };
}

/**
 * Has this account switched managed AI off?
 *
 * A missing row answers `true` (enabled): the account id came from a mailbox row or a session,
 * so its absence is a referential-integrity problem, and failing OPEN here means such a bug
 * surfaces as the real error it is rather than as "AI mysteriously stopped for one customer".
 * Nothing is spent on the strength of this answer alone — the subscription state and
 * `debitCredits` still have to agree.
 */
async function aiEnabledFor(tx: Tx, accountId: string): Promise<boolean> {
  const [row] = await tx
    .select({ aiEnabled: accounts.aiEnabled })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);
  return row ? row.aiEnabled : true;
}

/** One attempt at a unit of work, as the ledger records it. */
interface ResolvedAttempt {
  /** The ledger source to charge (or to retry for free). */
  attempt: string;
  /** 1 for the bare source, N for `<source>~N`. */
  ordinal: number;
  /** `true` ⇒ the recorded attempt is settled, so `attempt` is a NEW one that must be paid for. */
  closed: boolean;
}

/**
 * Which attempt at `base` is current, and is it still open?
 *
 * Called ONLY after {@link debitCredits} answered `duplicate`, so the newest row always exists.
 * Two indexed reads: the newest row of the attempt family (`credit_ledger_account_id_desc_idx`),
 * then a point lookup for its refund (`credit_ledger_source_uq`).
 *
 * An attempt is CLOSED when it was refunded, or when it is older than `retryWindowMs` and the
 * caller declared one. Closing produces the NEXT ordinal rather than reusing the source,
 * because `credit_ledger` is append-only and `UNIQUE (account_id, source)` — the new charge
 * needs a name of its own, and `<base>~<n>` keeps the namespace prefix the `source`/`reason`
 * CHECK constraint requires.
 */
async function resolveAttempt(
  tx: LedgerTx,
  accountId: string,
  base: string,
  reason: DebitReason,
  now: Date,
  retryWindowMs: number | undefined,
): Promise<ResolvedAttempt> {
  const [newest] = await tx
    .select({ source: creditLedger.source, createdAt: creditLedger.createdAt })
    .from(creditLedger)
    .where(and(
      eq(creditLedger.accountId, accountId),
      eq(creditLedger.reason, reason),
      or(
        eq(creditLedger.source, base),
        // `ESCAPE` so a `%` or `_` inside a source could never act as a wildcard. Today every
        // source is uuids, hex and punctuation from `ledgerSources`, but `draft`'s attempt key
        // is client-derived and this is one character of insurance.
        sql`${creditLedger.source} like ${escapeLike(base) + ATTEMPT_SEP + "%"} escape '\\'`,
      ),
    ))
    .orderBy(desc(creditLedger.id))
    .limit(1);

  // Unreachable via the only caller (a `duplicate` outcome means a row exists), but a total
  // function is better than a non-null assertion: with nothing on record, attempt 1 is open.
  if (!newest) return { attempt: base, ordinal: 1, closed: false };

  const ordinal = attemptOrdinal(base, newest.source);
  const [refunded] = await tx
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(
      eq(creditLedger.accountId, accountId),
      eq(creditLedger.source, ledgerSources.refund(newest.source)),
    ))
    .limit(1);

  const agedOut = retryWindowMs != null
    && now.getTime() - newest.createdAt.getTime() > retryWindowMs;
  if (!refunded && !agedOut) return { attempt: newest.source, ordinal, closed: false };
  return { attempt: `${base}${ATTEMPT_SEP}${ordinal + 1}`, ordinal: ordinal + 1, closed: true };
}

/** `base` ⇒ 1, `base~7` ⇒ 7. Anything unparseable is treated as attempt 1 (fail forward). */
function attemptOrdinal(base: string, source: string): number {
  if (source === base) return 1;
  const n = Number(source.slice(base.length + ATTEMPT_SEP.length));
  return Number.isInteger(n) && n > 1 ? n : 1;
}

/** Neutralise LIKE metacharacters so a prefix match is a prefix match. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * WHY a refusal happened, as a stable machine-readable token — the standalone read, for callers
 * that want the answer without attempting a spend.
 *
 * The gate itself does NOT call this: {@link makeAiCreditGate} already holds the entitlement it
 * probed and returns the same token in {@link AiSpendOutcome}, so asking again would be a second
 * round-trip on the refusal path. The two agree by construction — `reason` is a pure function of
 * the subscription status in both — and the metering suite (`ai-metering.test.ts`) asserts
 * that equality for every status rather than trusting the sentence you are reading.
 *
 * It applies the same state/quantity split as {@link spendState}, which is what makes the
 * answer useful instead of merely true: with an `active` plan and an empty balance,
 * `entitlementsFor().reason` is `"active"` — perfectly correct about the subscription and
 * completely unhelpful as an explanation of the refusal. So the state is asked first, and a
 * plan that COULD spend but has nothing left reports `out_of_credits`; anything else reports
 * the entitlement's own word for its state (`canceled`, `paused`, `past_due`, `unpaid`,
 * `no_subscription`, `suspended`), which is exactly the vocabulary the client needs to decide
 * between "buy more" and "fix your subscription".
 *
 * A read, on the refusal path only — never on the hot path.
 *
 * Suspension is read from `account_suspensions` (cloud migration 0008) with `isSuspended`, the SAME
 * source `spendState` reads. `entitlementsFor` maps it to `reason: "suspended"`; there is no
 * second notion of suspension here, so the two functions cannot disagree for one account.
 */
export async function aiRefusalReason(
  tx: Tx, accountId: string, now: Date,
): Promise<AiRefusalReason> {
  // The off switch outranks everything, exactly as it does in `spendState` — otherwise this
  // function and the gate would disagree about the same account, which is the one thing the
  // pinned equality test exists to prevent.
  if (!(await aiEnabledFor(tx, accountId))) return "ai_disabled";
  // The SAME read `spendState` makes. These two must agree for every account, and the
  // pinned equality below is only worth something if they ask the database the same question.
  const sub = await effectiveSubscriptionOf(tx, accountId);
  const suspended = await isSuspended(tx, accountId);
  const base = { sub, suspended, now };
  if (entitlementsFor({ ...base, balance: STATE_PROBE_BALANCE }).aiEnabled) return "out_of_credits";
  return entitlementsFor({ ...base, balance: 0 }).reason;
}

/* `classifyLedgerSource` and `screenerLedgerSource` moved to `./ledger-source.js` with the rest
 * of the vocabulary. The ingest pipeline and the Screener call them and both ship in the desktop
 * engine; an import edge into this module would carry `billing.js` and the Cloud schema along
 * with a template string. */

/**
 * Read the account's AI switch (migration 0022). The value a settings screen displays.
 *
 * A missing row answers `true`, matching the gate's own fail-open read — the two must agree, or
 * the UI would show a state the spend path does not honour.
 */
export async function getAiEnabled(tx: Tx, accountId: string): Promise<boolean> {
  return aiEnabledFor(tx, accountId);
}

/**
 * Set the account's AI switch, and record WHY it changed.
 *
 * ## This is the whole off switch, and it is deliberately this small
 *
 * There is no second place to update, no cache to invalidate and no per-service flag to thread,
 * because {@link spendState} reads this column on every spend decision and every AI call site
 * in the product goes through that one gate. So the write is one `UPDATE` and the effect is
 * immediate and total: the next message that would have been classified is filed by rules
 * instead, no model is called, and no credit moves.
 *
 * ## What it does NOT do, stated so nobody adds it later
 *
 * It does not touch billing. Switching AI off is not a downgrade: the account keeps its plan,
 * its price and its credit balance, and those credits simply go unspent. Refunding or
 * pro-rating here would turn a preference into a subscription change, which is a different
 * promise from the one the site makes ("switch the AI off entirely without losing a single
 * feature that files your mail").
 *
 * The audit row exists because "who turned this off, and when" is asked exactly once — months
 * later, by someone who was not there, looking at a customer complaining that AI stopped.
 */
export async function setAiEnabled(
  tx: Tx,
  accountId: string,
  enabled: boolean,
  actor: { userId: string | null; requestId?: string } = { userId: null },
): Promise<{ aiEnabled: boolean; changed: boolean }> {
  const previous = await aiEnabledFor(tx, accountId);
  if (previous === enabled) return { aiEnabled: enabled, changed: false };
  await tx.update(accounts).set({ aiEnabled: enabled }).where(eq(accounts.id, accountId));
  await tx.insert(auditLog).values({
    accountId,
    action: "account.ai_enabled",
    payload: { aiEnabled: enabled, userId: actor.userId, requestId: actor.requestId ?? null },
    // The inverse is the whole undo: this row is enough to put the setting back.
    inverse: { aiEnabled: previous },
  });
  return { aiEnabled: enabled, changed: true };
}
