/**
 * `attachment_staging` — the hosted send's direct-upload transport: the ROW, the OBJECT, and the
 * retention sweep that has to delete them in one particular order.
 *
 * The table's own reasoning is on {@link attachmentStaging} in `schema-cloud.ts`. This module holds
 * the four statements anything ever runs against it (mint a ticket, read a caller's own tickets,
 * delete a set, select what has aged out), the Supabase Storage client the bytes actually live
 * behind, and {@link sweepExpiredStaging}, which is the two together.
 *
 * ## Why the reads are account-scoped HERE and not at the caller
 *
 * A staging id is a bearer of BYTES — somebody's outgoing attachment. `readStagingTickets` takes
 * the account id and puts it in the `WHERE`, so there is no shape of caller that can ask this
 * module for another account's rows and no reviewer who has to check that every call site
 * remembered. The one function that is NOT account-scoped is {@link expiredStagingTickets}, which
 * is the sweep's, and its predicate is the clock rather than an identity.
 *
 * ## Why the OBJECT half is in `packages/db` and not in `packages/services`
 *
 * It began in `packages/services`, beside the send path that reads a ticket, and the sweep went
 * with it. That put the sweep ABOVE the worker's dependency boundary (the worker's runtime
 * closure is `core` + `db` + drizzle + imapflow + postgres, and nothing else), and the worker's
 * hourly maintenance slot is the only thing that runs it — so `apps/worker/src/index.ts` reached
 * up for it and the boundary had to be widened to keep the image bootable.
 *
 * That widening was measured and it does not hold. With the services barrel in the worker's boot
 * graph, `node` loads an HTML sanitiser and its parser on the way to a retention sweep, and on
 * Node 23 the pair is a hard `ERR_REQUIRE_CYCLE_MODULE` at import time — a CJS `sanitize-html`
 * re-entering an ESM `htmlparser2` mid-evaluation. It boots on the image's pinned Node 22 and dies
 * on Node 23, which means the deployed worker was one base-image bump away from an unloggable
 * crash-on-start for a dependency it has no use for.
 *
 * So the seam moved rather than the boundary. What is HERE is everything the sweep needs and
 * nothing else: the table, the bucket, and the order. What stays in `packages/services` is the
 * SEND-facing half — turning a ticket into a `SendAttachment` and mapping a failed read onto an
 * HTTP status — which is service-shaped by definition and which the worker never calls.
 *
 * A storage client on this entry point is not a layering exception: `@trafficflow/db/cloud` is the
 * hosted half's plumbing rather than SQL alone, and `alerts.ts`'s `webhookAlertSink` — a runtime
 * `fetch` sink the worker itself composes — already sits one file away for the same reason.
 *
 * ## The sweep deletes the OBJECT first
 *
 * Delete the bytes, then the row. Doing it the other way round loses the only record of which
 * object to remove, which is how a staging bucket grows forever behind a table that looks
 * perfectly clean. The two halves are in ONE module so that order has exactly one implementation
 * and no import boundary a future caller could compose across in the wrong direction.
 *
 * ## THE TWO BOUNDS, AND WHY NEITHER ONE SUFFICES ALONE
 *
 * Everything above describes a transport with no ceiling on it. Until the quota fix the mint
 * refused exactly one thing — a single file larger than the sending mailbox's announced `SIZE` —
 * and the sweep took one 200-row page an hour. Both halves of that are unbounded in the direction
 * that costs money:
 *
 *  · an email-verified account could hold any number of staged objects at once, so the bucket's
 *    size was a function of how many times somebody chose to call the route;
 *  · above 200 mints an hour the expired backlog grew for ever, and because the sweep's predicate
 *    is the CLOCK and not an identity, one account minting fast starved cleanup for every other
 *    account on the deployment.
 *
 * The fix is two independent bounds, and they are independent on purpose:
 *
 *  · {@link createStagingTicketWithinQuota} caps what ONE ACCOUNT may hold outstanding, in tickets
 *    and in declared bytes. That makes the per-account footprint finite at any instant, and —
 *    because a ticket's only exit is expiry — it also makes the per-account MINT RATE finite:
 *    {@link STAGING_MAX_OUTSTANDING_TICKETS} per {@link ATTACHMENT_STAGING_TTL_MS}, and no more.
 *  · {@link drainExpiredStaging} deletes until the expired set is empty rather than taking one
 *    page and stopping, under a per-invocation ceiling chosen to beat that mint rate across far
 *    more accounts than this deployment has.
 *
 * The quota alone would still let a large enough population outrun a single-page sweep. The drain
 * alone would still let one account fill a bucket with a burst. Together the arithmetic closes:
 * see {@link STAGING_SWEEP_MAX_ROWS} for the sum.
 *
 * **The quota counts only UNEXPIRED tickets, and that decoupling is load-bearing.** Counting
 * expired-but-unswept rows would feed sweep health back into the mint: a deployment whose bucket
 * was briefly unreachable would start refusing honest uploads because its own cleanup was behind,
 * which converts a storage incident into a product outage. Expiry is a promise about the BYTES;
 * quota is a statement about what an account may hold. They are allowed to be temporarily out of
 * step, and the sweep is what closes the gap.
 */
