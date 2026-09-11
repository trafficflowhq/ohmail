import { desc, isNotNull } from "drizzle-orm";

import { workerHeartbeats } from "./schema-cloud.js";
import type { Tx } from "./change-log.js";

/**
 * When the organizer's last pass finished — the fact that separates a turn from a stall. A
 * pending filing waits for the worker's rotation, so "one message outstanding" is unremarkable
 * while passes are landing and alarming while none are. `worker_heartbeats.last_cycle_at` carries
 * it: a leader alive but syncing nothing is a fresh `beat_at` with a stale `last_cycle_at`. On
 * `/cloud` — a CLOUD table read from inside the desktop engine's closure, so the DTO builder
 * takes an injected reader: local tiers pass none and the field is null; a desktop must never be
 * told its organizer is dead. The newest across shards; `IS NOT NULL` matters. A fact about our
 * worker, not anybody's mail.
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
