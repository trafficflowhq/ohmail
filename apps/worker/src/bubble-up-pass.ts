import { and, eq, inArray, lte, type SQL } from "drizzle-orm";
import { messages, messageStates, recordChange, type Tx } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";

/**
 * Bubble-up resurfacing pass. A `message_state` set `bubbled_up` with `bubbleUpAt` in the past flips to
 * `resurfaced` (not `none`) and emits a PAIR of `update` changes — `message_state` AND `message` — through
 * `change_log`, because the client pins on `message.triage.state` and joins nothing (the state change
 * alone moves the row for nobody). Its own module because TWO HOSTS run it and only one has a Postgres
 * pool: `bubble-up-cron.ts` is the hosted CLI backstop, `apps/sidecar` the desktop engine (PGlite, no
 * lock), so the pass lives in the smallest graph, exported `@trafficflow/worker/bubble-up`. `resurfaced`
 * (not `none`) pins the row under its own label, cleared by `MessageService.markSeen`/`patch`/`move`;
 * `bubbleUpAt` cleared with the flip. It does NOT touch read state (the `\Seen` idea removed 2026-08-26).
 * Pure/hermetic (handle + clock); one SELECT over `message_states_account_state_idx` + one UPDATE per due row; `opts.accountId` REQUIRED (shard-specific lock). {@link runBubbleUpCron} is the dead-worker backstop. */
/**
 * SCOPED BY MAILBOX, NOT ONLY BY ACCOUNT: the lease is per mailbox and this pass was per account,
 * so an install organizing one mailbox of an account and standing down on another flipped BOTH
 * from the first one's drain. `opts.mailboxIds` is what the caller organizes at the moment of the
 * call, joined through `messages.mailboxId` (`message_states` carries no mailbox of its own).
 * Omitted, it flips nothing and says why in `refused`, never the old account-wide default; an
 * EMPTY set is no mailbox rather than every mailbox (`inArray` renders `false`). The desktop reads
 * its set through a mask that withholds a mailbox whose poll timer is not armed yet, so a booking
 * due at launch comes back on the first poll rather than inside the launch drain. */
export async function bubbleUpPass(
  db: Tx, now: Date = new Date(),
  opts: { accountId?: string; mailboxIds: readonly string[] },
): Promise<{ flipped: number; refused?: string }> {
  /* FAIL CLOSED ON OMISSION. The type asks for the set, and a caller that reaches here without one
     is JavaScript, a cast, or a host added later — none of which may be answered with every mailbox
     of the account. The reason rides on the return so the caller can log what it got instead of a
     silent zero. */
  if (!Array.isArray(opts?.mailboxIds)) {
    return {
      flipped: 0,
      refused: "no mailbox scope was passed: this pass flips only mailboxes its caller organizes",
    };
  }
  const filters: SQL[] = [
    eq(messageStates.state, "bubbled_up"), lte(messageStates.bubbleUpAt, now),
    // THE MAILBOX TERM, beside the account and never instead of it. Empty renders `false` in this
    // drizzle, which is the fail-closed direction and the reason the arm is not omitted when empty.
    inArray(messages.mailboxId, [...opts.mailboxIds]),
  ];
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
    })
    .from(messageStates)
    // The join IS the mailbox filter: the state row points at one message and a message belongs to
    // exactly one mailbox (`messages.mailbox_id`, NOT NULL), so an inner join drops no due row.
    .innerJoin(messages, eq(messages.id, messageStates.messageId))
    .where(and(...filters));

  let flipped = 0;
  for (const row of due) {
    const didFlip = await db.transaction(async (tx) => {
      // THE LOCK ORDER: messages first, then message_states — the same order
      // `TriageService.setState` takes (its cross-account guard select is FOR UPDATE on the
      // message row), so a due flip overlapping a user transition on one message QUEUES
      // instead of deadlocking (found in the re-homing: opposing first locks were a
      // Postgres deadlock, aborting whichever side lost).
      await dialect(db).forUpdate(tx.select({ id: messages.id }).from(messages)
        .where(eq(messages.id, row.messageId)));
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
      await recordChange(tx, {
        accountId: row.accountId, entityType: "message_state", entityId: row.id, op: "update", meta: null,
      });
      /**
       * AND THE MESSAGE, BECAUSE ITS DTO EMBEDS THIS STATE. Without this second change the flip reached NO
       * live client: `MessageDTO.triage` projects the row, `selectors.ts#isResurfaced` reads
       * `message.triage.state`, and the client joins nothing (`apply.ts` is a keyed upsert per (type,id)),
       * so a delta carrying only the `message_state` change moved that entity while the `message` entity's
       * `triage` went on saying `bubbled_up` until a re-bootstrap. That made the feature invisible in the
       * case it exists for (nobody watching at the due moment). `TriageService.setState` emits the same pair
       * and `MessageService.markSeen` did before either — the third and last writer that was missing it.
       * SECOND, so the higher seq belongs to the `message` change (apply in ascending seq lands the state
       * then the projection that reads it). */
      await recordChange(tx, {
        accountId: row.accountId, entityType: "message", entityId: row.messageId, op: "update", meta: null,
      });
      return true;
    });
    if (didFlip) flipped++;
  }

  return { flipped };
}