import { AwsClient } from "aws4fetch";
import { and, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { attachmentStaging } from "./schema-cloud.js";
import { assertLedgerTx, type LedgerTx, type Tx } from "./change-log.js";

/**
 * HOW LONG STAGED BYTES LIVE. 24 hours, and it is a PROMISE rather than a tuning knob: the
 * privacy copy states this number, so moving it is a change to what the product tells people
 * about their mail.
 *
 * It is long enough that a send retried after a network outage still finds its bytes (the send
 * route re-reads the ticket on every attempt under the same idempotency key) and short enough
 * that "transiently" is an honest word for it. The same 24 hours `idempotency_keys` already
 * promises, for the same reason: one is the window a retry may happen in, and these are the bytes
 * that retry needs.
 */
export const ATTACHMENT_STAGING_TTL_MS = 24 * 60 * 60 * 1000;

/** `expires_at` for a ticket minted now. */
export function attachmentStagingExpiry(now: Date): Date {
  return new Date(now.getTime() + ATTACHMENT_STAGING_TTL_MS);
}

export interface StagingTicketInput {
  /**
   * THE ID, MINTED BY THE CALLER. Not a database default, deliberately: the object path is derived
   * from the id, and a caller that had to wait for the insert to learn its id would have to write
   * the row twice — once with a placeholder path and once with the real one. Handing the id in
   * makes the row correct on its first and only write.
   */
  id: string;
  accountId: string;
  objectPath: string;
  filename: string;
  contentType: string;
  /** The DECLARED size, already refused against the cap by the caller. */
  sizeBytes: number;
  now: Date;
}

/** One staged ticket as every reader sees it. */
export interface StagingTicket {
  id: string;
  objectPath: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  expiresAt: Date;
}

/**
 * Mint a ticket. The row exists BEFORE the signed URL is handed out, and that order is the one
 * that cannot leak an object: an object whose row was never written is an object nothing knows the
 * path of, so {@link sweepExpiredStaging} can never find it and it lives in the bucket for the life
 * of the deployment. A row whose signed URL then failed to mint is the harmless direction — it
 * names an object that does not exist, the caller got an error, and the sweep deletes a row and a
 * storage 404, which {@link makeSupabaseStagingStorage}'s `remove` treats as success precisely so
 * that this case clears. The caller that performs the two steps in that order is the staging port
 * in `@trafficflow/services`; the reason is here because both halves it composes are here.
 */
export async function createStagingTicket(tx: Tx, i: StagingTicketInput): Promise<StagingTicket> {
  const [row] = await tx.insert(attachmentStaging).values({
    id: i.id,
    accountId: i.accountId,
    objectPath: i.objectPath,
    filename: i.filename,
    contentType: i.contentType,
    sizeBytes: i.sizeBytes,
    createdAt: i.now,
    expiresAt: attachmentStagingExpiry(i.now),
  }).returning({
    id: attachmentStaging.id,
    objectPath: attachmentStaging.objectPath,
    filename: attachmentStaging.filename,
    contentType: attachmentStaging.contentType,
    sizeBytes: attachmentStaging.sizeBytes,
    expiresAt: attachmentStaging.expiresAt,
  });
  if (!row) throw new Error("attachment staging ticket insert returned no row");
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE PER-ACCOUNT QUOTA. See the module header for why there are two bounds.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * HOW MANY STAGED TICKETS ONE ACCOUNT MAY HOLD AT ONCE — 500, which is five maximal composes.
 *
 * The legitimate ceiling on one message is `SEND_MAX_ATTACHMENT_PARTS` = 100 parts
 * (`packages/services/src/send-service.ts`), so a single compose can never need more than 100
 * tickets. The obvious quota is therefore "two composes in flight" — one being assembled, one
 * being retried — and it would be WRONG here, for a reason that is a property of this table
 * rather than of the compose surface:
 *
 * **A SEND DOES NOT CONSUME A TICKET.** There is no `consumed_at` and that is deliberate (see
 * `attachmentStaging` in `schema-cloud.ts`): a send retried under the same idempotency key has to
 * find the same bytes. So a ticket's only exit is expiry, and the quota is not "how much may be
 * in flight" but "how much may be staged in a 24-hour window". Two composes' worth would refuse
 * an account on its third large message of the day.
 *
 * 500 is five maximal composes, or — closer to how anyone actually sends — twenty-five heavy
 * messages of twenty files each, per day. Nothing about ordinary use approaches it: the staged
 * transport does not engage below 3 MB of attachments at all (`SEND_INLINE_MAX_TOTAL_BYTES`), so
 * small mail never mints a ticket.
 *
 * What it buys is that the per-account mint rate is now a NUMBER: 500 per
 * {@link ATTACHMENT_STAGING_TTL_MS}, ≈ 20.8 rows an hour, whatever the caller does. That number
 * is the input to the sweep's arithmetic in {@link STAGING_SWEEP_MAX_ROWS}.
 */
export const STAGING_MAX_OUTSTANDING_TICKETS = 500;

/**
 * HOW MANY DECLARED BYTES ONE ACCOUNT MAY HOLD AT ONCE — 1 GiB.
 *
 * The count bound above says nothing about size, and size is what the storage bill is. 1 GiB is
 * roughly forty maximal 25 MB sends inside one retention window, which is far beyond any honest
 * use of a compose form and still a finite, small amount of griefable storage: an account holding
 * its full quota continuously costs on the order of two cents a month at commodity object-storage
 * rates.
 *
 * ── IT ALSO CLOSES THE ONE AMPLIFIER THE PER-FILE CAP CANNOT ────────────────────────────────
 *
 * The mint's per-file ceiling is `effectiveAttachmentCap(null, mailbox.smtpMaxSizeBytes)` — the
 * RFC 1870 `SIZE` the sending mailbox's own submission server announced. That number is not ours:
 * a caller may add a mailbox pointed at a server it controls, have it announce `SIZE 10000000000`,
 * and the connect probe records it faithfully (mail 0055 stores `bigint` precisely because the
 * announcement is somebody else's number). The per-file check would then admit a 10 GB
 * declaration. This bound refuses it regardless of what any server said, because it is a fact
 * about what WE are willing to host rather than about what the recipient's server will accept.
 *
 * ── WHAT IT DOES NOT BOUND, STATED HONESTLY ─────────────────────────────────────────────────
 *
 * It counts DECLARED bytes. The signed upload grant binds content type and `x-upsert: false` and
 * no length (`makeSupabaseStagingStorage.signUpload` posts a literal `"{}"`), so a client may
 * declare one byte and PUT more. The send path catches that — `resolveStagedAttachments`
 * re-measures every object against its ticket and refuses the send — but the BYTES are in the
 * bucket by then, held until expiry. The control for that half is the bucket's own
 * `file_size_limit`, which is storage configuration and not code — the operator half of this
 * fix, recorded in the operations checklist. What the
 * declared-byte quota bounds on its own is the number of objects and the authorization to create
 * them, which is what {@link STAGING_MAX_OUTSTANDING_TICKETS} then makes finite.
 */
export const STAGING_MAX_OUTSTANDING_BYTES = 1024 * 1024 * 1024;

/**
 * The `classid` half of the mint's `pg_advisory_xact_lock(int4, int4)` key. The second half is
 * `hashtext(account_id)`, so the lock is per account and mints for different accounts never queue
 * behind each other.
 *
 * It shares the `4207270…` prefix `LEADER_LOCK_KEY` (`apps/worker/src/leader-lock.ts`) uses, so
 * the project's advisory keys read as one family, and it fits `int4`. It cannot collide with
 * either existing single-argument key (the migration lock, the leader lock): Postgres keeps the
 * one-argument `bigint` form and the two-argument `(int4, int4)` form in separate keyspaces —
 * they are distinguished by `objsubid` in `pg_locks` — so the two forms cannot alias even on
 * numerically equal keys.
 */
export const STAGING_QUOTA_LOCK_CLASS = 420_727_015;

/** What one account is allowed to hold staged at once. Injectable so tests can shrink it. */
export interface StagingQuota {
  maxTickets: number;
  maxBytes: number;
}

/** The product's quota. */
export const DEFAULT_STAGING_QUOTA: StagingQuota = {
  maxTickets: STAGING_MAX_OUTSTANDING_TICKETS,
  maxBytes: STAGING_MAX_OUTSTANDING_BYTES,
};

/** What an account is holding right now — UNEXPIRED tickets only. */
export interface StagingUsage {
  tickets: number;
  bytes: number;
}

/** Why a mint was refused, with the numbers a caller needs to say something actionable. */
export type StagingQuotaRefusal =
  | { limit: "tickets"; outstanding: number; cap: number }
  | { limit: "bytes"; outstanding: number; requested: number; cap: number };

/**
 * What `accountId` holds staged and UNEXPIRED as of `now`.
 *
 * Expired rows are excluded whether or not the sweep has reached them — see the module header for
 * why that decoupling is the whole point rather than an approximation.
 */
export async function outstandingStagingUsage(
  tx: Tx, accountId: string, now: Date,
): Promise<StagingUsage> {
  const [row] = await tx.select({
    // `count(*)` and `sum(bigint)` both come back from postgres-js as STRINGS. The `::int` cast
    // makes the count a number at the wire; the sum stays `bigint` (a declared size may exceed
    // 2^31 — that is why the column is bigint at all) and is narrowed here. Both totals are far
    // below 2^53 by construction: the quota that reads them is 1 GiB.
    tickets: sql<number>`count(*)::int`,
    bytes: sql<string>`coalesce(sum(${attachmentStaging.sizeBytes}), 0)::bigint`,
  }).from(attachmentStaging)
    .where(and(
      eq(attachmentStaging.accountId, accountId),
      gt(attachmentStaging.expiresAt, now),
    ));
  return { tickets: Number(row?.tickets ?? 0), bytes: Number(row?.bytes ?? 0) };
}

/**
 * MINT A TICKET IF THE ACCOUNT IS UNDER QUOTA — the check and the insert in ONE transaction,
 * behind a per-account lock (the quota fix).
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE LOCK STORY
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A quota is an AGGREGATE over rows the same statement is about to add to, which is the classic
 * shape that a plain read-then-write gets wrong. Under READ COMMITTED each concurrent mint takes
 * its snapshot at the start of its own `SELECT`, so N simultaneous requests all read the same
 * pre-state, all find themselves under quota, and all insert. The overshoot is bounded by
 * concurrency rather than by the cap — exactly the suspension-race lesson, where a gate read a fact
 * and then acted on it after other transactions had changed it.
 *
 * There is no row to lock: the thing being bounded is a COUNT, and the empty case (an account
 * with no tickets at all) has no tuple for two callers to contend on. So the mutex is a
 * transaction-scoped ADVISORY lock keyed on the account —
 * `pg_advisory_xact_lock(STAGING_QUOTA_LOCK_CLASS, hashtext(account_id))` — taken FIRST, before
 * the aggregate is read. Every mint for one account is then serialized, the count each one reads
 * is the count its own insert extends, and the cap is exact rather than probabilistic.
 *
 * ### Why an advisory lock is right HERE and was refused in `ai-claim.ts`
 *
 * `claimAiAttempt` rejected `pg_advisory_xact_lock` for a reason that does not apply to this
 * path: it needed exclusivity to OUTLIVE the commit, because the thing it guards is a model call
 * made after the transaction ends. This mint needs exclusivity only for the length of a count and
 * an insert, both indexed and both local — the signed-URL round trip happens strictly AFTER the
 * transaction commits, and must, because holding a lock across a network call is how a slow
 * storage endpoint becomes a per-account stall. `pg_advisory_xact_lock` releasing at COMMIT is
 * therefore the property this caller wants rather than the one that disqualified it there. It is
 * also pooler-safe for the same reason: nothing is held across statements outside a transaction,
 * so a transaction-pooling connection pooler cannot lose it.
 *
 * ### Deadlock-freedom, by the stronger argument
 *
 * `spend-lock.ts` states the project's rule — a consistent order — and notes that a shared-single-
 * lock argument is stronger where it is available. It is available here: the mint transaction
 * takes exactly TWO things, in this order, and nothing else takes them in the other order.
 *
 *  1. the advisory key for its own account. No other statement in the product takes this key —
 *     it is used by this function alone, and only ever for one account per transaction;
 *  2. the `INSERT`'s ordinary locks: `RowExclusive` on `attachment_staging`, and `FOR KEY SHARE`
 *     on the `accounts` row the foreign key references.
 *
 * Nothing that locks an `accounts` row goes on to mint, so no transaction wants (2) before (1);
 * and two mints for DIFFERENT accounts share neither, because the advisory key is per account and
 * the `FOR KEY SHARE` is per row. Two mints for the SAME account share only (1), and a single
 * shared lock cannot form a cycle.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Returns the refusal rather than throwing it. The two limits are distinguishable in the result
 * because the copy a user reads has to be different — "too many uploads" and "too many bytes" are
 * different situations with different remedies, and a single opaque 429 is the shape of refusal
 * nobody can act on. Mapping to a status is the service layer's job, not this module's.
 */
export async function createStagingTicketWithinQuota(
  tx: LedgerTx,
  i: StagingTicketInput,
  quota: StagingQuota = DEFAULT_STAGING_QUOTA,
): Promise<{ ok: true; ticket: StagingTicket } | { ok: false; refusal: StagingQuotaRefusal }> {
  // A lock taken on an autocommit handle is released at the end of its own statement and
  // serializes nothing, which would leave the quota exactly as racy as no lock at all — and it
  // would look correct in every single-threaded test.
  assertLedgerTx(tx, "createStagingTicketWithinQuota");

  await tx.execute(sql`
    select pg_advisory_xact_lock(
      ${STAGING_QUOTA_LOCK_CLASS}::int4,
      hashtext(${i.accountId}::text)::int4
    )
  `);

  const usage = await outstandingStagingUsage(tx, i.accountId, i.now);
  if (usage.tickets >= quota.maxTickets) {
    return { ok: false, refusal: { limit: "tickets", outstanding: usage.tickets, cap: quota.maxTickets } };
  }
  if (usage.bytes + i.sizeBytes > quota.maxBytes) {
    return {
      ok: false,
      refusal: {
        limit: "bytes", outstanding: usage.bytes, requested: i.sizeBytes, cap: quota.maxBytes,
      },
    };
  }
  return { ok: true, ticket: await createStagingTicket(tx, i) };
}

/**
 * The caller's OWN tickets, by id. Rows belonging to another account, and ids that name nothing,
 * are simply absent from the result — the caller compares lengths and refuses, which is one
 * answer for "not yours" and "not there" and therefore no existence oracle.
 *
 * EXPIRY IS NOT FILTERED HERE, deliberately. A row past `expires_at` whose object the sweep has
 * not reached yet is a ticket whose bytes may or may not still exist, and the send must be able to
 * tell "your upload expired" from "that was never yours". The send route compares `expiresAt`
 * against its own clock and says so; a filter here would collapse both into a 404.
 */
export async function readStagingTickets(
  tx: Tx, accountId: string, ids: readonly string[],
): Promise<StagingTicket[]> {
  if (ids.length === 0) return [];
  return tx.select({
    id: attachmentStaging.id,
    objectPath: attachmentStaging.objectPath,
    filename: attachmentStaging.filename,
    contentType: attachmentStaging.contentType,
    sizeBytes: attachmentStaging.sizeBytes,
    expiresAt: attachmentStaging.expiresAt,
  }).from(attachmentStaging)
    .where(and(
      eq(attachmentStaging.accountId, accountId),
      inArray(attachmentStaging.id, [...ids]),
    ));
}

/** One aged-out ticket as the sweep sees it. `expiresAt` is the drain's paging cursor. */
export interface ExpiredStagingTicket {
  id: string;
  objectPath: string;
  expiresAt: Date;
}

/**
 * Everything that has aged out, OLDEST FIRST, bounded, optionally starting after a cursor.
 *
 * The per-call BOUND is not politeness: the sweep issues one storage delete per batch and runs
 * inside the worker's serial maintenance slot, so an unbounded single statement on a busy
 * deployment would hold that slot against a mailbox that wants to sync. It is a PAGE size, though,
 * not a retention budget — {@link drainExpiredStaging} is what keeps calling until there is
 * nothing left, and before the quota fix nothing did.
 *
 * ── THE ORDER IS TOTAL, AND `after` IS WHY ───────────────────────────────────────────────────
 *
 * `ORDER BY expires_at` alone is not a stable order: ties are common (a compose window mints a
 * dozen tickets inside the same millisecond) and Postgres may return them in any order, so a
 * cursor built on `expires_at` alone could skip rows or loop on them. `id` breaks the tie and the
 * cursor is the pair.
 *
 * The cursor exists for exactly one case, and it is the case that would otherwise wedge the whole
 * transport: a page whose OBJECT delete fails permanently keeps its rows, and those rows are the
 * oldest ones, so a drain that always restarted from the beginning would re-attempt the same
 * poisoned page for ever and never reach anything behind it. {@link drainExpiredStaging} advances
 * past every page it has attempted, which turns one unremovable object from a permanent global
 * stall into a bounded per-hour retry.
 */
export async function expiredStagingTickets(
  tx: Tx, now: Date, limit: number,
  after: { expiresAt: Date; id: string } | null = null,
): Promise<ExpiredStagingTicket[]> {
  const aged = lte(attachmentStaging.expiresAt, now);
  return tx.select({
    id: attachmentStaging.id,
    objectPath: attachmentStaging.objectPath,
    expiresAt: attachmentStaging.expiresAt,
  }).from(attachmentStaging)
    .where(after
      // ISO strings with explicit casts rather than Date objects: postgres-js has serialized a
      // Date as TEXT inside a template before (`migrate.ts` records the family), and a row
      // comparison is the one place that would silently compare the wrong things.
      ? and(aged, sql`(${attachmentStaging.expiresAt}, ${attachmentStaging.id}) > (${after.expiresAt.toISOString()}::timestamptz, ${after.id}::uuid)`)
      : aged)
    .orderBy(attachmentStaging.expiresAt, attachmentStaging.id)
    .limit(limit);
}

/** Delete tickets by id. Returns how many rows went. */
export async function deleteStagingTickets(tx: Tx, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const gone = await tx.delete(attachmentStaging)
    .where(inArray(attachmentStaging.id, [...ids]))
    .returning({ id: attachmentStaging.id });
  return gone.length;
}

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE OBJECT HALF. See the module header for why it is here rather than beside the send path.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Where the bucket lives and what may talk to it. */
export interface AttachmentStagingStorageConfig {
  /** `https://<ref>.supabase.co` — no trailing slash, no `/storage/v1`. */
  url: string;
  /**
   * The SERVICE-ROLE key. It is the only credential that reaches this bucket: the bucket is
   * private, has no public read, and no anon-key policy grants anything on it. The browser never
   * sees this — it receives a signed URL minted with it, scoped to one object and one upload.
   */
  serviceKey: string;
  /** The dedicated staging bucket. Never a bucket anything else writes to. */
  bucket: string;
}

/** Failure of a storage call, carrying the status so a caller can tell "misconfigured" from "gone". */
export class AttachmentStagingStorageError extends Error {
  constructor(readonly operation: string, readonly status: number, message: string) {
    super(`attachment staging ${operation} failed (${status}): ${message}`);
    this.name = "AttachmentStagingStorageError";
  }
}

/** The three storage calls, as an injectable port so tests can drive the whole path with no network. */
export interface AttachmentStagingStorage {
  /** Mint a signed, single-object upload grant. */
  signUpload(objectPath: string, contentType: string): Promise<{
    uploadUrl: string; uploadMethod: string; uploadHeaders: Record<string, string>;
  }>;
  /** Read an object's bytes with the service credential. */
  download(objectPath: string): Promise<Uint8Array>;
  /** Remove objects. Best-effort by contract: a path that is already gone is not an error. */
  remove(objectPaths: readonly string[]): Promise<void>;
}

const STORAGE_PREFIX = "/storage/v1";

/**
 * The Supabase Storage implementation.
 *
 * `signUpload` returns the token-bearing URL and the exact headers the browser must present. The
 * signed-upload endpoint authenticates by the `token` query parameter, so no credential of ours
 * travels to the browser and none is needed on the PUT — `x-upsert: false` is there so a second
 * upload to the same path is refused rather than silently replacing bytes a send may already have
 * read.
 *
 * ## Why the wire is plain `fetch`
 *
 * Supabase Storage is an HTTP API and this needs four calls of it. A client library would be a new
 * dependency in two hosted processes for `POST`, `PUT`, `GET`, `DELETE` — and `supabase-lockdown.ts`
 * in this same package already reaches the same project over plain `fetch` for the same reason.
 *
 * VERIFY THIS ROUND TRIP ON THE FIRST DEPLOY. It is four HTTP shapes against a service we cannot
 * reach from the test environment, and the failure mode of getting one wrong is a mint that
 * answers 200 with a URL that refuses the upload. {@link sweepExpiredStaging} and the send path
 * both degrade safely (a failed download refuses the send; a failed delete retries next hour), but
 * the mint does not fail closed on the CLIENT's behalf — it fails at upload time, one step later.
 */
export function makeSupabaseStagingStorage(
  cfg: AttachmentStagingStorageConfig,
  fetchImpl: typeof fetch = fetch,
): AttachmentStagingStorage {
  const base = `${cfg.url.replace(/\/+$/, "")}${STORAGE_PREFIX}`;
  const auth = {
    authorization: `Bearer ${cfg.serviceKey}`,
    apikey: cfg.serviceKey,
  };
  const enc = (p: string): string => p.split("/").map(encodeURIComponent).join("/");

  return {
    async signUpload(objectPath, contentType) {
      const res = await fetchImpl(
        `${base}/object/upload/sign/${encodeURIComponent(cfg.bucket)}/${enc(objectPath)}`,
        { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}" },
      );
      if (!res.ok) {
        throw new AttachmentStagingStorageError("sign", res.status, await res.text().catch(() => ""));
      }
      const body = (await res.json()) as { url?: unknown };
      const rel = typeof body.url === "string" ? body.url : "";
      if (!rel) throw new AttachmentStagingStorageError("sign", res.status, "no signed url in response");
      return {
        // The response's `url` is relative to the storage root and already carries `?token=`.
        uploadUrl: rel.startsWith("http") ? rel : `${base}${rel.startsWith("/") ? "" : "/"}${rel}`,
        uploadMethod: "PUT",
        uploadHeaders: { "content-type": contentType, "x-upsert": "false" },
      };
    },

    async download(objectPath) {
      const res = await fetchImpl(
        `${base}/object/${encodeURIComponent(cfg.bucket)}/${enc(objectPath)}`,
        { method: "GET", headers: auth },
      );
      if (!res.ok) {
        throw new AttachmentStagingStorageError("download", res.status, await res.text().catch(() => ""));
      }
      return new Uint8Array(await res.arrayBuffer());
    },

    async remove(objectPaths) {
      if (objectPaths.length === 0) return;
      const res = await fetchImpl(`${base}/object/${encodeURIComponent(cfg.bucket)}`, {
        method: "DELETE",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ prefixes: [...objectPaths] }),
      });
      // 404 is SUCCESS here: the sweep's job is "these bytes are gone", and bytes that were never
      // written satisfy it. Anything else is a real failure and keeps the row for the next pass.
      if (!res.ok && res.status !== 404) {
        throw new AttachmentStagingStorageError("remove", res.status, await res.text().catch(() => ""));
      }
    },
  };
}

