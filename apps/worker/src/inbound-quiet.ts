import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { mailboxes, messages, type Tx } from "@trafficflow/db";

/**
 * THE INBOUND-QUIET PASS — the forwarding-detection heuristic (mail 0078), and the single owner
 * of its predicate.
 *
 * ── THE INCIDENT THIS EXISTS FOR ──────────────────────────────────────────────────────────
 *
 * A mailbox synced perfectly for weeks while receiving essentially nothing, because a
 * provider-level forward (set up at the provider, without "keep a copy") diverted every inbound
 * mail BEFORE IMAP storage. From where ohmail stands the mailbox was completely healthy: every
 * cycle connected, every folder listed, `last_sync_at` fresh — and every surface said so. Two
 * days of debugging pointed at ohmail when the answer was upstream. The mail simply never
 * reached the mailbox, and absence of arrivals is the one shape no per-cycle signal carries.
 * This pass is the scan that notices that shape, because quiet is BY DEFINITION the absence of
 * ingest events — an ingest-transition emission cannot enter this state, only leave it
 * (`storage_at_cap` in `packages/db/src/alerts.ts` makes the same argument for its scan).
 *
 * ── WHAT COUNTS AS "GENUINE INBOUND", AND WHY EACH EXCLUSION IS THERE ─────────────────────
 *
 *  · `lower(from_address) <> lower(mailbox.address)` — the user's OWN sends land in the Sent
 *    folder and are ingested like everything else; a diverted mailbox's user typically keeps
 *    SENDING from it (that is the measured incident shape), so without this clause an active
 *    sender's mailbox never trips. (A send from an ALIAS is not excluded — it keeps `recent` non-zero and holds
 *    the notice back, which errs toward silence, never toward a false alarm.)
 *  · ohmail's own organization needs NO exclusion, structurally: moves rewrite `folder_state`
 *    and never create `messages` rows, so nothing ohmail does to a mailbox can look like an
 *    arrival.
 *  · `deleted_at` is deliberately NOT excluded. A tombstoned row still proves the mail ARRIVED
 *    — the row is the message's identity and survives deletion — and the question this pass
 *    asks is about arrival, not retention. Excluding it would tell a user who deletes mail on
 *    reading that their mailbox "receives almost nothing", which is false.
 *  · junk is deliberately NOT excluded either: the notice's sentence is "this mailbox has
 *    received almost nothing", and a mailbox whose Junk folder fills daily has not.
 *  · `date IS NOT NULL` — `date` is the header date, the honest arrival clock across an initial
 *    import (a mailbox connected yesterday still shows WHEN its mail really arrived, which is
 *    what lets the absolute arm fire within days of connecting a long-diverted mailbox).
 *    A row without one asserts no arrival time and is left out of the evidence.
 *
 * ── THE PREDICATE (all thresholds are exported constants; the tests replay the incident) ───
 *
 * TRIP — start an episode (`inbound_quiet_since` NULL → stamped) — only when ALL gates hold:
 *
 *   gates  status = 'connected' ∧ sync_blocked_since IS NULL ∧ last_sync_at within
 *          {@link INBOUND_QUIET_SYNC_FRESH_MS} ∧ initial_import_completed_at NOT NULL ∧
 *          created_at older than {@link INBOUND_QUIET_MIN_AGE_MS}.
 *          The notice CLAIMS "this mailbox syncs fine" — on a broken, blocked, stale or
 *          still-importing mailbox that claim is false and the right surface is the error/block
 *          copy that already exists. The age floor keeps a mailbox connected this week from
 *          being judged at all; import-complete keeps a half-imported history from being read
 *          as quiet.
 *
 *   and ONE of the two arms:
 *
 *   A (comparative)  zero genuine inbound within {@link INBOUND_QUIET_WINDOW_MS} while a
 *          SIBLING connected mailbox on the same account received at least
 *          {@link INBOUND_QUIET_SIBLING_MIN} in the same window. The sibling is the evidence
 *          that mail in general is flowing to this account — a fortnight of account-wide
 *          silence (a vacation, a quiet spell) trips nothing.
 *   B (absolute)     zero genuine inbound within {@link INBOUND_QUIET_ABSOLUTE_MS}, and either
 *          the mailbox HAS older genuine inbound (so its newest is months old — the
 *          connect-a-diverted-mailbox shape) or it is itself older than the absolute window
 *          (months connected, nothing ever). Needs no sibling, so a single-mailbox account is
 *          covered.
 *
 * The stamp is the newest genuine inbound `date` the mailbox holds — `created_at` when it never
 * held one — so the client can say "almost nothing since {date}" from the row itself, and
 * COALESCED: a later pass never advances a live episode's stamp.
 *
 * CLEAR — end the episode (`inbound_quiet_since` → NULL) — only when genuine inbound RESUMES:
 * at least {@link INBOUND_QUIET_RECOVERY_MIN} arrivals within {@link INBOUND_QUIET_WINDOW_MS}.
 * The hysteresis (trip at zero, clear at three) is what makes a dismissal durable on a mailbox
 * that is quiet by nature: ONE stray mail a month must not end the episode — an ended episode
 * re-trips later with a fresh `since`, and a fresh `since` newer than the dismissal re-shows
 * the notice. Three-in-a-fortnight is real flow; after it, a NEW silence is a genuine state
 * change and has earned a fresh notice. Unhealthy states do NOT clear an episode (the episode
 * outlives an outage rather than re-arming against a standing dismissal); the CLIENT gates
 * display on health, this pass gates only the trip.
 *
 * `inbound_quiet_dismissed_at` is never touched here — the dismissal belongs to the user
 * (`POST /mailboxes/:id/inbound-quiet/dismiss`) and holds for as long as the episode does.
 *
 * ── COST, AND WHO CALLS IT ────────────────────────────────────────────────────────────────
 *
 * Per account: one select over the account's mailbox rows, one grouped aggregate over its
 * messages BOUNDED to the absolute window (`date > now − 60d`), plus — only for a mailbox
 * actually crossing into an episode, or a gated candidate with an empty window — one unbounded
 * `max(date)` probe. A settled account pays the bounded aggregate and nothing else, and the
 * cadence is hours ({@link INBOUND_QUIET_EVERY_MS in index.ts}), not the poll path: the DTO the
 * clients read carries the stored columns, so `GET /mailboxes` stays as cheap as it was.
 *
 * TWO production callers, one per DOOR (bubble-up-pass.ts's pattern, same reasons):
 *  · the hosted sync cycle, time-gated, per served account, under the shard's leader lock —
 *    which is why `opts.accountId` is REQUIRED: an unscoped pass under a shard-specific lock
 *    would let shard 1 mutate shard 0's rows;
 *  · `apps/sidecar/src/engine.ts`'s drain tail — the LOCAL store of a standalone install, same
 *    IMAP blind spot, no worker anywhere.
 *
 * Pure and hermetic: a database handle and a clock, so tests drive it against PGlite and replay
 * the incident's timeline as a fixture. No change_log row is emitted — mailbox lifecycle state
 * travels by the polled `GET /mailboxes` read, the same way `last_sync_at` and the error four
 * do — and no log line carries an address (the account and mailbox ids are the loggable facts).
 */

