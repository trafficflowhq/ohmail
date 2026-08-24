import { and, eq, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { flagState, messages, messageStates, recordChange, type Tx } from "@trafficflow/db";

/**
 * Bubble-up resurfacing pass. A `message_state` set to
 * `bubbled_up` with a `bubbleUpAt` in the past is flipped to `resurfaced` — NOT straight back to
 * `none` — and a PAIR of `update` changes, `message_state` and `message`, is emitted through the
 * SAME `change_log` seam every client-visible mutation uses, so the item reappears on the next
 * `/sync`. The pair is not belt-and-braces: the client pins on `message.triage.state` and joins
 * nothing, so the `message_state` change alone moved the row for nobody. See the transaction.
 *
 * ── WHY THIS IS A MODULE OF ITS OWN, AND NOT A FUNCTION IN `bubble-up-cron.ts` ─────────────
 *
 * Because TWO HOSTS run it, and only one of them may have a Postgres pool.
 *
 * `bubble-up-cron.ts` is the hosted CLI backstop: it reaches `acquireLeaderLock` (and through it
 * the `postgres` driver), `makeOwnedDb`, the served-account roster and the cron logger. The
 * DESKTOP engine (`apps/sidecar`) must reach none of that — its store is an on-disk PGlite file,
 * it has no shard, no leader lock and no network database — which is why
 * this package deliberately publishes narrow subpaths instead of a `.` barrel. So
 * the pass lives in the module with the smallest possible graph (drizzle plus the mail tables),
 * exported as `@trafficflow/worker/bubble-up`, and BOTH hosts call this one implementation. A
 * second copy on the desktop would be a second answer to "when does a resurface become due".
 *
 * ── WHY `resurfaced` AND NOT `none` ───────────────────────────────────────────────────────
 *
 * `none` would drop the item back into whatever group it left from — most often "Earlier", read,
 * indistinguishable from mail nobody asked to see again. The whole point of a resurface is that
 * the user scheduled THIS moment, so `resurfaced` is a distinct state that pins the row at the top
 * of the Ohbox under its own quiet label (`ohboxView.resurfaced`). It is cleared back to `none`
 * server-side the moment the user reads, replies to or re-files the row — see
 * `MessageService.markSeen`/`patch`/`move` — and deliberately NOT on merely opening it, so a
 * glance does not spend the resurface.
 *
 * `bubbleUpAt` is cleared with the flip: the schedule is spent, and a stale timestamp on a
 * `resurfaced` row would read as "still scheduled". Each flip runs in its own transaction
 * (sequence allocation, update and change_log commit atomically), and re-asserts `state='bubbled_up'`
 * in the UPDATE so a concurrent flip can't double-emit.
 *
 * ── THE FLIP RE-UNREADS THE MESSAGE, AND THAT IS AN EVENT, NOT AN IMPORT DEFAULT ──────────
 *
 * A resurface is "show me this again NOW", and the product's one honest way to draw an eye to a
 * row is its unread state. Most snoozed mail was read before it was put away, so without this the
 * pin came back grey — inspected-looking — at exactly the moment the user asked for attention. So
 * the SAME transaction that flips the state forces `messages.unread = true` (and clears
 * `lastReadAt` — the reading it recorded has been deliberately disowned), and writes the
 * `flag_state` intent `desired_seen = false, last_set_by = 'us'` so the reconcile pass REMOVES
 * `\Seen` on the real server. The mailbox is the master: without the intent row the next
 * flag adoption would re-import the server's stale `\Seen` and silently re-read the row —
 * and with it, `applyExternalFlag`'s our-write-pending guard makes the re-unread win, exactly as
 * a user's own "mark unread" does. This fires ONCE, on the due event; ordinary re-imports of an
 * already-resurfaced row never re-mark anything, which is what lets `\Seen`-honouring at import
 * and resurface-re-unread coexist.
 *
 * Pure and hermetic: takes a database handle and a clock, so tests drive it against
 * PGlite without any leader lock or network.
 *
 * ── THE QUERY SHAPE IS THE COST ARGUMENT ──────────────────────────────────────────────────
 *
 * One SELECT over `message_states_account_state_idx` — `(account_id, state)` — plus one UPDATE
 * per DUE row, and nothing else. An account with no bubbled-up mail costs one index probe that
 * returns no rows, which is what makes this affordable on the desktop's per-poll cadence as well
 * as on the hosted worker's cycle. The clock is a parameter rather than a `WHERE now()` so the
 * cost never depends on how the caller obtained it.
 *
 * `opts.accountId` SCOPES the pass to one account. EVERY CALLER SUPPLIES IT, one account at a
 * time: the hosted worker and the CLI wrapper each take a SHARD-SPECIFIC advisory lock, so an
 * unscoped pass would let shard 1 mutate shard 0's rows while shard 0's worker holds a
 * different lock and believes it is the only writer. The desktop passes its single local account
 * for a narrower reason — the local database has exactly one, and a scoped query is the one whose
 * cost is bounded by the index.
 *
 * ── WHO CALLS THIS, AND WHY THE ORDER OF THAT SENTENCE MATTERS ────────────────────────────
 *
 * TWO production callers, one per DOOR:
 *
 *  · the hosted sync cycle, gated by `BUBBLE_UP_EVERY_MS` — the hosted store,
 *    which is authoritative for a Cloud account and for the desktop's Cloud-door mirror (that
 *    mirror learns the flip as an ordinary `message_state` delta, so it must not flip anything
 *    itself);
 *  · `apps/sidecar/src/engine.ts`'s drain — the LOCAL store of a standalone install, which has no
 *    worker anywhere and is authoritative for itself.
 *
 * {@link runBubbleUpCron} in `bubble-up-cron.ts` is the manual backstop for a dead worker and is
 * invoked by nothing on a schedule — it cannot be, because it takes the lock the live worker
 * holds.
 *
 * The header of the cron module used to say "the cron wrapper always supplies it" and stopped
 * there, which read as if the wrapper were the producer. It was not: for the whole of this
 * function's life NOTHING in production called it, while the resurface shortcut told users
 * "Resurfaces {when}" with a real date on it. Seven green tests covered an uncalled function.
 * The hosted door was wired first; the same defect was then found still live on the standalone
 * install, which has no worker at all. A test names BOTH callers, so losing either one is red.
 */
export async function bubbleUpPass(
  db: Tx, now: Date = new Date(), opts: { accountId?: string } = {},
): Promise<{ flipped: number; rescued: number }> {
  const filters: SQL[] = [eq(messageStates.state, "bubbled_up"), lte(messageStates.bubbleUpAt, now)];
  if (opts.accountId) filters.push(eq(messageStates.accountId, opts.accountId));
  // `lte` against a PAST `bubbleUpAt` is the point, not an accident of the comparison: a schedule
  // that expired while nothing was running (a closed laptop, a stood-down worker) is exactly as
  // due as one that expired this minute, so it fires on the next pass rather than being dropped.
  const due = await db
    .select({
      id: messageStates.id,
      accountId: messageStates.accountId,
      // Selected for the SECOND change this pass emits — see the pair inside the transaction.
      messageId: messageStates.messageId,
      // The server's read-state BEFORE the flip forces unread — the honest `observed_seen` for a
      // `flag_state` row that does not exist yet (the same fallback `upsertDesiredSeen` uses).
      wasUnread: messages.unread,
    })
    .from(messageStates)
    .innerJoin(messages, eq(messages.id, messageStates.messageId))
    .where(and(...filters));

  let flipped = 0;
  for (const row of due) {
    const didFlip = await db.transaction(async (tx) => {
      // THE LOCK ORDER: messages first, then message_states — the same order
      // `TriageService.setState` takes (its cross-account guard select is FOR UPDATE on the
      // message row), so a due flip overlapping a user transition on one message QUEUES
      // instead of deadlocking (review round on the re-homing: opposing first locks were a
      // Postgres deadlock, aborting whichever side lost).
      await tx.select({ id: messages.id }).from(messages)
        .where(eq(messages.id, row.messageId)).for("update");
      const updated = await tx
        .update(messageStates)
        // `setAt` refreshes here too: it is "when the CURRENT state was set", and this flip
        // SETS `resurfaced` — a row scheduled at t1 and fired at t2 must sync setAt = t2, or
        // the DTO's timestamp differs by transition path (the direct `resurface_now` stamps
        // its own instant). `spendResurface` stays the one deliberate preserver.
        .set({ state: "resurfaced", bubbleUpAt: null, setAt: now, updatedAt: now })
        .where(and(eq(messageStates.id, row.id), eq(messageStates.state, "bubbled_up")))
        .returning({ id: messageStates.id });
      if (updated.length === 0) return false;
      // The due event's re-unread — see the header. Inside the flip's claim (the guarded UPDATE
      // above), so a concurrent pass that lost the claim writes none of this.
      await forceUnread(tx, row.messageId, row.wasUnread, now);
      await recordChange(tx, {
        accountId: row.accountId, entityType: "message_state", entityId: row.id, op: "update", meta: null,
      });
      /**
       * ── AND THE MESSAGE, BECAUSE ITS DTO EMBEDS THIS STATE ────────────────────────────────
       *
       * Without this second change the flip reached NO live client. `MessageDTO.triage` is a
       * projection of the row just written, and `selectors.ts#isResurfaced` — the whole of how
       * the Ohbox pins a resurfaced row — reads `message.triage.state`. The client joins nothing:
       * `apply.ts` is a keyed upsert per (type,id) and derives no entity from another. So a delta
       * carrying only the `message_state` change moved the row in one mirror entity while the
       * `message` entity's `triage` field, applied at an earlier seq and never touched again,
       * went on saying `bubbled_up` — and the pin appeared only after a re-bootstrap.
       *
       * That made the whole feature invisible in the case it exists for: nobody is looking at
       * the mailbox at the moment a schedule comes due, so the flip is ALWAYS delivered as a
       * delta to an already-running client. A user who left the app open saw nothing happen at
       * the time they had chosen.
       *
       * `TriageService.setState` emits the same pair for the same reason, and
       * `MessageService.markSeen` did before either of them. This is the third and last writer of
       * `message_states` that was missing it.
       *
       * SECOND, so the higher seq belongs to the `message` change: a client that applies a page
       * in ascending seq lands the state and then the projection that reads it.
       */
      await recordChange(tx, {
        accountId: row.accountId, entityType: "message", entityId: row.messageId, op: "update", meta: null,
      });
      return true;
    });
    if (didFlip) flipped++;
  }

  const rescued = await rescueOrphanedResurfaces(db, now, opts);
  return { flipped, rescued };
}

/**
 * RECONCILIATION — resurfaced rows whose due event fired WITHOUT the re-unread, healed in place.
 *
 * Flips older than the re-unread above left real mail in a state no view files: `resurfaced`
 * (out of the Resurface pile by definition) and read (grey even where it was pinned) — and on a
 * cutline-partitioned account, out of every list entirely until the client-side fixes. The rows
 * are still in the database and still `resurfaced`, so the owed mark is recoverable: this applies
 * it, idempotently, on every pass.
 *
 * ── THE PREDICATE IS THE WHOLE SAFETY ARGUMENT ────────────────────────────────────────────
 *
 * A candidate is `state = 'resurfaced'` AND read AND `last_read_at` ABSENT OR OLDER THAN THE PIN
 * (`message_states.updated_at`, which the flip and `TriageService.setState` both stamp). That
 * last clause is what distinguishes "the due event owed this row an unread it never got" (the
 * reading predates the pin) from "somebody read it AFTER it resurfaced":
 *
 *  · an in-app read cannot produce a post-pin candidate at all — `markSeen`/`patch` clear
 *    `resurfaced` back to `none` in the same transaction that marks read;
 *  · a read adopted from ANOTHER CLIENT leaves the pin standing (`applyExternalFlag` touches no
 *    triage state) and stamps `last_read_at` with the adoption instant — post-pin, so this pass
 *    keeps its hands off. Re-marking that row would be the product arguing with a reading the
 *    user really did, cycle after cycle;
 *  · `last_read_at IS NULL` on a read row means the reading predates the column or arrived
 *    where nothing could date it — either way it predates the pin, which post-dates both.
 *
 * The re-assert inside the UPDATE (still read, reading still pre-pin) is the same
 * lost-claim-writes-nothing rule the flip uses: a user who reads the row between the SELECT and
 * the UPDATE stamps `last_read_at = now` in `markSeen`'s transaction, the predicate goes false,
 * and this row is skipped rather than re-unread out from under them.
 *
 * Idempotent by construction — a rescued row is unread, and unread rows are not candidates.
 */
async function rescueOrphanedResurfaces(
  db: Tx, now: Date, opts: { accountId?: string },
): Promise<number> {
  const filters: SQL[] = [
    eq(messageStates.state, "resurfaced"),
    eq(messages.unread, false),
    or(isNull(messages.lastReadAt), lt(messages.lastReadAt, messageStates.updatedAt))!,
  ];
  if (opts.accountId) filters.push(eq(messageStates.accountId, opts.accountId));
  const orphaned = await db
    .select({
      accountId: messageStates.accountId,
      messageId: messageStates.messageId,
      pinnedAt: messageStates.updatedAt,
    })
    .from(messageStates)
    .innerJoin(messages, eq(messages.id, messageStates.messageId))
    .where(and(...filters));

  let rescued = 0;
  for (const row of orphaned) {
    const didRescue = await db.transaction(async (tx) => {
      const updated = await tx
        .update(messages)
        .set({ unread: true, lastReadAt: null, updatedAt: now })
        .where(and(
          eq(messages.id, row.messageId),
          eq(messages.unread, false),
          or(isNull(messages.lastReadAt), lt(messages.lastReadAt, row.pinnedAt)),
        ))
        .returning({ id: messages.id });
      if (updated.length === 0) return false;
      await upsertDesiredUnseen(tx, row.messageId, /* wasUnread */ false, now);
      // Only the message moved (the state row already said `resurfaced`), so only the message
      // change is emitted — the projection every client pins and bolds on.
      await recordChange(tx, {
        accountId: row.accountId, entityType: "message", entityId: row.messageId, op: "update", meta: null,
      });
      return true;
    });
    if (didRescue) rescued++;
  }
  return rescued;
}

/** The re-unread: the read model, the reading order, and the IMAP intent — one event, one tx. */
async function forceUnread(tx: Tx, messageId: string, wasUnread: boolean, now: Date): Promise<void> {
  await tx
    .update(messages)
    .set({ unread: true, lastReadAt: null, updatedAt: now })
    .where(eq(messages.id, messageId));
  await upsertDesiredUnseen(tx, messageId, wasUnread, now);
}

/**
 * `flag_state` desired `\Seen = false`, by us — `MessageService.upsertDesiredSeen` with the
 * desired side pinned to unseen. Inlined rather than imported because this module's import graph
 * is the desktop bundle's boundary (see the header): drizzle plus the mail tables, never
 * the services package (kept out of this module's import graph on purpose). `observed_seen` is written only on INSERT (the worker owns it after
 * that), and `reconcile_status` is recomputed against the STORED observation on conflict, so a
 * row the server already reports unseen never queues an IMAP round trip.
 */
async function upsertDesiredUnseen(tx: Tx, messageId: string, wasUnread: boolean, now: Date): Promise<void> {
  await tx.insert(flagState).values({
    messageId, desiredSeen: false, observedSeen: !wasUnread,
    lastSetBy: "us", reconcileStatus: wasUnread ? "reconciled" : "pending", conflict: false,
  }).onConflictDoUpdate({
    target: flagState.messageId,
    set: {
      desiredSeen: false, lastSetBy: "us", conflict: false, updatedAt: now,
      reconcileStatus: sql`case when ${flagState.observedSeen} = false then 'reconciled' else 'pending' end`,
    },
  });
}
