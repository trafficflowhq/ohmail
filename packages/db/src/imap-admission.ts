import { and, eq, sql } from "drizzle-orm";
// From the modules directly, never the package index: the index re-exports this file, and a
// module that imports its own barrel is a cycle waiting for the first consumer to hit it.
import { authThrottle } from "./schema.js";
import type { Tx } from "./change-log.js";

/**
 * How many IMAP connections this deployment may hold open for one mailbox. The API does a full
 * LOGIN per attachment fetch, the worker holds one persistent connection, and nothing bounded the
 * pair — providers cap concurrent connections. imapflow marks every LOGIN failure
 * `authenticationFailed`, which classifies as `auth` and detaches after three failures: an
 * attachment burst ended with a user told their password is wrong. A counter in `auth_throttle`,
 * not an advisory lock: behind a transaction pooler a session lock's unlock can land on another
 * backend and leak; an xact lock cannot span an IMAP fetch. It counts CONCURRENCY, not a rate. A
 * stale row is reset by the next acquire ({@link IMAP_ADMISSION_WINDOW_MS}) — no permanent wedge.
 */

/** Key namespace. Kept exported so the prune that owes it a prefix can name it rather than guess. */
export const IMAP_ADMISSION_NAMESPACE = "imap:mailbox:";

/**
 * How long a counter may go untouched before the next acquire treats it as stale and resets it.
 *
 * STRICTLY GREATER than `apps/api-vercel`'s `maxDuration = 60`, which is the longest any API-held
 * IMAP connection can live (the platform kills the invocation at that point, and the four
 * `DEFAULT_NET_TIMEOUTS` deadlines are all below it). A live connection therefore cannot have its
 * slot reclaimed underneath it by inactivity — only by the bounded roll described above.
 */
export const IMAP_ADMISSION_WINDOW_MS = 90_000;

/** `imap:mailbox:<uuid>` — the counter row for one mailbox. */
export function imapAdmissionKey(mailboxId: string): string {
  return `${IMAP_ADMISSION_NAMESPACE}${mailboxId}`;
}

/**
 * The deployment-wide refusal counter's key namespace (cloud 0030's reliability rules). A refusal
 * means a mailbox was at its connection cap; in a burst it is a mailbox nothing can reach — and
 * nothing recorded that: {@link acquireImapSlot} gives the over-count straight back, so the
 * evidence is gone by the next statement. It cannot ride the worker heartbeat: both admission
 * call sites are on the serverless API host — no heartbeat row, no in-process counter surviving
 * the invocation. It needs no table: `auth_throttle` is already the generic rolling-window
 * counter. ONE key, not one per mailbox: the rule's question is deployment-wide; WHICH mailbox is
 * in the log line at the refusal site.
 */
export const IMAP_REFUSAL_KEY = "imap:refused:all";

/**
 * Record one admission refusal. Best-effort by contract. A SLIDING window, which this was not:
 * the first version kept one row with a count and a window start — a TUMBLING window: the first
 * write after a boundary DISCARDS the previous window's tail, and a burst that then stops is
 * never revised — silence on the exact shape the rule reports. Events are therefore kept: ONE ROW
 * PER MINUTE, keyed by bucket, summed inside the window; the residual is granularity, not loss.
 * NEVER let this throw: a failed counter must not turn a handled refusal into a 500 — its one
 * caller wraps it. `alerts-reliability.test.ts` drives a real refusal through {@link
 * acquireImapSlot} and asserts the rule fires — the first cut was called from nowhere.
 */
export async function recordImapRefusal(
  db: Tx, now: Date, windowMs: number = IMAP_REFUSAL_WINDOW_MS,
): Promise<void> {
  const bucket = new Date(Math.floor(now.getTime() / REFUSAL_BUCKET_MS) * REFUSAL_BUCKET_MS);
  await db.insert(authThrottle)
    .values({ key: bucketKey(bucket), failures: 1, windowStartedAt: bucket, updatedAt: now })
    .onConflictDoUpdate({
      target: authThrottle.key,
      set: { failures: sql`${authThrottle.failures} + 1`, updatedAt: now },
    });
  // Bounded by construction: two windows of buckets is all any reader can ask for, and the
  // delete is one indexed prefix scan over a handful of rows. No sweep job is owed.
  await db.delete(authThrottle).where(and(
    sql`${authThrottle.key} like ${`${IMAP_REFUSAL_KEY}:%`}`,
    sql`${authThrottle.windowStartedAt} < ${new Date(now.getTime() - 2 * windowMs).toISOString()}::timestamptz`,
  ));
}

/** One minute. The granularity of the sliding window's edge, and the row count it costs. */
const REFUSAL_BUCKET_MS = 60_000;

const bucketKey = (at: Date): string => `${IMAP_REFUSAL_KEY}:${at.getTime()}`;

/**
 * The default refusal window. Matches `AlertThresholds.imapRefusalWindowMs`, and the two are the
 * same judgment stated once each: the counter's window and the rule's lookback have to agree, or
 * the rule divides a count formed over one span by a threshold written for another.
 */
export const IMAP_REFUSAL_WINDOW_MS = 15 * 60 * 1000;

/**
 * Refusals inside the current window, or 0 when nothing has been refused.
 *
 * A row whose window has already ROLLED reads as 0 rather than as its stale count: the counter is
 * reset lazily by the next write, so a burst that stopped an hour ago still has its row sitting
 * there with the old number in it, and returning that would keep the incident firing for ever
 * after the fault ended.
 */
