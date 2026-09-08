import { desc, isNotNull } from "drizzle-orm";

import { workerHeartbeats } from "./schema-cloud.js";
import type { Tx } from "./change-log.js";

/**
 * ═══ WHEN THE ORGANIZER'S LAST PASS FINISHED — the fact that separates a turn from a stall ════
 *
 * A pending filing waits for the worker's ROTATION: a tick queues one serialized pass and every
 * mailbox gets one bounded turn in it. So "one message outstanding" is unremarkable while passes
 * are landing and alarming while none are, and the strip could report only the first half. It said
 * "Filing 1 message on your mail server… the server is catching up" identically in both cases.
 *
 * `worker_heartbeats.last_cycle_at` already carries it. That table's own comment states the
 * distinction this read depends on: "a leader that is alive but syncing nothing is visible here as
 * a fresh `beat_at` with a stale `last_cycle_at`, which is a different fault from a dead worker".
 *
 * ── ON THE `/cloud` ENTRY POINT, AND THAT IS THE WHOLE REASON IT IS A FUNCTION ─────────────
 *
 * `worker_heartbeats` is a CLOUD table, and the DTO builder that renders this field
 * (`packages/services/src/mailbox-service.ts`) is inside the desktop engine's import closure —
 * the API imports services, the engine bundles the API. So the builder takes an injected reader
 * (`MailboxServiceDeps.lastOrganizerCycleAt`) and the hosted compositions pass this; the local
 * tiers pass nothing and the field is null, which the client renders as silence rather than as
 * "no pass has ever run". A desktop organizes its own mailbox in-process and must never be told
 * its organizer is dead.
 *
 * ── THE NEWEST ACROSS SHARDS, AND `NOT NULL` IS NOT A FILTER FOR TIDINESS ──────────────────
 *
 * One row per shard, overwritten every beat. A deployment may run several, and a mailbox belongs
 * to exactly one — but which one is not a fact this read has, and it does not need it: the
 * question the sentence asks is whether the ORGANIZER is running passes at all, and the newest
 * pass across the shards is the honest answer to that. Naming a per-mailbox shard here would
 * promise a precision the strip does not use and would go wrong the day the shard count changes.
 *
 * `IS NOT NULL` matters because the column is nullable and a freshly started instance has beat
 * without completing a cycle. Ordering by a nullable column and taking the first row would return
 * that NULL and report "cannot tell" for a deployment whose other shard finished a pass a second
 * ago — the answer to a different question.
 *
 * Deployment-global and NOT account-scoped, deliberately: it is a fact about our own worker, not
 * about anybody's mail. No account id enters this read and none could — the table has no such
 * column — so it conveys nothing about one customer to another.
 */
export async function readLastOrganizerCycleAt(db: Tx): Promise<string | null> {
  const rows = await db
    .select({ at: workerHeartbeats.lastCycleAt })
    .from(workerHeartbeats)
    .where(isNotNull(workerHeartbeats.lastCycleAt))
    .orderBy(desc(workerHeartbeats.lastCycleAt))
    .limit(1);
  const at = rows[0]?.at ?? null;
  return at === null ? null : at.toISOString();
}

/**
 * The reader shaped for {@link MailboxServiceDeps.lastOrganizerCycleAt} — it takes the request's
 * own context and reads through the handle that context carries.
 *
 * A separate export rather than one function taking both shapes, because the composition passes
 * this by REFERENCE (`lastOrganizerCycleAt: organizerCycleReader`), and a reference is what a
 * census over the wiring can see — a call-form grep finds calls, not callers.
 */
export const organizerCycleReader =
  (ctx: { db: unknown }): Promise<string | null> =>
    readLastOrganizerCycleAt(ctx.db as Tx);
