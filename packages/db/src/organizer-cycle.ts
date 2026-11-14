import { max, sql } from "drizzle-orm";

import { workerHeartbeats } from "./schema-cloud.js";
import { DEFAULT_ALERT_THRESHOLDS } from "./alerts.js";
import type { Tx } from "./change-log.js";

/**
 * How the organizer stands, as a signed-in client may know it: one fact about this deployment, phrased
 * for the reader's own mail. No count, no instance, no shard, nothing about another account.
 */
export interface OrganizerStanding {
  /**
   * When the organizer's last pass finished, ISO-8601 UTC, or null when none is on record — the fact
   * that separates a turn from a stall. A pending filing waits for the rotation, so "one message
   * outstanding" is unremarkable while passes are landing and alarming while none are.
   */
  lastCycleAt: string | null;
  /** New mail is not being fetched, or fetching has fallen behind. */
  behind: boolean;
  /** Since when: the last pass that finished, or null when none is on record. */
  since: string | null;
}

/**
 * Whether fetching is behind, at the pager's own cuts (`DEFAULT_ALERT_THRESHOLDS`): no pulse inside
 * `leaderStaleMs` (nothing is running: `worker_down`), or no finished pass inside `syncLagMs +
 * syncLagSustainMs`, the age at which `sync_lag` calls a mailbox lagging (it runs and does no work).
 * The pass clock moves only when a pass ENDS, and a pass gives every mailbox a turn: a backlog makes
 * it long while new mail still lands, so it is cut where the pager cuts and no sooner. What it does
 * not see is a pass that outlasts that cut while its turns keep ending; a clock that moves with the
 * turns needs a column of its own on the row. A worker that does not move at all exits or gives its
 * leadership up by itself (`stuckCycleBoundMs` in the worker), and its pulse stops with it. A leader
 * that has not finished its first pass is measured from its start, and the row keeps the last
 * finished pass across a restart (`writeHeartbeat`), so "since" stays true while a returning worker
 * catches up. The pulse's AGE and not its `leader` flag: a clean handover clears the flag and writes
 * a fresh pulse, and must not read as an outage for the five seconds it lasts.
 */
export function fetchingBehind(
  seen: { beatAt: Date | null; movedAt: Date | null }, now: Date,
  bounds: { leaderStaleMs: number; syncLagMs: number; syncLagSustainMs: number } = DEFAULT_ALERT_THRESHOLDS,
): boolean {
  if (seen.beatAt === null || seen.movedAt === null) return true;
  return now.getTime() - seen.beatAt.getTime() > bounds.leaderStaleMs
    || now.getTime() - seen.movedAt.getTime() > bounds.syncLagMs + bounds.syncLagSustainMs;
}

/**
 * ONE read of `worker_heartbeats` (a row per shard, no mailbox is touched): the newest across shards.
 * On `/cloud` — a CLOUD table read from inside the desktop engine's closure, so the DTO builder takes an
 * injected reader: local tiers pass none and answer `null`; a desktop must never be told its organizer
 * is dead. A fact about our worker, not anybody's mail.
 */
export async function readOrganizerStanding(db: Tx, now: Date = new Date()): Promise<OrganizerStanding> {
  const [row] = await db
    .select({
      beatAt: max(workerHeartbeats.beatAt),
      cycleAt: max(workerHeartbeats.lastCycleAt),
      movedAt: sql<Date | null>`max(coalesce(${workerHeartbeats.lastCycleAt}, ${workerHeartbeats.startedAt}))`
        .mapWith(workerHeartbeats.startedAt),
    })
    .from(workerHeartbeats);
  const cycleAt = row?.cycleAt ?? null;
  const since = cycleAt === null ? null : cycleAt.toISOString();
  return {
    lastCycleAt: since,
    behind: fetchingBehind({ beatAt: row?.beatAt ?? null, movedAt: row?.movedAt ?? null }, now),
    since,
  };
}

/**
 * The reader shaped for {@link MailboxServiceDeps.organizerStanding} — it takes the request's own
 * context and reads through the handle that context carries.
 *
 * A separate export rather than one function taking both shapes, because the composition passes
 * this by REFERENCE (`organizerStanding: organizerStandingReader`), and a reference is what a
 * census over the wiring can see — a call-form grep finds calls, not callers.
 */
export const organizerStandingReader =
  (ctx: { db: unknown; now?: () => Date }): Promise<OrganizerStanding> =>
    readOrganizerStanding(ctx.db as Tx, ctx.now?.() ?? new Date());