/** Where an S3-compatible staging bucket lives and what may talk to it. Parsed from the frozen
 *  `S3_*` variable set by the self-host server's config loader; the names here match those. */
export interface S3StagingStorageConfig {
  /** `https://s3.<region>.amazonaws.com`, or the operator's own endpoint (`http://minio:9000`,
   *  a reverse-proxied path). Scheme, host, port and any base path are all honoured. */
  endpoint: string;
  /** The SigV4 signing region. MinIO accepts whatever it was started with (`us-east-1` default). */
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** The dedicated staging bucket. Never a bucket anything else writes to. */
  bucket: string;
  /**
   * The endpoint a BROWSER can reach, used ONLY to build `signUpload`'s URL — `S3_PUBLIC_ENDPOINT`
   * on the self-host server, defaulted there to `OHMAIL_ORIGIN`. Absent ⇒ {@link endpoint}.
   *
   * It exists because the two audiences of this port live on different networks: `download` and
   * `remove` run in the server processes, which reach the store by its in-network name
   * (`http://minio:9000`), while the presigned PUT is performed by a browser, which cannot
   * resolve that name and whose CSP (`connect-src 'self'`) refuses any off-origin request
   * anyway. So the upload grant is addressed — and therefore SIGNED, since SigV4 covers the
   * `Host` header — against the browser-facing origin, and the reverse proxy carries the PUT to
   * the store with the Host PRESERVED, which is what keeps the signature valid end to end.
   * The store's own view of the request is path-style (`/<bucket>/<key>` under a host that is
   * not the store's), which every S3-compatible accepts and MinIO validates against the exact
   * Host the proxy handed it.
   *
   * SECURITY INVARIANT, stated where the surface is minted: routing `/<bucket>/*` through the
   * public origin is safe ONLY while the bucket stays PRIVATE — an unsigned request must 403.
   * No anonymous bucket policy, ever; the boot smoke probes exactly that.
   */
  publicEndpoint?: string;
}

