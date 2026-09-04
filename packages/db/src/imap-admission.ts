import { eq, sql } from "drizzle-orm";
// From the modules directly, never the package index: the index re-exports this file, and a
// module that imports its own barrel is a cycle waiting for the first consumer to hit it.
import { authThrottle } from "./schema.js";
import type { Tx } from "./change-log.js";

/**
 * **HOW MANY IMAP CONNECTIONS THIS DEPLOYMENT MAY HAVE OPEN FOR ONE MAILBOX.**
 *
 * The API fetches attachment bytes on demand: `makeOpenAdapter` does a full LOGIN + LIST per
 * request (`packages/api/src/attachments-adapter.ts`). Nothing bounded that. The worker holds one
 * persistent connection per mailbox on top of it, and the two processes shared no lease, mutex,
 * semaphore or cap of any kind — so N concurrent attachment requests were N concurrent logins.
 *
 * Providers cap concurrent connections per account, iCloud notably low, and the damage is not a
 * failed download. imapflow marks EVERY failure of the LOGIN command with
 * `authenticationFailed = true` (`imapflow/lib/commands/login.js:38`, unconditional in the catch);
 * the worker's `classifyMailboxError` reads that flag first and answers `"auth"`; the webapp
 * renders `err_auth` as "Sync failed — the mailbox rejected the password" and three consecutive
 * failures detach the mailbox. An attachment burst therefore ends with the user being told their
 * password is wrong about a mailbox whose password is fine.
 *
 * ── WHY A COUNTER IN `auth_throttle` AND NOT AN ADVISORY LOCK ────────────────────────────────
 *
 * An advisory lock is the idiom this repository already uses (`migrate.ts`, `leader-lock.ts`) and
 * it is the wrong tool HERE, for three independent reasons, each fatal on its own:
 *
 *  · The API's runtime handle is `makePooledDb` — `{ prepare: false, max: 1 }` against a
 *    TRANSACTION pooler (see `session-url.ts` for the host shapes). A session-scoped
 *    `pg_try_advisory_lock` and its later `pg_advisory_unlock` are two separate statements and a
 *    transaction pooler is free to run them on different backends: the unlock misses and the lock
 *    leaks until that backend recycles.
 *  · `pg_try_advisory_xact_lock` releases at COMMIT, so it cannot span the thing being guarded —
 *    the guarded region is an IMAP fetch, not a database operation.
 *  · Holding an explicit transaction across that fetch would pin the instance's ONE connection for
 *    the length of a network round trip to somebody else's mail server. That is the failure
 *    already fixed once in this repository ("the console deadlocked itself — parallel reads on a
 *    max:1 pool").
 *
 * Both statements below are single, autocommit, and run OUTSIDE any transaction: the pool is held
 * for one statement at a time and never across the socket's life.
 *
 * ── WHY IT COUNTS CONCURRENCY AND NOT AN OPEN RATE ───────────────────────────────────────────
 *
 * A rate limit is a broken proxy for a connection cap when each hold lasts seconds. Any rate low
 * enough to protect a provider's cap also refuses a user clicking ten attachments one after
 * another — ten opens in a minute at one connection at a time, which is not the abuse being
 * prevented. Any rate loose enough for that use admits far more than the cap when the opens
 * overlap. So this counts what the provider counts: how many are open right now.
 *
 * ── WHY IT CANNOT WEDGE A MAILBOX, WHICH IS THE HARD PART ────────────────────────────────────
 *
 * Every counter with a release obligation can leak: a serverless invocation killed at
 * `maxDuration` never runs its `finally`, and a leaked slot in a naive counter is permanent — the
 * cap would silently become a mailbox that can never be read again. The reclaim is the window
 * this table already has. {@link IMAP_ADMISSION_WINDOW_MS} is 90 s against the host's
 * `maxDuration = 60`, so a row untouched for longer than any connection can possibly live is
 * reset by the next acquire rather than trusted. Nothing polls, nothing sweeps, nothing waits.
 *
 * The cost is bounded over-admission at a window roll: holders carried across the roll are
 * forgotten, so the true ceiling is 2 × `max` for the length of one window rather than `max`.
 * With `max = 2` that is 4 from the API plus the worker's 1. That is the trade — a brief,
 * bounded over-count against a permanently unreadable mailbox — and it is taken deliberately.
 *
 * ── WHY THIS TABLE ──────────────────────────────────────────────────────────────────────────
 *
 * `auth_throttle` is already the repository's generic namespaced rolling-window counter, not an
 * auth-only store: `mail:<quota>:<sha256(recipient)>`, `waitlist:ip:*`, `register:ip:*` and
 * `verify:ip:*` all live in it, and `reserveIpSlot` is the same upsert shape. Adding a table for
 * this would be a migration for a counter the schema already has.
 *
 * The key is NOT hashed, unlike the ip/recipient namespaces: a mailbox id is an opaque internal
 * UUID, not an address or an identity, so there is nothing here a hash would protect.
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
 * The DEPLOYMENT-WIDE refusal counter's key namespace (cloud 0030's reliability rules).
 *
 * ── WHY A SECOND COUNTER OVER THE SAME MECHANISM, AND NOT A COLUMN OR A TABLE ─────────────
 *
 * A refusal means a mailbox was at its connection cap. At a trickle that is the cap doing
 * exactly its job; in a burst it is a mailbox nothing can get a connection to, and an attachment
 * fetch, an add-time probe and a send reconcile are all queueing behind it. Nothing recorded that
 * anywhere: {@link acquireImapSlot} gives the over-count straight back on a refusal, so by the
 * time the next statement runs the evidence is gone.
 *
 * It cannot ride the worker heartbeat, which is where a reliability signal would ordinarily go:
 * BOTH admission call sites are on the API host (the add-time probe and the attachment adapter),
 * the worker never acquires a slot at all, and the API host is serverless — no heartbeat row, and
 * no in-process counter that survives the invocation. A durable, host-independent counter is the
 * only shape that works.
 *
 * It does not need a table either. This file's own header argues that `auth_throttle` is the
 * repository's generic namespaced rolling-window counter rather than an auth-only store, and a
 * count-per-window is precisely what it does. A migration for a second counter over the mechanism
 * the first one already uses would be a table for nothing.
 *
 * ── ONE KEY, NOT ONE PER MAILBOX ──────────────────────────────────────────────────────────
 *
 * The rule's question is "is admission refusing a lot right now", which is deployment-wide, and a
 * per-mailbox key would make the alert's read a scan of a namespace instead of one indexed row.
 * WHICH mailbox is in the log line at the refusal site, where a drain gates it; the counter is
 * the part that has to be cheap to read on every alert pass.
 */
