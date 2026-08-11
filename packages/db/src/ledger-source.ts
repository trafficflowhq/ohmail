import { createHash } from "node:crypto";

/**
 * THE LEDGER-SOURCE VOCABULARY — pure string construction, and nothing else.
 *
 * Every value here is a function of its arguments. There is no table, no transaction, no
 * connection, and no import beyond `node:crypto` — and that emptiness is the point rather than an
 * accident of how the file grew.
 *
 * ── WHY IT IS ITS OWN MODULE ──────────────────────────────────────────────────────────────
 *
 * These names belong to the hosted half conceptually: a ledger source is a credit-ledger concept.
 * But they are CALLED from the mail half — the ingest pipeline labels a classification, the
 * Screener labels a suggestion, the drafting path labels a draft, the HTTP edge brands a
 * client-supplied key — and every one of those modules also runs inside the desktop engine.
 *
 * While these strings lived in `credits.ts` and `ai-gate.ts`, naming one of them imported the
 * module that defined it, and those modules import `billing.js`, `admin-db.js` and the whole
 * Cloud schema. An ESM import edge is not free even when a single binding is used: absent a
 * `sideEffects` declaration a bundler must assume the named module has work to do at load, so it
 * keeps the bytes. That is how a `classify:` template string dragged Stripe, the staff directory
 * and its stored passwords into an artifact a stranger downloads.
 *
 * ── THE RULE THIS FILE EXISTS TO SATISFY ──────────────────────────────────────────────────
 *
 * A module reachable from the desktop engine's import closure may import from
 * `@trafficflow/db/mail` or from a leaf like this one, and from neither the root barrel's
 * connection half nor `@trafficflow/db/cloud`. Keep this file leaf-shaped: if it ever needs a
 * table, then the thing that needs the table belongs somewhere else.
 *
 * `credits.ts` and `ai-gate.ts` re-export every name below, so `@trafficflow/db/cloud` still
 * presents one surface to the code that reads and writes the ledger itself.
 *
 * ── AND IT STAYS ONE REGISTRY ─────────────────────────────────────────────────────────────
 *
 * `ledgerSources` is not split by caller, however tempting that looks from the import side. The
 * database pins each `reason` to its namespace with a CHECK constraint on the ledger's source
 * column, so the object below is the code-side half of that constraint. Two half-registries would let the
 * two drift, and the drift would surface as a constraint violation inside a caller's
 * transaction rather than as a mismatch anyone could read.
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
export const ledgerSources = {
  /* The parameter is the payment processor's invoice id, and the name says `invoice` rather
   * than naming the processor because this file is compiled into the desktop engine, and the
   * engine build censuses that artifact for strings belonging to the hosted half. A parameter
   * name is not a disclosure the way a column name is, but it is free to not ship it, and the
   * census is only useful while it is precise. */
  invoiceGrant: (invoiceId: string) => `invoice:${invoiceId}`,
  periodExpiry: (priorInvoiceId: string) => `expiry:${priorInvoiceId}`,
  classify: (messageId: string) => `classify:${messageId}`,
  /**
   * `attemptKey` MUST be the request's `Idempotency-Key` — hence the {@link IdempotencyKey}
   * brand, which a server-minted `randomUUID()` cannot satisfy without someone writing
   * {@link clientIdempotencyKey} and lying. This corrects an earlier design assumption: a key the
   * server mints fresh per invocation turns a client's same-key retry of a LOST RESPONSE into
   * a second charge, whereas the `Idempotency-Key` is exactly the client's own "this is one
   * intent" token — and the debit is already committed atomically with the idempotency claim.
   *
   * The key is HASHED into the source rather than concatenated raw: it is client-controlled
   * and `source` is a btree index key, so an oversized header would otherwise raise an index
   * error from inside the caller's transaction. sha-256, 32 hex chars (128 bits) — collisions
   * are not a practical concern and the value stays diff-stable and greppable.
   *
   * The route wiring requires `POST /messages/:id/draft` to be marked `idempotent: true` so a
   * key EXISTS at the only call site that needs one.
   */
  draft: (draftId: string, attemptKey: IdempotencyKey) =>
    `draft:${draftId}:${createHash("sha256").update(attemptKey).digest("hex").slice(0, 32)}`,
  propose: (proposalRunId: string) => `propose:${proposalRunId}`,
  workflowStep: (runId: string, stepIndex: number) => `workflow_run:${runId}:${stepIndex}`,
  refund: (originalSource: string) => `refund:${originalSource}`,
  admin: (adjustmentId: string) => `admin:${adjustmentId}`,
  /**
   * THE TRIAL BOUNTY, keyed by the ACCOUNT and by nothing else — idempotent by construction.
   *
   * Every other namespace here names the producing system's retry unit: an invoice, a message, a
   * workflow step. This one names the ACCOUNT, because the economic event is "this account was
   * given its one trial allowance" and there is exactly one of those per account for as long as
   * the account exists. `UNIQUE (account_id, source)` then makes a second grant unrepresentable
   * rather than merely unlikely — which is the property the callers need, since two of them exist
   * and neither can see the other:
   *
   *  · the subscription mirror grants when a trial row first lands, and it runs on EVERY
   *    subscription event for the account, redelivered and out of order;
   *  · the one-shot backfill grants to accounts already trialing when the policy changed.
   *
   * Run both, twice each, in any order: the second write of the four answers `duplicate` and
   * moves no money. Keying this by the subscription instead would have made a resubscribe — or a
   * second trial after a cancel — a second bounty, which is the shape of the giveaway a bounty
   * must not have.
   *
   * The account id is a uuid we minted, so unlike `draft` and `classify` there is nothing
   * remote-controlled to bound or to hash: the source is 6 + 36 characters, always.
   */
  trialGrant: (accountId: string) => `trial:${accountId}`,
} as const;