/**
 * How long a presigned PUT grant is honoured, in seconds — 1 hour.
 *
 * Deliberately much shorter than {@link ATTACHMENT_STAGING_TTL_MS}: the TTL is a promise about
 * the BYTES ("staged transiently, held 24 hours"), while this is the window in which the grant's
 * holder may still write them. A compose uploads the moment the grant is minted, so an hour is
 * generous for a slow link and small enough that a leaked grant URL goes stale the same
 * afternoon. It also bounds the overwrite window stated on {@link makeS3StagingStorage}.
 */
export const S3_UPLOAD_GRANT_TTL_SECONDS = 3600;

/**
 * The object URL for one staged file — and the ADDRESSING DECISION, which is the part that can
 * silently break: SigV4 signs the `Host` header, so path-style vs virtual-host is baked into
 * every signature this module mints, and the wrong choice is a 403 on every request rather than
 * anything self-describing.
 *
 * The rule is ENDPOINT-DRIVEN, because the frozen `S3_*` variable set has no style flag and must
 * not grow one for a property the endpoint already determines:
 *
 *  · a real AWS endpoint (`…amazonaws.com`) takes VIRTUAL-HOST style — the bucket as a host
 *    label — which is the only style AWS still promises for new buckets;
 *  · everything else (MinIO on an IP, an operator hostname, a reverse-proxied base path) takes
 *    PATH-STYLE, which every S3-compatible speaks and which is the only style that works at all
 *    for an endpoint whose TLS certificate does not cover `<bucket>.<host>`;
 *  · a DOTTED bucket name falls back to path-style even on AWS: `staging.ohmail.s3.….com` is not
 *    covered by AWS's `*.s3.<region>.amazonaws.com` wildcard, so virtual-host would fail TLS
 *    before S3 ever saw the request.
 *
 * Key segments are individually percent-encoded, exactly like the Supabase impl's `enc` — keys
 * here are ids by construction ({@link stagingObjectPath}), but a URL builder must not trust that.
 */