/** The quiet window: zero genuine inbound for this long is "quiet". Generous, deliberately. */
export const INBOUND_QUIET_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** The absolute arm's window: a newest genuine inbound older than this is "months old". */
export const INBOUND_QUIET_ABSOLUTE_MS = 60 * 24 * 60 * 60 * 1000;
/** How much a sibling mailbox must receive inside the window to count as "receiving normally". */
export const INBOUND_QUIET_SIBLING_MIN = 5;
/** How many arrivals inside the window end an episode. Three is flow; one is a stray. */
export const INBOUND_QUIET_RECOVERY_MIN = 3;
/** A mailbox younger than this is never judged — its history may simply not be here yet. */
export const INBOUND_QUIET_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** "Syncs fine" means a completed cycle within this. Staler, and the sync surface owns the story. */
export const INBOUND_QUIET_SYNC_FRESH_MS = 24 * 60 * 60 * 1000;

export interface InboundQuietResult {
  /** Episodes started this pass (a `inbound_quiet_since` stamped where NULL stood). */
  tripped: number;
  /** Episodes ended this pass (genuine inbound resumed). */
  cleared: number;
}

interface Counts {
  /** Genuine inbound with `date` inside {@link INBOUND_QUIET_WINDOW_MS}. */
  recent: number;
  /** Genuine inbound with `date` inside {@link INBOUND_QUIET_ABSOLUTE_MS} (superset of recent). */
  absolute: number;
  /** Newest genuine inbound `date` inside the absolute window, when any. */
  newestBounded: Date | null;
}