export const IMAP_REFUSAL_KEY = "imap:refused:all";

/**
 * Record one admission refusal. Best-effort by contract — see the throw note below.
 *
 * The window ROLLS exactly as the admission counter's does: a row untouched for longer than
 * `windowMs` is reset to 1 by the next refusal rather than trusted, so the count this returns is
 * always "refusals inside a window ending now" and no sweep, poll or expiry job is owed. The
 * consequence, stated: a window that rolls mid-burst splits it across two windows, so a burst
 * straddling the boundary can read lower than it was. That is the safe direction for a rule that
 * fires above a threshold — it can only ever under-report — and it costs at most one window of
 * delay before the burst is fully inside one.
 *
 * NEVER LET THIS THROW INTO THE CALLER. It runs on the refusal path, whose job is to return
 * "busy, try again" to a person waiting on an attachment; a counter that failed must not turn a
 * handled refusal into a 500. Its ONE caller — {@link acquireImapSlot}'s refusal branch — wraps
 * it, and this function does not swallow on that caller's behalf: a swallow here would hide a
 * database fault from a direct caller written later.
 *
 * That caller is the whole reachability story and it is worth stating, because the first cut of
 * this rule had none: the counter was written, unit-tested and called from nowhere, so the rule
 * that reads it could never fire in production. `alerts-reliability.test.ts` now drives a real
 * refusal through {@link acquireImapSlot} and asserts the rule fires off it — the property that
 * was missing, and one a test calling this function directly cannot see.
 */