export function s3StagingObjectUrl(
  cfg: Pick<S3StagingStorageConfig, "endpoint" | "bucket">, objectPath: string,
): string {
  const u = new URL(cfg.endpoint);
  const basePath = u.pathname.replace(/\/+$/, "");
  const key = objectPath.split("/").map(encodeURIComponent).join("/");
  const awsHosted = /(^|\.)amazonaws\.com$/.test(u.hostname.toLowerCase());
  const dnsSafeBucket = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(cfg.bucket);
  if (awsHosted && dnsSafeBucket && basePath === "") {
    return `${u.protocol}//${cfg.bucket}.${u.host}/${key}`;
  }
  return `${u.protocol}//${u.host}${basePath}/${encodeURIComponent(cfg.bucket)}/${key}`;
}

/**
 * The S3-compatible implementation of the SAME three-method port — MinIO on the self-host
 * compose, or any endpoint speaking the S3 API. SigV4 via `aws4fetch` (MIT, zero dependencies),
 * chosen over an AWS SDK for the Supabase impl's exact reason: this needs three HTTP shapes, and
 * a client library would be a dependency tree in two server processes for `PUT`, `GET`, `DELETE`.
 *
 * ## The grant is minted LOCALLY, and the error asymmetry that buys
 *
 * Unlike the Supabase impl — whose `signUpload` asks the storage service for a token and can
 * therefore fail at mint time — a presigned S3 PUT is pure key derivation: `signUpload` cannot
 * detect a wrong credential, a missing bucket or an unreachable endpoint. Every misconfiguration
 * surfaces at UPLOAD time as the client's 403, one step later than the Supabase deployment sees
 * it. The mint's ordering already makes that the harmless direction (a row whose object never
 * arrives is swept as a 404), but it moves the "VERIFY THE ROUND TRIP ON FIRST DEPLOY" note from
 * advisable to mandatory — which is exactly what the live MinIO suite and the compose boot-smoke
 * do on every push.
 *
 * The grant BINDS the content type: it is signed into `X-Amz-SignedHeaders`, so the PUT must
 * present it verbatim or the signature fails — parity with the Supabase grant. What it does NOT
 * have is an `x-upsert: false` equivalent: a plain S3 PUT overwrites. Stated honestly rather
 * than papered over with `If-None-Match: *` (real AWS and current MinIO accept that conditional
 * write; enough S3-compatibles still in service do not, and a grant that 501s on the operator's
 * store is a broken product, not a hardening): the exposure is one account re-PUTting its OWN
 * ticket's path inside the grant hour — the path is `<accountId>/<ticketId>` with a fresh ticket
 * per grant, no other account is ever granted it, and the send re-measures whatever bytes are
 * there against the ticket's declared size.
 *
 * ## Deletes are per-object, not the multi-object POST
 *
 * S3's batch delete (`POST /?delete`) wants an XML body and a `Content-MD5` header — two wire
 * formats this module otherwise never speaks — and MinIO and AWS both answer per-object DELETEs
 * cheaply. The sweep hands pages of up to 200 paths; they go out in bounded parallel batches. A
 * DELETE of a key that is already gone answers 204 on S3 proper, and 404 from some compatibles —
 * BOTH are success here, for the Supabase impl's reason (the abandoned upload must clear) and
 * because deletes must stay idempotent: a page that half-failed keeps its rows, and next hour's
 * drain re-deletes objects that already went.
 */