export async function inboundQuietPass(
  db: Tx, now: Date, opts: { accountId: string },
): Promise<InboundQuietResult> {
  const { accountId } = opts;
  const windowStart = new Date(now.getTime() - INBOUND_QUIET_WINDOW_MS);
  const absoluteStart = new Date(now.getTime() - INBOUND_QUIET_ABSOLUTE_MS);

  const rows = await db.select({
    id: mailboxes.id,
    status: mailboxes.status,
    createdAt: mailboxes.createdAt,
    lastSyncAt: mailboxes.lastSyncAt,
    syncBlockedSince: mailboxes.syncBlockedSince,
    initialImportCompletedAt: mailboxes.initialImportCompletedAt,
    inboundQuietSince: mailboxes.inboundQuietSince,
  }).from(mailboxes).where(eq(mailboxes.accountId, accountId));
  if (rows.length === 0) return { tripped: 0, cleared: 0 };

  // ONE bounded aggregate for the whole account. The join is what lets one statement apply each
  // mailbox's OWN address to the self-sent exclusion; the `date > absoluteStart` bound is the
  // cost ceiling — a settled account never pays an unbounded scan here.
  const counted = await db.select({
    mailboxId: messages.mailboxId,
    recent: sql<number>`count(*) filter (where ${messages.date} > ${windowStart.toISOString()}::timestamptz)::int`,
    absolute: sql<number>`count(*)::int`,
    newestBounded: sql<Date | null>`max(${messages.date})`,
  }).from(messages)
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(and(
      eq(messages.accountId, accountId),
      isNotNull(messages.date),
      sql`${messages.date} > ${absoluteStart.toISOString()}::timestamptz`,
      sql`lower(${messages.fromAddress}) <> lower(${mailboxes.address})`,
    ))
    .groupBy(messages.mailboxId);
  const byMailbox = new Map<string, Counts>();
  for (const c of counted) {
    byMailbox.set(c.mailboxId, {
      recent: c.recent,
      absolute: c.absolute,
      newestBounded: c.newestBounded === null ? null : asDate(c.newestBounded),
    });
  }
  const countsOf = (id: string): Counts =>
    byMailbox.get(id) ?? { recent: 0, absolute: 0, newestBounded: null };

  // The comparative arm's sibling evidence: the busiest OTHER connected mailbox on the account.
  // Computed per mailbox (excluding itself) so two diverted mailboxes cannot vouch for each other.
  const siblingMax = (selfId: string): number => {
    let max = 0;
    for (const r of rows) {
      if (r.id === selfId || r.status !== "connected") continue;
      const n = countsOf(r.id).recent;
      if (n > max) max = n;
    }
    return max;
  };

  let tripped = 0;
  let cleared = 0;
  for (const m of rows) {
    const counts = countsOf(m.id);

    if (m.inboundQuietSince !== null) {
      // IN AN EPISODE. The only exit is genuine inbound resuming — see the header for why an
      // unhealthy state holds rather than clears. The guard predicate re-asserts the episode so
      // a concurrent clear (another door, an operator) is never overwritten with a second clear.
      if (counts.recent >= INBOUND_QUIET_RECOVERY_MIN) {
        await db.update(mailboxes)
          .set({ inboundQuietSince: null })
          .where(and(
            eq(mailboxes.id, m.id), eq(mailboxes.accountId, accountId),
            isNotNull(mailboxes.inboundQuietSince),
          ));
        cleared += 1;
      }
      continue;
    }

    // NOT IN AN EPISODE. Every gate must hold before either arm is even read: the notice's
    // first claim is "this mailbox syncs fine", and a pass that trips on a broken, blocked,
    // stale, half-imported or week-old mailbox makes that claim false.
    if (m.status !== "connected") continue;
    if (m.syncBlockedSince !== null) continue;
    if (m.initialImportCompletedAt === null) continue;
    if (m.lastSyncAt === null) continue;
    if (now.getTime() - m.lastSyncAt.getTime() > INBOUND_QUIET_SYNC_FRESH_MS) continue;
    if (now.getTime() - m.createdAt.getTime() < INBOUND_QUIET_MIN_AGE_MS) continue;

    const armA = counts.recent === 0 && siblingMax(m.id) >= INBOUND_QUIET_SIBLING_MIN;
    // Arm B's second read needs the unbounded probe only when the bounded window is empty; the
    // probe doubles as the episode's stamp. Run before deciding, because "has older inbound"
    // IS the arm's second clause.
    let newestEver: Date | null = counts.newestBounded;
    if (!armA && counts.absolute !== 0) continue; // neither arm can hold; skip the probe
    if (counts.absolute === 0) {
      const [probe] = await db.select({
        newest: sql<Date | null>`max(${messages.date})`,
      }).from(messages)
        .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
        .where(and(
          eq(messages.accountId, accountId),
          eq(messages.mailboxId, m.id),
          isNotNull(messages.date),
          sql`lower(${messages.fromAddress}) <> lower(${mailboxes.address})`,
        ));
      newestEver = probe?.newest == null ? null : asDate(probe.newest);
    }
    const mailboxIsOld = now.getTime() - m.createdAt.getTime() >= INBOUND_QUIET_ABSOLUTE_MS;
    const armB = counts.absolute === 0 && (newestEver !== null || mailboxIsOld);
    if (!armA && !armB) continue;

    // THE STAMP: the newest genuine inbound this mailbox holds — `created_at` when it never
    // held one — written only over NULL, so a concurrent pass (the other door racing this one)
    // cannot advance a live episode's stamp.
    const since = newestEver ?? m.createdAt;
    await db.update(mailboxes)
      .set({ inboundQuietSince: since })
      .where(and(
        eq(mailboxes.id, m.id), eq(mailboxes.accountId, accountId),
        isNull(mailboxes.inboundQuietSince),
      ));
    tripped += 1;
  }
  return { tripped, cleared };
}

/** drizzle's `sql<Date>` answers a string on some drivers; the arithmetic above needs a Date. */
function asDate(v: Date | string): Date {
  return v instanceof Date ? v : new Date(v);
}