export async function recordImapRefusal(
  db: Tx, now: Date, windowMs: number = IMAP_REFUSAL_WINDOW_MS,
): Promise<void> {
  const nowIso = now.toISOString();
  const staleIso = new Date(now.getTime() - windowMs).toISOString();
  const stale = sql`${authThrottle.windowStartedAt} < ${staleIso}::timestamptz`;
  await db.insert(authThrottle)
    .values({ key: IMAP_REFUSAL_KEY, failures: 1, windowStartedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: authThrottle.key,
      set: {
        failures: sql`case when ${stale} then 1 else ${authThrottle.failures} + 1 end`,
        windowStartedAt: sql`case when ${stale} then ${nowIso}::timestamptz else ${authThrottle.windowStartedAt} end`,
        updatedAt: now,
      },
    });
}

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
  const cut = new Date(now.getTime() - windowMs);
  const [row] = await db
    .select({ failures: authThrottle.failures, windowStartedAt: authThrottle.windowStartedAt })
    .from(authThrottle)
    .where(eq(authThrottle.key, IMAP_REFUSAL_KEY))
    .limit(1);
  if (!row) return 0;
  const started = new Date(row.windowStartedAt as unknown as string);
  if (started < cut) return 0;
  return Number(row.failures ?? 0);
}

export interface ImapSlotInput {
  mailboxId: string;
  /** How many connections this deployment may hold open for the mailbox at once. */
  max: number;
  now: Date;
  windowMs?: number;
}

/**
 * Claim one connection slot for `mailboxId`, or report that the mailbox is at capacity.
 *
 * ONE `INSERT … ON CONFLICT DO UPDATE … RETURNING`, never SELECT-then-UPDATE: a read-modify-write
 * counter collapses concurrent claimants into a single increment, which is exactly the traffic a
 * cap exists to catch. The row lock decides the race and every caller reads its own
 * post-increment value back — the same argument, and the same statement shape, as
 * `reserveIpSlot`.
 *
 * ISO strings inside the raw `sql` templates, never `Date`s: postgres-js serializes a raw template
 * parameter against the type Postgres describes for `$n` in `$n::timestamptz`, which is TEXT, and
 * hands a `Date` straight to `Buffer.byteLength`. Green on PGlite, a 500 in production.
 *
 * A refusal gives the over-count straight back, so a burst of refusals cannot inflate the counter
 * and lock the mailbox out for a whole window. The increment and that give-back are two
 * statements, so a concurrent claimant can briefly see the inflated value and be refused when a
 * slot was in fact free. That is the SAFE direction — a spurious "busy, try again" — and it lasts
 * one round trip.
 *
 * @returns `true` when a slot is held, and the caller now OWES a {@link releaseImapSlot}.
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

  // ── THE REFUSAL IS COUNTED HERE, WHICH IS THE ONLY PLACE IT CAN BE ────────────────────
  //
  // This is the single choke point: every admission site in the deployment reaches a refusal
  // through this one `return false`, so counting here cannot be forgotten by a new call site.
  // Counting at the call sites instead is exactly what shipped and did not work —
  // {@link recordImapRefusal} had NO production caller at all, so the counter never moved,
  // `imapRefusalsInWindow` always answered 0, and the `imap_admission_refused` rule was a guard
  // nobody could watch fail. Built, tested and unreachable.
  //
  // SWALLOWED, on `writeHeartbeat`'s contract. This runs on the path whose job is to hand back
  // "busy, try again" to a person waiting on an attachment, and a counter that failed must not
  // turn a handled refusal into a 500 — observability may not cause the outage it reports. The
  // cost of the swallow is stated rather than hidden: a database fault here makes the refusal
  // counter under-report, and under-reporting is the direction a threshold rule is safe to be
  // wrong in. A fault that broke this write would be visible in every other rule at once.
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