export function makeS3StagingStorage(
  cfg: S3StagingStorageConfig,
  fetchImpl: typeof fetch = fetch,
): AttachmentStagingStorage {
  const client = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: cfg.region,
    // Retries belong to callers (the sweep retries by keeping rows; the send by failing the
    // request) — a transport that retried on its own would hold locksteps nobody asked for.
    retries: 0,
  });
  const urlFor = (objectPath: string): string => s3StagingObjectUrl(cfg, objectPath);
  // The upload grant alone is addressed at the BROWSER-facing endpoint (see the config field's
  // header): the URL is built against it BEFORE signing, so the SigV4 `Host` in the signature is
  // the host the browser will actually present through the proxy.
  const uploadUrlFor = (objectPath: string): string =>
    s3StagingObjectUrl({ endpoint: cfg.publicEndpoint ?? cfg.endpoint, bucket: cfg.bucket }, objectPath);
  const DELETE_BATCH = 16;

  return {
    async signUpload(objectPath, contentType) {
      const url = new URL(uploadUrlFor(objectPath));
      url.searchParams.set("X-Amz-Expires", String(S3_UPLOAD_GRANT_TTL_SECONDS));
      // `allHeaders: true` is what signs `content-type` (aws4fetch skips it by default), which
      // is what makes the grant refuse a PUT that lies about its type.
      const signed = await client.sign(url.toString(), {
        method: "PUT",
        headers: { "content-type": contentType },
        aws: { signQuery: true, allHeaders: true },
      });
      return {
        uploadUrl: signed.url,
        uploadMethod: "PUT",
        uploadHeaders: { "content-type": contentType },
      };
    },

    async download(objectPath) {
      const req = await client.sign(urlFor(objectPath), { method: "GET" });
      const res = await fetchImpl(req);
      if (!res.ok) {
        throw new AttachmentStagingStorageError("download", res.status, await res.text().catch(() => ""));
      }
      return new Uint8Array(await res.arrayBuffer());
    },

    async remove(objectPaths) {
      for (let i = 0; i < objectPaths.length; i += DELETE_BATCH) {
        await Promise.all(objectPaths.slice(i, i + DELETE_BATCH).map(async (p) => {
          const req = await client.sign(urlFor(p), { method: "DELETE" });
          const res = await fetchImpl(req);
          // 204 is S3's answer for present AND absent keys; 404 is some compatibles' answer for
          // absent ones. Both mean what the sweep needs: these bytes are gone.
          if (!res.ok && res.status !== 404) {
            throw new AttachmentStagingStorageError("remove", res.status, await res.text().catch(() => ""));
          }
          // Drain so keep-alive sockets are reusable across a 200-path page.
          await res.arrayBuffer().catch(() => {});
        }));
      }
    },
  };
}

