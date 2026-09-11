import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { mailboxes, messages, type Tx } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";

/**
 * THE INBOUND-QUIET PASS — the forwarding-detection heuristic (mail 0078) and the single owner of its
 * predicate. It exists because a provider-level forward diverted every inbound mail BEFORE IMAP storage
 * while every per-cycle signal said the mailbox was healthy — absence of arrivals is the one shape no
 * per-cycle signal carries (`storage_at_cap` in `alerts.ts` makes the same argument). Genuine inbound
 * excludes the user's own sends (`lower(from_address) <> lower(mailbox.address)`); tombstones and junk are
 * NOT excluded (they still prove arrival); TWO CLOCKS split by what each answers honestly — `created_at`
 * (ingestion, unforgeable) for "arriving now", the header `date` (bounded by `now`) for "what the history
 * claims". It TRIPS (`inbound_quiet_since`) only on a connected, unblocked, fresh, import-complete mailbox
 * with zero recent ingest, via a comparative sibling arm or an absolute arm; CLEARS on {@link INBOUND_QUIET_RECOVERY_MIN} arrivals (hysteresis makes a dismissal durable). All thresholds are exported `INBOUND_QUIET_*` constants; `inbound_quiet_dismissed_at` is the user's. Two callers (hosted cycle under the shard lock, `apps/sidecar`'s drain), cadence `INBOUND_QUIET_EVERY_MS`; no change_log row. */

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
  /**
   * Genuine inbound INGESTED inside {@link INBOUND_QUIET_WINDOW_MS} — `created_at`, never the
   * header date, and rows with no header date count too. This is the ARRIVAL evidence (arm A's
   * zero-test, the recovery clear), and ingestion is the one clock a sender cannot choose: a
   * future-dated header would otherwise read as "recent" for ever with no upper bound, and a
   * delayed, imported or date-less message would be invisible exactly when it proves the
   * mailbox is receiving again (review finding, round 1).
   */
  recentIngested: number;
  /**
   * The subset of {@link recentIngested} ingested AFTER the mailbox's own initial import
   * completed — the only ingestion that proves LIVE arrival. A freshly connected mailbox's
   * import writes months of history with today's `created_at`, and five such rows must not let
   * that mailbox vouch that mail is flowing to this account (review finding, round 2: an
   * established quiet mailbox would be tripped by nothing more than a sibling being connected).
   * NULL/incomplete import ⇒ zero — a mailbox mid-import can vouch for nothing.
   */
  recentPostImport: number;
  /**
   * Genuine inbound whose HEADER DATE lies inside {@link INBOUND_QUIET_ABSOLUTE_MS} and not in
   * the future. The header date is the honest clock ACROSS an initial import — everything
   * imported yesterday was ingested yesterday, so `created_at` says nothing about a history's
   * shape — which is what lets a freshly connected, long-diverted mailbox trip within days.
   * Bounded above by `now` so a future-dated message cannot hold the absolute arm shut.
   */
  absoluteDated: number;
  /** Newest genuine inbound header `date` inside that bounded window, when any. */
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

  // ONE bounded aggregate for the whole account. The join applies each mailbox's OWN address to the
  // self-sent exclusion; the `date > absoluteStart` bound is the cost ceiling (a settled account never pays
  // an unbounded scan). TWO CLOCKS in one statement, a review finding not a taste: `created_at` (ingestion,
  // ours, unforgeable) answers "is mail arriving NOW", `date` (the header, the sender's, bounded by `now`)
  // answers "what does the history claim". The row bound is the LOOSER of the two windows on each clock, so
  // both filters see every row they may count. An instant is a different LITERAL on each store (an ISO
  // string vs a millisecond count), and a comparison against the wrong one quietly matches nothing, so
  // every bound goes through the seam.
  const d = dialect(db);
  const windowAt = d.ts(windowStart);
  const absoluteAt = d.ts(absoluteStart);
  const nowAt = d.ts(now);
  const counted = await db.select({
    mailboxId: messages.mailboxId,
    recentIngested: sql<number>`${d.castInt(sql`count(*) filter (where ${messages.createdAt} > ${windowAt})`)}`,
    recentPostImport: sql<number>`${d.castInt(sql`count(*) filter (where ${messages.createdAt} > ${windowAt} and ${mailboxes.initialImportCompletedAt} is not null and ${messages.createdAt} > ${mailboxes.initialImportCompletedAt})`)}`,
    absoluteDated: sql<number>`${d.castInt(sql`count(*) filter (where ${messages.date} > ${absoluteAt} and ${messages.date} <= ${nowAt})`)}`,
    newestBounded: sql<Date | null>`max(${messages.date}) filter (where ${messages.date} > ${absoluteAt} and ${messages.date} <= ${nowAt})`,
  }).from(messages)
    .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
    .where(and(
      eq(messages.accountId, accountId),
      sql`(${messages.createdAt} > ${windowAt} or (${messages.date} is not null and ${messages.date} > ${absoluteAt}))`,
      sql`lower(${messages.fromAddress}) <> lower(${mailboxes.address})`,
    ))
    .groupBy(messages.mailboxId);
  const byMailbox = new Map<string, Counts>();
  for (const c of counted) {
    byMailbox.set(c.mailboxId, {
      recentIngested: c.recentIngested,
      recentPostImport: c.recentPostImport,
      absoluteDated: c.absoluteDated,
      newestBounded: c.newestBounded === null ? null : asDate(c.newestBounded),
    });
  }
  const countsOf = (id: string): Counts =>
    byMailbox.get(id) ?? { recentIngested: 0, recentPostImport: 0, absoluteDated: 0, newestBounded: null };

  // The comparative arm's sibling evidence: the busiest OTHER connected mailbox on the account.
  // Computed per mailbox (excluding itself) so two diverted mailboxes cannot vouch for each
  // other — and read from POST-IMPORT ingestion only, so a sibling connected yesterday cannot
  // vouch with the historical rows its own initial import just wrote (round 2's finding).
  const siblingMax = (selfId: string): number => {
    let max = 0;
    for (const r of rows) {
      if (r.id === selfId || r.status !== "connected") continue;
      const n = countsOf(r.id).recentPostImport;
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
      if (counts.recentIngested >= INBOUND_QUIET_RECOVERY_MIN) {
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

    // BOTH arms require zero genuine INGESTION inside the window — mail that is demonstrably
    // arriving (whatever its headers claim, or with none at all) must hold every trip back.
    if (counts.recentIngested !== 0) continue;
    const armA = siblingMax(m.id) >= INBOUND_QUIET_SIBLING_MIN;
    // Arm B's second read needs the unbounded probe only when the bounded window is empty; the
    // probe doubles as the episode's stamp. Run before deciding, because "has older inbound"
    // IS the arm's second clause.
    let newestEver: Date | null = counts.newestBounded;
    if (!armA && counts.absoluteDated !== 0) continue; // neither arm can hold; skip the probe
    if (counts.absoluteDated === 0) {
      const [probe] = await db.select({
        newest: sql<Date | null>`max(${messages.date})`,
      }).from(messages)
        .innerJoin(mailboxes, eq(mailboxes.id, messages.mailboxId))
        .where(and(
          eq(messages.accountId, accountId),
          eq(messages.mailboxId, m.id),
          isNotNull(messages.date),
          // The same upper bound as the windowed aggregate: a future-dated header is not
          // history, and stamping one would put the episode's "since" ahead of the clock.
          sql`${messages.date} <= ${d.ts(now)}`,
          sql`lower(${messages.fromAddress}) <> lower(${mailboxes.address})`,
        ));
      newestEver = probe?.newest == null ? null : asDate(probe.newest);
    }
    const mailboxIsOld = now.getTime() - m.createdAt.getTime() >= INBOUND_QUIET_ABSOLUTE_MS;
    const armB = counts.absoluteDated === 0 && (newestEver !== null || mailboxIsOld);
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