/**
 * What one AI action costs. The plan card sells "~2 000 / 6 000 / 20 000 AI actions" per month
 * against `monthly_credits` of 2 000 / 6 000 / 20 000, so the exchange rate is 1:1 by
 * construction and this constant is where it would change if a future model tier cost more.
 */
export const AI_ACTION_COST = 1;

/**
 * The ledger source for ONE classification of ONE message — a correction to the earlier registry keying.
 *
 * The earlier keying wrote `classify:<message_id>`, and at the moment the classifier is called there is no
 * message id: `planChange` runs the AI branch only on the `new` outcome, i.e. exactly when no
 * `messages` row exists yet (the row is inserted later, by `commitChange`, in the persist
 * transaction). The identity that DOES exist, and that is stable across every reprocess, is the
 * one the pipeline already uses to recognise the same mail — the `dedup_key`
 * `findByDedupKey` looks up. Scoping it by mailbox mirrors that lookup exactly
 * (`findByDedupKey(mailboxId, key)`), so the same newsletter delivered to two of an account's
 * mailboxes is two classifications and two charges, not one charge and one freebie.
 *
 * The key is HASHED for LENGTH, and for length only: a `mid:` dedup key — the format every
 * row written before the fingerprint-key change carries, and the one this hashing was designed against — contains
 * the sender's `Message-ID` header verbatim, which is remote-controlled and unbounded, while
 * `source` is a btree index key capped at 200 characters. Hashing makes the length a constant
 * 78 characters instead of a property of incoming mail. Since that change the key is `fp1:<sha256>` and
 * therefore already bounded, so the hash is now belt and braces for length — and still load-bearing
 * for one reason: a raw `mid:` key in an append-only table cannot be un-written. `ledgerSources.draft` hashes the
 * client's Idempotency-Key for the same reason.
 *
 * **THE HASH IS NOT A REDACTION, AND THIS COMMENT USED TO SAY OTHERWISE.** It ended
 * "if a debit ever needs to be traced back to a message, resolve it forward — hash the
 * candidate key and compare against `source`". That forward-resolve is exactly the attack: the
 * input is guessable — a sender chooses the `Message-ID` of mail it sends to the account, and a
 * natural client uses the SUBJECT as its Idempotency-Key — so anyone who can read `source` can
 * confirm "this account received this exact message" from a candidate list. 128 bits stops
 * collisions; it adds no entropy to a guessable input.
 *
 * So the forward-resolve is a **break-glass operation for the production owner or the runtime
 * role, never a staff one**, and it is not much of a privilege even then: both of those can
 * read `messages.subject` directly, which is why the oracle is strictly weaker than the access
 * needed to see it and why re-keying under an HMAC would have bought nothing at that privacy
 * boundary. What closed it is the GRANT: the staff role holds nothing on the ledger's own source
 * column, and the view it reads instead truncates the digest away.
 *
 * **The readable form IS lost, deliberately, and that is the point.** This comment used
 * to end "the caller puts `mailboxId` and the raw `dedupKey` in the ledger row's `meta`, which
 * is `jsonb` and indexes nothing" — documenting the leak as a convenience. Indexing nothing is
 * not the property that matters; the ledger is APPEND-ONLY, so a remote-controlled
 * sender/recipient identifier written there is written for good, in backups included. The
 * caller now passes `{ mailboxId }` alone. That destruction is also why the leak could not be fixed
 * by re-keying: with the plaintexts gone, no existing row can ever be re-hashed, so an HMAC
 * going forward would have left the whole historical oracle readable.
 */
export function classifyLedgerSource(mailboxId: string, dedupKey: string): string {
  return ledgerSources.classify(`${mailboxId}:${shortHash(dedupKey)}`);
}

/**
 * The ledger source for ONE Screener pre-suggestion of ONE message.
 *
 * The Screener's Yes/No hint is a `classify` spend like the pipeline's — same model, same
 * reason — but a DIFFERENT unit of work, so it needs a source of its own: the pipeline charges
 * for routing a message on arrival, this charges for advising on a sender already held. Sharing
 * one source would make whichever ran second free.
 *
 * Keyed by the message rather than by the sender or the page, and that is what makes a list
 * page cheap: `list` is re-fetched on every poll, every scroll and every reload, and each of
 * those re-asks for the same held mail. A per-message identity means the second and every later
 * ask answers `duplicate` and costs nothing, so the suggestion is bought once per message and
 * then re-read for free — while a per-request identity would have charged an account with 20
 * held senders 20 credits per page view.
 */
export function screenerLedgerSource(messageId: string): string {
  return ledgerSources.classify(`screener:${messageId}`);
}

/** sha-256, first 128 bits, hex — the same shortening `ledgerSources.draft` uses. */
function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