/**
 * The object path for one staged file: `<accountId>/<ticketId>`.
 *
 * ACCOUNT-PREFIXED and otherwise ONLY IDS. The filename never enters the path — a user-supplied
 * name in an object key is a traversal and a header-injection surface for no benefit, since the
 * name the recipient sees comes off the row. The account prefix is what makes a bucket listing
 * legible to an operator and what a future per-account storage policy would key on.
 */
export function stagingObjectPath(accountId: string, ticketId: string): string {
  return `${accountId}/${ticketId}`;
}

/** How many expired tickets ONE PAGE takes. See `expiredStagingTickets` for why a page is bounded. */
export const STAGING_SWEEP_BATCH = 200;

/**
 * HOW MANY EXPIRED ROWS ONE DRAIN MAY TOUCH — 50 000, or 250 pages of {@link STAGING_SWEEP_BATCH}.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * THE ARITHMETIC, WHICH IS THE WHOLE POINT OF THE NUMBER
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A ticket's only exit is expiry, so a SATURATED account — one that mints its full quota, sends
 * nothing, and re-mints the moment a ticket ages out — produces expired rows at exactly
 * {@link STAGING_MAX_OUTSTANDING_TICKETS} per {@link ATTACHMENT_STAGING_TTL_MS}:
 *
 *     500 rows / 24 h  ≈  20.8 rows per hour, per account, and there is no way to exceed it.
 *
 * The drain runs once per `MAINTENANCE_EVERY_MS` (one hour, `apps/worker/src/index.ts`), so it
 * keeps up as long as
 *
 *     STAGING_SWEEP_MAX_ROWS  ≥  20.8 × (accounts minting at their ceiling)
 *
 * At 50 000 that is **≈ 2 400 continuously saturated accounts** — every one of them minting five
 * hundred attachments a day and sending none of them, for ever. A deployment that reaches that
 * number has a different problem than a sweep. The number a real population produces is smaller by
 * orders of magnitude: the staged transport does not engage below 3 MB of attachments at all.
 *
 * Contrast the shape this replaces. One 200-row page an hour was outrun by a SINGLE account
 * minting 201 times in an hour, permanently — the backlog then grew without bound, and since the
 * sweep's predicate is the clock rather than an identity, it grew in front of every other
 * account's rows as well. That is the griefing lever the quota review named, and it is the reason the
 * quota and the drain had to land together: the quota makes the mint rate finite, and this makes
 * the sweep faster than that finite rate with three orders of magnitude of headroom.
 *
 * IT IS A CEILING, NOT A TARGET. The drain stops early the moment the expired set is empty, which
 * is what every ordinary hour looks like. When it does bind, it says so — `stoppedBy` comes back
 * `"rows"` and the worker logs it, because the failure this whole finding is about is a backlog
 * that grows in silence.
 */
export const STAGING_SWEEP_MAX_ROWS = 50_000;

/**
 * THE WALL-CLOCK BUDGET for one drain — 60 s.
 *
 * The row ceiling above bounds WORK; this bounds TIME, and they are not the same resource. The
 * drain runs in the worker's serial maintenance slot, so the thing that must never happen is a
 * cycle held open behind object storage having a bad afternoon: 250 pages against an endpoint
 * answering in two seconds each is eight minutes of a slot a mailbox is waiting for.
 *
 * A drain cut short here is not a lost pass. The rows it did not reach are still expired, the next
 * hour starts from the oldest of them, and `stoppedBy: "deadline"` is logged so a deployment that
 * keeps hitting it is visible rather than merely slow.
 */
export const STAGING_SWEEP_DEADLINE_MS = 60_000;

/** What one drain did. `drained` is the only field that promises the table is clear. */
export interface StagingDrainResult {
  /** Rows whose object and row both went. */
  deleted: number;
  /** Pages attempted, successful or not. */
  pages: number;
  /**
   * Pages whose object delete failed. Their rows are untouched and the next drain retries them —
   * a non-zero count means the bucket is refusing deletes, which is an operator's business.
   */
  failedPages: number;
  /** TRUE only when the expired set was emptied AND no page failed. Never inferred from `deleted`. */
  drained: boolean;
  /** Which bound ended the loop. `"dry"` is the ordinary answer. */
  stoppedBy: "dry" | "rows" | "deadline";
}

/**
 * ONE MAINTENANCE PASS over expired staging tickets: object first, then row.
 *
 * Injected rather than reaching for a database handle, because this is the piece the trap lives
 * in — an abandoned upload (a ticket minted, an upload that never happened, a compose window
 * closed) leaves a row and no object, and a sweep written against the happy path would treat the
 * storage 404 as a failure and keep the row forever. `remove` therefore treats 404 as success, and
 * the row goes. That case is the one the pg test exists for.
 *
 * Returns how many rows went. A storage failure on one batch throws — the caller logs it and the
 * next pass retries — because a sweep that swallowed storage errors would report a clean number
 * while the bucket grew.
 *
 * THIS IS ONE PAGE AND NOTHING CALLS IT ALONE ANY MORE. It used to be the entire retention story,
 * called once an hour, which is the shape the quota review named: a client minting faster than one
 * page an hour outran cleanup permanently and globally. {@link drainExpiredStaging} is the loop
 * over this, and the worker calls that. The page stays a separate function because the ORDER it
 * implements is the invariant, and it is worth being able to state and test on its own.
 */