export async function imapRefusalsInWindow(
  db: Tx, now: Date, windowMs: number = IMAP_REFUSAL_WINDOW_MS,
): Promise<number> {
  // One unit for both ends: the minute grid. Events are stored minute-floored; computing the cut
  // exactly is two units for one comparison and drops the bucket the cut falls inside — a refusal
  // at 12:00:59 is stored at 12:00:00, and a 12:15:30 evaluation's exact cut (12:00:30) excludes
  // it while it sits squarely inside the advertised fifteen minutes. A burst confined to that
  // boundary minute is missed entirely. The cut is floored to the same grid, so a bucket is in
  // the window exactly when any instant it could contain is. The stated residual: a bucket whose
  // earliest second is up to 59 s older than `windowMs` is included — an over-count of less than
  // one bucket, never an under-count, the safe direction for a threshold rule.
  const cut = new Date(
    Math.floor((now.getTime() - windowMs) / REFUSAL_BUCKET_MS) * REFUSAL_BUCKET_MS,
  );
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${authThrottle.failures}), 0)::int` })
    .from(authThrottle)
    .where(and(
      sql`${authThrottle.key} like ${`${IMAP_REFUSAL_KEY}:%`}`,
      sql`${authThrottle.windowStartedAt} >= ${cut.toISOString()}::timestamptz`,
    ));
  return Number(row?.n ?? 0);
}

export interface ImapSlotInput {
  mailboxId: string;
  /** How many connections this deployment may hold open for the mailbox at once. */
  max: number;
  now: Date;
  windowMs?: number;
}

/**
 * Claim one connection slot for `mailboxId`, or report the mailbox at capacity. ONE `INSERT … ON
 * CONFLICT DO UPDATE … RETURNING`, never SELECT-then-UPDATE: a read-modify-write counter
 * collapses concurrent claimants into one increment; the row lock decides the race. ISO strings
 * in the raw `sql` templates, never `Date`s: postgres-js serializes against `$n::timestamptz`'s
 * described type (TEXT) and hands a `Date` to `Buffer.byteLength` — green on PGlite, a 500 in
 * production. A refusal gives the over-count straight back; the give-back is a second statement,
 * so a concurrent claimant can briefly be refused when a slot was free — the SAFE direction.
 * Returns `true` when a slot is held; the caller then OWES a {@link releaseImapSlot}.
 */
export async function acquireImapSlot(db: Tx, input: ImapSlotInput): Promise<boolean> {
  const key = imapAdmissionKey(input.mailboxId);
  const windowMs = input.windowMs ?? IMAP_ADMISSION_WINDOW_MS;
  const nowIso = input.now.toISOString();
  const staleIso = new Date(input.now.getTime() - windowMs).toISOString();
  const stale = sql`${authThrottle.windowStartedAt} < ${staleIso}::timestamptz`;

  const [row] = await db.insert(authThrottle)
    .values({ key, failures: 1, windowStartedAt: input.now, updatedAt: input.now })
    .onConflictDoUpdate({
      target: authThrottle.key,
      set: {
        failures: sql`case when ${stale} then 1 else ${authThrottle.failures} + 1 end`,
        windowStartedAt: sql`case when ${stale} then ${nowIso}::timestamptz else ${authThrottle.windowStartedAt} end`,
        updatedAt: input.now,
      },
    })
    .returning({ failures: authThrottle.failures });

  // A missing row can only mean the write did not happen, and "we could not count this connection"
  // must REFUSE rather than admit — the other default leaves the mailbox uncapped exactly when the
  // counter is broken. Nothing is owed back in that case: no slot was taken.
  const held = row?.failures ?? Number.MAX_SAFE_INTEGER;
  if (held <= input.max) return true;
  await releaseImapSlot(db, input.mailboxId, input.now);

  // The refusal is counted here, the single choke point: every admission site reaches a refusal
  // through this one `return false`, so counting cannot be forgotten by a new call site. Counting
  // at the call sites is exactly what shipped and did not work — {@link recordImapRefusal} had no
  // production caller, the counter never moved, and the `imap_admission_refused` rule was a guard
  // nobody could watch fail. SWALLOWED, on `writeHeartbeat`'s contract: this path's job is to
  // hand back "busy, try again", and a failed counter must not turn a handled refusal into a 500
  // — observability may not cause the outage it reports. The stated cost: a database fault here
  // under-reports the counter, the direction a threshold rule is safe to be wrong in, and such a
  // fault would be visible in every other rule at once.
  try {
    await recordImapRefusal(db, input.now);
  } catch { /* see above: the refusal must outlive its own bookkeeping */ }
  return false;
}

/**
 * Give one slot back. Idempotent at the floor rather than at the caller: `greatest(… - 1, 0)`
 * means a stray release can never drive the counter negative and hand the mailbox a free slot it
 * did not earn. The CALLER is still responsible for releasing exactly once per successful
 * acquire — see the `released` flag in `attachments-adapter.ts`.
 *
 * `window_started_at` is deliberately untouched: it marks when this window began, and refreshing
 * it on every release would push the stale-reclaim horizon forward for ever on a busy mailbox,
 * turning the one mechanism that recovers a leaked slot into one that never fires.
 */
export async function releaseImapSlot(db: Tx, mailboxId: string, now: Date): Promise<void> {
  await db.update(authThrottle)
    .set({ failures: sql`greatest(${authThrottle.failures} - 1, 0)`, updatedAt: now })
    .where(eq(authThrottle.key, imapAdmissionKey(mailboxId)));
}
