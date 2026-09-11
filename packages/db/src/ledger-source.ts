import { createHash } from "node:crypto";

/**
 * The ledger-source vocabulary — pure string construction: no table, no transaction, no import
 * beyond `node:crypto`, and that emptiness is the point. The names belong to the hosted half, but
 * they are CALLED from the mail half — ingest, the Screener, drafting, the HTTP edge — and those
 * modules also run inside the desktop engine. Naming one where they used to live imported the
 * whole defining module (an ESM edge keeps the bytes absent `sideEffects`) — how a `classify:`
 * template dragged the payment processor into an artifact a stranger downloads. Keep this file
 * leaf-shaped. One registry, never split by caller: a CHECK pins each `reason` to its namespace,
 * and two half-registries would drift into a constraint violation.
 */

/**
 * A CLIENT-supplied `Idempotency-Key`, branded so a server-minted uuid cannot be passed by
 * accident. Build it with {@link clientIdempotencyKey} at the HTTP edge and nowhere else — the
 * single act of calling that function is the greppable place where "this key came from the
 * client" is asserted.
 */
declare const IDEMPOTENCY_KEY: unique symbol;
export type IdempotencyKey = string & { readonly [IDEMPOTENCY_KEY]: true };

/**
 * Brand a request's `Idempotency-Key` header value.
 *
 * **Only ever call this with a value the CLIENT sent.** A key the server mints fresh per
 * invocation turns a client's same-key retry of a lost response into a second charge, which is
 * the exact failure `debit_draft`'s attempt scoping exists to prevent (see
 * {@link ledgerSources.draft}).
 */
export function clientIdempotencyKey(headerValue: string): IdempotencyKey {
  const key = headerValue.trim();
  if (key.length === 0) throw new Error("clientIdempotencyKey: the Idempotency-Key header is empty");
  return key as IdempotencyKey;
}

/**
 * The `source` NAMESPACE — the ledger's idempotency identity, in one place so its namespaces
 * cannot drift.
 *
 * `UNIQUE (account_id, source)` means "this economic event happened at most once for this
 * account". Each namespace is keyed so that the natural retry/replay unit of the PRODUCING
 * system maps to exactly ONE source value:
 *
 * | reason | source | why THIS identity |
 * |---|---|---|
 * | `invoice_grant` | `invoice:<stripe_invoice_id>` | Stripe retries webhooks and `stripe events resend` exists; the invoice id is the unit of "this money was received once". |
 * | `period_expiry` | `expiry:<prior_stripe_invoice_id>` | The expiry means "the credits bought by THAT invoice are over" — self-explanatory in the ledger, and replay-safe together with the composition contract. |
 * | `debit_classify` | `classify:<message_id>` | The worker reprocesses messages BY DESIGN (restart, `reconcileOnRestart`, re-sync). The message is the unit of "one AI classification of this mail". |
 * | `debit_draft` | `draft:<draft_id>:<hashed attempt key>` | A user may legitimately buy a SECOND AI draft of the same draft row, so the draft id alone is too coarse. See {@link ledgerSources.draft}. |
 * | `debit_propose` | `propose:<proposal_run_id>` | One proposer pass = one charge, however often its cron is re-entered. |
 * | `debit_workflow` | `workflow_run:<run_id>:<step_index>` | Mirrors the existing `workflow_dedup_key` crash-resume convention: a re-drained run re-executes steps idempotently, so the charge is per STEP, not per drain. |
 * | `refund` | `refund:<original_source>` | One refund per original charge, structurally — a crashed-and-retried refund path cannot refund twice because its own source collides. A refund-origin trigger additionally requires the original to be a real DEBIT on the same account, so a refund of nothing (and a refund of a refund) is refused by the database. |
 * | `adjustment_credit` / `adjustment_debit` | `admin:<uuid>` | Each staff adjustment is its own event (uuid minted per adjustment, staff user id in `meta`). |
 * | `trial_grant` | `trial:<account_id>` | The trial bounty is ONE event in an account's whole life, so the ACCOUNT is the identity. See {@link ledgerSources.trialGrant}. |
 *
 * These prefixes are not a convention: the source-reason CHECK constraint pins each `reason`
 * to its namespace, so a debit physically cannot be written under an `invoice:` source and be
 * reported back as a harmless `duplicate`.
 */