export async function sweepExpiredStaging(deps: {
  storage: AttachmentStagingStorage;
  expired: (limit: number) => Promise<Array<{ id: string; objectPath: string }>>;
  deleteRows: (ids: readonly string[]) => Promise<number>;
  limit?: number;
}): Promise<number> {
  const rows = await deps.expired(deps.limit ?? STAGING_SWEEP_BATCH);
  if (rows.length === 0) return 0;
  // OBJECTS FIRST. A row deleted before its object is an object nobody can name again.
  await deps.storage.remove(rows.map((r) => r.objectPath));
  return deps.deleteRows(rows.map((r) => r.id));
}

/**
 * DRAIN THE EXPIRED SET — pages of {@link sweepExpiredStaging} until it is empty, or until a
 * bound says stop (the quota fix).
 *
 * The single page above was the whole sweep, called once an hour, and that is the defect: any
 * sustained mint rate above one page an hour grew the backlog for ever, globally, because the
 * predicate is the clock and not an identity. This is the loop that was missing. Its ceilings are
 * {@link STAGING_SWEEP_MAX_ROWS} (work) and {@link STAGING_SWEEP_DEADLINE_MS} (time), and the
 * arithmetic showing the first one beats any mint rate the quota permits is on that constant.
 *
 * ── A FAILED PAGE IS SKIPPED, NOT RE-ATTEMPTED IN PLACE ─────────────────────────────────────
 *
 * `sweepExpiredStaging` throws when the object delete fails, and keeps its rows — the recoverable
 * direction, because a row deleted before its object is an object nobody can name again. Inside a
 * LOOP that same behaviour is a trap: the failed rows are the OLDEST rows, so a drain that
 * restarted from the beginning would hand the same poisoned page to storage on every iteration and
 * never reach anything behind it. One permanently unremovable object would stall cleanup for the
 * entire deployment — the very failure mode this function exists to remove, reintroduced by the
 * fix for it.
 *
 * So the cursor advances past EVERY page attempted, successful or not. A failing page keeps its
 * rows, is counted in `failedPages`, and is retried from the top of the next hour's drain; the
 * rows behind it are reached in this one. Transient failures therefore cost one page of delay, and
 * permanent ones cost one page of wasted work per hour, visibly.
 *
 * Advancing over SUCCESSFUL pages is free rather than merely harmless: their rows are gone, so
 * there is nothing behind the cursor to skip. And no row can appear behind it later — `now` is
 * fixed for the whole drain and `expires_at` only ever moves forward with `created_at`.
 *
 * ── WHY IT COMPOSES THE PAGE FUNCTION INSTEAD OF INLINING THE TWO DELETES ───────────────────
 *
 * The order — object, then row — has exactly one implementation in this codebase, and the module
 * header says why. A drain that issued its own `remove` and `delete` would be a second one, in the
 * function most likely to be edited under time pressure.
 */
export async function drainExpiredStaging(deps: {
  storage: AttachmentStagingStorage;
  expired: (
    limit: number, after: { expiresAt: Date; id: string } | null,
  ) => Promise<ExpiredStagingTicket[]>;
  deleteRows: (ids: readonly string[]) => Promise<number>;
  pageSize?: number;
  maxRows?: number;
  deadlineMs?: number;
  /** Injected so a test can drive the deadline without waiting for it. */
  clock?: () => number;
  /** Called once per failed page. The worker logs; nothing here decides what a failure means. */
  onPageError?: (err: unknown, rows: readonly ExpiredStagingTicket[]) => void;
}): Promise<StagingDrainResult> {
  const pageSize = deps.pageSize ?? STAGING_SWEEP_BATCH;
  const maxRows = deps.maxRows ?? STAGING_SWEEP_MAX_ROWS;
  const deadlineMs = deps.deadlineMs ?? STAGING_SWEEP_DEADLINE_MS;
  const clock = deps.clock ?? Date.now;
  const startedAt = clock();

  let after: { expiresAt: Date; id: string } | null = null;
  let scanned = 0;
  let deleted = 0;
  let pages = 0;
  let failedPages = 0;
  let stoppedBy: StagingDrainResult["stoppedBy"] = "dry";

  for (;;) {
    if (scanned >= maxRows) { stoppedBy = "rows"; break; }
    if (clock() - startedAt >= deadlineMs) { stoppedBy = "deadline"; break; }

    const limit = Math.min(pageSize, maxRows - scanned);
    const rows = await deps.expired(limit, after);
    if (rows.length === 0) { stoppedBy = "dry"; break; }

    // SCANNED, NOT DELETED, is what the ceiling counts. A drain whose pages all fail must still
    // terminate, and a budget spent on rows that did not go is a budget spent.
    scanned += rows.length;
    pages += 1;
    const last = rows[rows.length - 1]!;
    after = { expiresAt: last.expiresAt, id: last.id };

    try {
      deleted += await sweepExpiredStaging({
        storage: deps.storage,
        expired: async () => rows,
        deleteRows: deps.deleteRows,
        limit: rows.length,
      });
    } catch (err) {
      failedPages += 1;
      deps.onPageError?.(err, rows);
    }
  }

  // `drained` is asserted, never inferred. "The loop ran out of rows" and "the table is clear" are
  // different claims whenever a page failed, and reporting the second one from the first is how a
  // growing bucket reads as a clean sweep.
  return { deleted, pages, failedPages, drained: stoppedBy === "dry" && failedPages === 0, stoppedBy };
}

/**
 * THE DRAIN bound to a database handle — what the worker's hourly maintenance slot calls.
 *
 * A thin composition over {@link drainExpiredStaging} and the statements above, here rather than
 * in the worker so the ORDER (object, then row) and the paging cursor have exactly one
 * implementation. This is the single symbol `apps/worker/src/index.ts` needs out of the whole
 * transport, and having it on `@trafficflow/db/cloud` is what keeps the worker's runtime closure
 * to the five packages its dependency test names.
 *
 * `now` is captured once by the caller and used for every page, so the drain's own runtime cannot
 * pull rows into its horizon mid-loop and stretch it.
 */
export async function sweepExpiredStagingFor(
  db: Tx, storage: AttachmentStagingStorage, now: Date,
  opts: {
    pageSize?: number; maxRows?: number; deadlineMs?: number; clock?: () => number;
    onPageError?: (err: unknown, rows: readonly ExpiredStagingTicket[]) => void;
  } = {},
): Promise<StagingDrainResult> {
  return drainExpiredStaging({
    storage,
    expired: (n, after) => expiredStagingTickets(db, now, n, after),
    deleteRows: (ids) => deleteStagingTickets(db, ids),
    ...opts,
  });
}