/**
 * How long a charged `draft` attempt keeps paying for free retries.
 *
 * It must equal `IDEMPOTENCY_TTL_MS` — inside that window a repeat of one client key IS a retry
 * and must not be charged twice; outside it the key means nothing to the request path any more,
 * so a request carrying it is new intent and pays like one. Named here rather than imported
 * because this module is a leaf the desktop engine compiles and `idempotency.ts` is not one;
 * `test/spend-actions-contract.test.ts` pins the two figures equal.
 */
export const DRAFT_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The five metered call sites, and the terms each spends on. The key is the CALL SITE, not the
 * ledger reason: `debit_classify` is spent by ingest (no claim, no pool) and by the Screener
 * (exclusive claim, setup pool first) — a table keyed by reason would silently give one the
 * other's terms. It is the entitlements program's own table, duplicated rather than imported
 * because the two programs may not link; `test/spend-actions-contract.test.ts` pins the two
 * against each other. NOTHING HERE READS `exclusive`: the claim is taken by the program that
 * answers the spend — the column exists so the terms are readable on this side. Two sites claim:
 * the Screener, and the proposer (keyed by one whole pass).
 */
export const SPEND_ACTIONS = {
  classify_ingest: { reason: "debit_classify", namespace: "classify", exclusive: false, setupPool: false },
  screener: { reason: "debit_classify", namespace: "classify", exclusive: true, setupPool: true },
  draft: { reason: "debit_draft", namespace: "draft", exclusive: false, setupPool: false,
    retryWindowMs: DRAFT_RETRY_WINDOW_MS },
  propose: { reason: "debit_propose", namespace: "propose", exclusive: true, setupPool: false },
  workflow: { reason: "debit_workflow", namespace: "workflow_run", exclusive: false, setupPool: false },
} as const satisfies Record<string, {
  reason: WeightedDebitReason; namespace: string; exclusive: boolean; setupPool: boolean;
  retryWindowMs?: number;
}>;

/** Which call site is spending. */
export type SpendAction = keyof typeof SPEND_ACTIONS;

export function isSpendAction(value: unknown): value is SpendAction {
  return typeof value === "string" && Object.hasOwn(SPEND_ACTIONS, value);
}

/**
 * HOW LONG AN EXCLUSIVE WORK CLAIM LIVES — 150 s, and the number is a CEILING the organizer's
 * model timeout has to fit under.
 *
 * The claim itself is the entitlements program's (`CLAIM_TTL_MS` on its port); this copy is here
 * because the thing that must be sized against it is the classifier timeout in `apps/worker`,
 * which is open code and has no other way to name the bound. A call that outlives the claim
 * releases the work to the next caller mid-flight, and both then pay for it.
 */
export const AI_CLAIM_TTL_MS = 150_000;

/**
 * The most an `attemptKey` may be. The ledger caps a whole source at 200
 * characters, so a longer key would raise from inside the caller's transaction instead of being
 * refused where it was built.
 */
export const ATTEMPT_KEY_MAX = 160;

const ATTEMPT_KEY_SHAPE = /^[A-Za-z0-9:_.~@+-]+$/;

/** The namespaces {@link sourceFor} may prepend — the set a key may therefore not START with. */
const SPEND_NAMESPACES: readonly string[] =
  [...new Set(Object.values(SPEND_ACTIONS).map((s) => s.namespace))];

/**
 * Refuse a key that is already a source, and refuse it loudly. An `attemptKey` names one unit of
 * WORK; a caller that passes a full ledger source gets `<namespace>:<namespace>:<key>`, which
 * passes the ledger's namespace CHECK and its UNIQUE, so already-paid work answers `ok` rather
 * than `duplicate` and is charged a second time — the one defect a green suite could not see,
 * since both spellings write a well-formed row. It throws rather than answering a verdict, and
 * `EntitlementsPort.spend`'s never-throw contract is not weakened: this is the caller-bug class
 * the wire contract answers 400 for, reached before any decision, so no money moves. Degrading
 * instead would switch AI off for a whole path with nothing in any log.
 */
export function assertAttemptKey(action: SpendAction, attemptKey: string): void {
  if (attemptKey.length === 0 || attemptKey.length > ATTEMPT_KEY_MAX) {
    throw new Error(
      `assertAttemptKey: the ${action} attempt key is ${attemptKey.length} characters; a key is ` +
      `1..${ATTEMPT_KEY_MAX}. Build it with this module's key functions.`);
  }
  if (!ATTEMPT_KEY_SHAPE.test(attemptKey)) {
    throw new Error(
      `assertAttemptKey: the ${action} attempt key carries a character outside ` +
      "[A-Za-z0-9:_.~@+-]. Build it with this module's key functions.");
  }
  const prefix = SPEND_NAMESPACES.find((ns) => attemptKey.startsWith(`${ns}:`));
  if (prefix !== undefined) {
    throw new Error(
      `assertAttemptKey: the ${action} attempt key already begins with the ledger namespace ` +
      `\`${prefix}:\` — this is a SOURCE where a bare KEY belongs. Composing it would write ` +
      `\`${prefix}:${prefix}:…\`, which passes the namespace CHECK and the UNIQUE, so work that ` +
      "is already paid for would be charged again.");
  }
}

/**
 * `<namespace>:<attemptKey>` — THE ONE PLACE A SPEND SOURCE IS COMPOSED.
 *
 * One function, so the namespace can never disagree with the reason, and so the local adapter
 * and the entitlements program cannot mean different things by `attemptKey`. Everything below
 * that used to build one of the four spend namespaces by hand now comes through here.
 */
export function sourceFor(action: SpendAction, attemptKey: string): string {
  assertAttemptKey(action, attemptKey);
  return `${SPEND_ACTIONS[action].namespace}:${attemptKey}`;
}

/** The work ONE ingest classification is a classification of — the mailbox and its dedup key. */
export function classifyAttemptKey(mailboxId: string, dedupKey: string): string {
  return `${mailboxId}:${shortHash(dedupKey)}`;
}

/** The work ONE Screener pre-suggestion is about. The `screener:` here is part of the KEY, not a
 *  namespace: it is what keeps a pre-suggestion from sharing an ingest classification's source. */
export function screenerAttemptKey(messageId: string): string {
  return `screener:${messageId}`;
}

/** The work ONE AI draft is a draft of: the message, and the client's own intent token. */
export function draftAttemptKey(messageId: string, attemptKey: IdempotencyKey): string {
  return `${messageId}:${shortHash(attemptKey)}`;
}

/** The work ONE workflow step is a step of. */
export function workflowAttemptKey(runId: string, stepIndex: number): string {
  return `${runId}:${stepIndex}`;
}

export const ledgerSources = {
  /* The parameter is the payment processor's invoice id, and the name says `invoice` rather
   * than naming the processor because this file is compiled into the desktop engine, and the
   * engine build censuses that artifact for strings belonging to the hosted half. A parameter
   * name is not a disclosure the way a column name is, but it is free to not ship it, and the
   * census is only useful while it is precise. */
  invoiceGrant: (invoiceId: string) => `invoice:${invoiceId}`,
  periodExpiry: (priorInvoiceId: string) => `expiry:${priorInvoiceId}`,
  classify: (messageId: string) => sourceFor("classify_ingest", messageId),
  /**
   * `attemptKey` MUST be the request's `Idempotency-Key` — hence the {@link IdempotencyKey}
   * brand, which a server-minted uuid cannot satisfy. A key minted per invocation turns a
   * client's same-key retry of a LOST RESPONSE into a second charge; the `Idempotency-Key` is the
   * client's own "one intent" token, and the debit commits atomically with the idempotency claim.
   * The key is HASHED into the source: it is client-controlled and `source` is a btree index key,
   * so an oversized header would raise an index error inside the caller's transaction. sha-256,
   * 32 hex chars. The route wiring requires `POST /messages/:id/draft` to be `idempotent: true`
   * so a key EXISTS at the one call site that needs it.
   */
  draft: (draftId: string, attemptKey: IdempotencyKey) =>
    sourceFor("draft", draftAttemptKey(draftId, attemptKey)),
  propose: (proposalRunId: string) => sourceFor("propose", proposalRunId),
  workflowStep: (runId: string, stepIndex: number) =>
    sourceFor("workflow", workflowAttemptKey(runId, stepIndex)),
  refund: (originalSource: string) => `refund:${originalSource}`,
  admin: (adjustmentId: string) => `admin:${adjustmentId}`,
  /**
   * The trial bounty, keyed by the ACCOUNT and nothing else — idempotent by construction. Every
   * other namespace names the producing system's retry unit; this one names the account, because
   * the event is the account's one trial allowance. `UNIQUE (account_id, source)` makes a second
   * grant unrepresentable — needed, since two callers exist and neither sees the other: the
   * subscription mirror (redelivered, out of order) and the one-shot backfill. Run both, twice
   * each, in any order: the second write answers `duplicate`. Keying by subscription would make a
   * resubscribe a second bounty. The shape is also the DATABASE'S: a BEFORE INSERT trigger
   * refuses a `trial_grant` row whose source is not `'trial:' || account_id`.
   */
  trialGrant: (accountId: string) => `trial:${accountId}`,
} as const;

/**
 * What each metered action costs, in credits — the price list, pinned per reason. This was a flat
 * constant of 1, and that was the defect: a classification reads one message (512-token cap), a
 * draft a whole thread (1 024), a proposer pass a batch (2 048), and a workflow step IS a draft.
 * Under a flat price the allowance had to be sized against the worst mix, so ordinary customers
 * were sold a pool priced for a mix they never ran; pricing the action lets the pool be honest
 * (`billing.ts` `PLAN_LIMITS`; existing rows moved, cloud 0020). The weight is charged where the
 * debit is MINTED: `makeAiCreditGate` defaults `amount` to `aiActionCost(opts.reason)` and no
 * call site passes an `amount`, so there is no second place a price could disagree.
 */
export const AI_ACTION_WEIGHTS = {
  debit_classify: 1,
  debit_draft: 15,
  debit_propose: 20,
  debit_workflow: 15,
} as const;

/**
 * The debit reasons a spend GATE can mint — exactly the keys of {@link AI_ACTION_WEIGHTS}.
 *
 * A strict subset of the ledger's `DebitReason`: `period_expiry`, `setup_expiry` and
 * `adjustment_debit` are debits nobody buys, so they have no price and must not acquire one.
 */
export const WEIGHTED_DEBIT_REASONS = [
  "debit_classify", "debit_draft", "debit_propose", "debit_workflow",
] as const;

export type WeightedDebitReason = keyof typeof AI_ACTION_WEIGHTS;

/**
 * What one action of `reason` costs. The ONE way to price a metered action.
 *
 * Written as a function rather than left as a bare index so the call sites that QUOTE a price to
 * a customer before charging it — `ScreenerService`'s `quotedCredits`, the auto-suggest pass's
 * `charged` tally — name the same thing the gate debits. Those two used to multiply by
 * that single constant, which was correct only while every action cost the same.
 */
export function aiActionCost(reason: WeightedDebitReason): number {
  return AI_ACTION_WEIGHTS[reason];
}

/**
 * The arming guard: refuse to construct a production managed-AI arm while debits are FLAT.
 * "Managed AI must not be armed before the weights land" as a structural check, called from the
 * composition root — prose alone is broken silently by the next revert. It judges the SHAPE, not
 * the numbers: the exact card is pinned by `test/ai-action-weights.test.ts`, and a guard that
 * pinned it too would be a second copy edited on every re-price — how safety checks get deleted.
 * What cannot change without a decision: every priced reason has a price, and the two expensive
 * calls are strictly dearer than the cheap one. Throws rather than returning a boolean: an arm
 * with a flat schedule would meter every draft at a fifteenth of its cost.
 */
export function assertWeightedScheduleActive(
  schedule: Record<WeightedDebitReason, number> = AI_ACTION_WEIGHTS,
): void {
  for (const reason of WEIGHTED_DEBIT_REASONS) {
    const weight = schedule[reason];
    if (!Number.isInteger(weight) || weight <= 0) {
      throw new Error(
        `assertWeightedScheduleActive: ${reason} has no positive integer weight ` +
          `(got ${String(weight)}). Managed AI must not arm against an incomplete schedule — a ` +
          "missing weight makes every action of that kind fail the gate and degrade silently.",
      );
    }
  }
  const classify = schedule.debit_classify;
  if (WEIGHTED_DEBIT_REASONS.every((r) => schedule[r] === classify)) {
    throw new Error(
      "assertWeightedScheduleActive: the debit schedule is FLAT — every action costs " +
        `${classify}. Managed AI must not arm against a flat schedule: a draft costs ~15× a ` +
        "classification in tokens, so a flat price puts the plan allowance underwater at a " +
        "plausible mix while every gate works perfectly.",
    );
  }
  if (schedule.debit_draft <= classify) {
    throw new Error(
      `assertWeightedScheduleActive: a draft is priced at ${schedule.debit_draft} against a ` +
        `classification's ${classify} — a draft reads a whole thread plus the voice profile and ` +
        "must cost strictly more. This is not a weighted schedule.",
    );
  }
  if (schedule.debit_propose <= classify) {
    throw new Error(
      `assertWeightedScheduleActive: a propose pass is priced at ${schedule.debit_propose} ` +
        `against a classification's ${classify} — the proposer reads a BATCH of mail and is the ` +
        "largest-context call in the product. This is not a weighted schedule.",
    );
  }
}

/**
 * The ledger source for ONE classification of ONE message. Keyed by `(mailboxId, dedup_key)`, not
 * message id: at classification time no `messages` row exists yet, and the dedup key is how the
 * pipeline recognises the same mail — per mailbox, so one newsletter in two mailboxes is two
 * charges. Hashed for LENGTH: a `mid:` dedup key carries the sender's `Message-ID` verbatim
 * (remote-controlled, unbounded); `source` is a btree key capped at 200 chars. THE HASH IS NOT A
 * REDACTION: the input is guessable, so a reader of `source` could confirm "this account received
 * this message". The oracle is closed by the GRANT (staff reads a view that truncates the digest)
 * and by never writing the raw key: `meta` carries `{ mailboxId }` alone.
 */
export function classifyLedgerSource(mailboxId: string, dedupKey: string): string {
  return sourceFor("classify_ingest", classifyAttemptKey(mailboxId, dedupKey));
}

/**
 * The ledger source for ONE Screener pre-suggestion of ONE message — the same `classify` reason
 * as the pipeline, a DIFFERENT unit of work, so its own source: sharing one would make whichever
 * ran second free. Keyed by the message, which makes a list page cheap: `list` re-asks for the
 * same held mail on every poll, and a per-message identity answers `duplicate` from the second
 * ask on. It STAYS the message: re-keying on the address would put a remote-controlled, guessable
 * identifier into an append-only record, and one source is what serialises the cron and the
 * button through the exclusive claim. The MESSAGE is the unit of paid work; the SENDER is the
 * unit of automatic entitlement (a query over stored advice, not a ledger concept).
 */
export function screenerLedgerSource(messageId: string): string {
  return sourceFor("screener", screenerAttemptKey(messageId));
}

/** sha-256, first 128 bits, hex — the same shortening `ledgerSources.draft` uses. */
function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
