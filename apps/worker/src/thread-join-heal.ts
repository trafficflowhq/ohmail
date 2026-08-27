import { and, asc, eq, sql } from "drizzle-orm";
import { mailboxes, messages, recordChanges, threads, type LedgerTx, type Tx } from "@trafficflow/db";
import {
  conversationJoinVerdict, silentLogger,
  type ConversationJoinFacts, type EmailAddress, type Logger,
} from "@trafficflow/core";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE THREAD-JOIN HEAL — the deferred merge for conversations a forward split
   ══════════════════════════════════════════════════════════════════════════════════════════

   ── WHAT IT REPAIRS, AND WHY NEITHER EXISTING THREAD PASS CAN ──────────────────────────────

   `thread-backfill.ts` heals thread IDENTITY where `thread_id IS NULL`; `thread-subject-heal.ts`
   heals thread NAMES. Both presuppose that the header chain, once read, puts every message of a
   conversation in one thread. Production showed the case where it structurally cannot: the user
   mails a correspondent, the correspondent's reply lands at ANOTHER of the user's addresses,
   and the user forwards it here. The forward carries no `In-Reply-To` and no `References`, so
   the mailbox holds two header chains that are disjoint by construction — the original outbound
   message alone, and the forward plus everything that correctly chains onto it. Every row was
   threaded RIGHT and the conversation still renders as two threads.

   The joining evidence is not in any header; it accumulates across messages and completes only
   when the counterparty appears on BOTH chains. So the join is a deferred, evidence-complete
   MERGE — `conversationJoinVerdict` in packages/core states the guards and why each one is
   load-bearing — performed here exactly the way `ThreadService.merge` performs the user's own:
   messages reassigned onto the surviving thread, the emptied thread deleted, and the change log
   told about every touched row in the same transaction.

   ── THE SURVIVOR IS THE OLDEST THREAD ──────────────────────────────────────────────────────

   The earliest first-message date wins and keeps its id, name and root anchor. Merging INTO the
   conversation's true start means a client scrolled to the top of the healed thread reads it in
   the order it happened, and repeated heals are stable: the survivor of run N is the survivor
   of run N+1.

   ── WHAT DELETING THE ABSORBED THREAD COSTS, AND WHY THAT IS ACCEPTED ──────────────────────

   The absorbed thread's `root_message_id_header` row disappears, so a LATER out-of-order
   arrival that anchors on exactly that root — and whose every parent candidate somehow misses
   rows that are still right here in `messages` — would recreate a split. That takes a message
   referencing ONLY ids this mailbox has never stored, arriving after the merge; and this pass
   recurs, so the recreated split is re-evaluated and re-merged on the next run. Convergence
   over a rare re-split beats a ghost `threads` row every client list has to skip — the same
   trade `ThreadService.merge` already made for the user-initiated case.

   ── BOUNDS, IDEMPOTENCE, LOCK ORDER ────────────────────────────────────────────────────────

   Keyset pagination over (account_id, subject) duplicate groups — the SQL pre-filter; the JS
   verdict re-derives base subjects from each thread's FIRST MESSAGE, so a stored name (which a
   user may have renamed) can neither force nor forge a merge. A merged group leaves the
   predicate (one thread remains), so a second run selects nothing: idempotent. Every group is
   one transaction; data locks first (`messages` moves, `threads` update/delete), the account's
   seq lock (`recordChanges`) LAST — the order `ThreadResolution.changes` documents as the one
   that cannot deadlock ingest. A group that fails (say, its survivor was deleted mid-flight by
   a user merge) is logged and skipped; the next run re-reads reality.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/** Duplicate-subject groups examined per invocation — the run's hard budget. */
export const THREAD_JOIN_HEAL_MAX_GROUPS = 200;

/** Threads examined per group. Beyond this the group is logged and left alone — a subject
 * shared by dozens of threads is a newsletter or a ticket queue, not one split conversation. */
export const THREAD_JOIN_HEAL_MAX_THREADS_PER_GROUP = 12;

/** Messages sampled per thread for dates/subjects/correspondents. Enough to see every
 * participant of any human conversation; a cap so a notification-scale thread costs one page. */
export const THREAD_JOIN_HEAL_MAX_MESSAGES_PER_THREAD = 500;

/**
 * An address that participates (author or recipient) in at least this many of the account's
 * threads is DISQUALIFIED as a join witness: its presence on both sides of a pair is treated
 * like one of the account's own addresses — no evidence at all.
 *
 * The threshold was cut from a measured distribution, not intuition. In a real, decade-scale
 * account the account holder's FORMER identities (an imported history carries them, and they
 * are not mailbox rows), long-standing frequent correspondents, and notification senders all
 * measure in the many hundreds to thousands of threads, while a genuine conversation-scale
 * correspondent sits far below 200. Every address in the first three classes has thousands of
 * subject-collision chances inside any 14-day window, which is exactly the false-merge tail
 * the minus-self guard exists to starve — and a witness this promiscuous can also FORGE
 * nothing about two particular threads being one conversation. The cost is deliberate and
 * one-sided: a true split whose only shared correspondent is a super-frequent colleague stays
 * split (the recoverable direction, and the next run re-looks); a false merge has no undo.
 */
export const THREAD_JOIN_WITNESS_SPREAD_MAX = 200;

/** Where one invocation stopped — hand it back in to continue instead of rescanning. */
export interface ThreadJoinHealCursor { accountId: string; subject: string }

export interface ThreadJoinHealDeps {
  db: Tx;
  /** False ⇒ dry run: derive facts, take verdicts, log, write nothing. */
  apply: boolean;
  /** Restrict to one account (the sync-cycle caller); absent ⇒ fleet-wide (the runner). */
  accountId?: string;
  log?: Logger;
  maxGroups?: number;
  now?: () => Date;
  /**
   * Resume AFTER this group. Without it a capped run's successor rescans from the top, and a
   * group whose verdict is "no" never leaves the candidate predicate — so a caller looping on
   * `capped` alone would walk the same refusals for ever. The one-shot runner threads
   * `result.cursor` through; the sync-cycle caller deliberately does not (each gated run takes
   * a fresh look, and its per-account budget makes a full rescan cheap).
   */
  cursor?: ThreadJoinHealCursor;
}

export interface ThreadJoinHealResult {
  /** Duplicate-subject groups the pre-filter surfaced and the pass examined. */
  groupsScanned: number;
  /** Threads absorbed into an older sibling (dry run: would be). */
  merged: number;
  /** Messages moved onto a surviving thread (dry run: would be). */
  messagesMoved: number;
  /** Groups skipped: over the per-group bound, or failed mid-transaction and left for next run. */
  skipped: number;
  /** True ⇒ the group budget ran out before the candidate set did; resume from `cursor`. */
  capped: boolean;
  /** The last group examined — the resume point for a follow-on invocation. */
  cursor: ThreadJoinHealCursor | null;
}

interface ThreadFacts extends ConversationJoinFacts {
  id: string;
  participants: EmailAddress[];
}

export async function threadJoinHealPass(deps: ThreadJoinHealDeps): Promise<ThreadJoinHealResult> {
  const { db, apply } = deps;
  const log = deps.log ?? silentLogger;
  const now = deps.now ?? (() => new Date());
  const maxGroups = Math.min(deps.maxGroups ?? THREAD_JOIN_HEAL_MAX_GROUPS, THREAD_JOIN_HEAL_MAX_GROUPS);

  const result: ThreadJoinHealResult = { groupsScanned: 0, merged: 0, messagesMoved: 0, skipped: 0, capped: false, cursor: null };
  const selfByAccount = new Map<string, Set<string>>();
  let cursor: ThreadJoinHealCursor | null = deps.cursor ?? null;

  while (result.groupsScanned < maxGroups) {
    // ── The pre-filter: accounts holding two or more threads under one stored name. ─────────
    // Stored names are written through `baseSubject` at create and were normalized fleet-wide
    // by the thread-name heal, so same-conversation splits share their stored name; a thread
    // the user renamed falls out of its group here, which is the rename OPTING OUT of the
    // heal's attention — never a forced merge, and never a forged one (the verdict re-derives
    // from messages regardless).
    // Annotated, and the cursor read into locals FIRST: the raw `execute` result otherwise
    // participates in its own type inference through `cursor` (TS7022), and postgres-js hands
    // back an array-like RowList rather than a plain array.
    const cursorAccountId: string | null = cursor?.accountId ?? null;
    const cursorSubject: string | null = cursor?.subject ?? null;
    const executed: unknown = await db.execute(sql`
      select account_id, subject
      from ${threads}
      where ${deps.accountId ? sql`account_id = ${deps.accountId}` : sql`true`}
        and ${cursorAccountId !== null
          ? sql`(account_id, subject) > (${cursorAccountId}::uuid, ${cursorSubject})`
          : sql`true`}
      group by account_id, subject
      having count(*) > 1
      order by account_id, subject
      limit ${Math.min(50, maxGroups - result.groupsScanned)}
    `);
    const groups: Array<{ account_id: string; subject: string }> = Array.isArray(executed)
      ? executed
      : (executed as { rows: Array<{ account_id: string; subject: string }> }).rows;
    if (groups.length === 0) break;
    const last = groups[groups.length - 1]!;
    cursor = { accountId: last.account_id, subject: last.subject };
    result.cursor = cursor;

    for (const group of groups) {
      result.groupsScanned += 1;

      const rows = await db.select({
        id: threads.id, participants: threads.participants,
      }).from(threads)
        .where(and(eq(threads.accountId, group.account_id), eq(threads.subject, group.subject)))
        .orderBy(asc(threads.id))
        .limit(THREAD_JOIN_HEAL_MAX_THREADS_PER_GROUP + 1);
      if (rows.length > THREAD_JOIN_HEAL_MAX_THREADS_PER_GROUP) {
        // No subject on any line here: it is user content the log census deny-lists anyway,
        // and the thread ids are enough to find it in the database.
        log.warn("thread_join_heal_group_over_bound", {
          accountId: group.account_id, considered: rows.length,
          reason: "a subject shared this widely is a mailing pattern, not one split conversation",
        });
        result.skipped += 1;
        continue;
      }
      if (rows.length < 2) continue; // merged or deleted since the pre-filter read

      let self = selfByAccount.get(group.account_id);
      if (!self) {
        const own = await db.select({ address: mailboxes.address }).from(mailboxes)
          .where(eq(mailboxes.accountId, group.account_id));
        // Every address the account has EVER synced under counts as self, disconnected ones
        // included — mail to a former address still says only "both threads involve this
        // account", which is true of every pair and proves nothing.
        self = new Set(own.map((m) => m.address.toLowerCase()));

        // ── AND every address too widespread in the account to witness anything. ────────────
        //
        // The mailbox rows are not the whole of the disqualified set: an imported history
        // carries the account holder's FORMER identities, which are not mailbox rows and
        // would otherwise count as a counterparty — and an overlap consisting only of "mail
        // involving one of this account's old addresses" is exactly the false-merge machine
        // the verdict's minus-self guard exists to starve ("Re: Rechnung" from two unrelated
        // vendors to one old address, inside the window, would merge).
        // Measured rather than declared, over author AND recipient sides, because the risk is
        // the same regardless of which side the address sat on — see the threshold constant
        // for the distribution it was cut from. This only ever REMOVES evidence: it can
        // starve a true join into staying split (the recoverable direction), never forge one.
        const spread = await db.execute(sql`
          select addr from (
            select addr, count(distinct thread_id) as spread from (
              select thread_id, lower(from_address) as addr
              from ${messages}
              where account_id = ${group.account_id} and from_address <> ''
              union all
              select m.thread_id, lower(x->>'address')
              from ${messages} m, jsonb_array_elements(m.to_addresses || m.cc_addresses) x
              where m.account_id = ${group.account_id}
            ) participant
            where addr is not null and addr <> ''
            group by addr
          ) freq
          where spread >= ${THREAD_JOIN_WITNESS_SPREAD_MAX}
        `);
        const spreadRows: Array<{ addr: string }> = Array.isArray(spread)
          ? spread
          : (spread as { rows: Array<{ addr: string }> }).rows;
        for (const r of spreadRows) self.add(r.addr);
        selfByAccount.set(group.account_id, self);
      }

      const facts: ThreadFacts[] = [];
      for (const row of rows) {
        const f = await threadFactsOf(db, row.id);
        if (f) facts.push({ ...f, id: row.id, participants: (row.participants as EmailAddress[] | null) ?? [] });
      }
      if (facts.length < 2) continue;
      facts.sort((a, b) => a.firstMessageAt!.getTime() - b.firstMessageAt!.getTime());

      // The survivor is the oldest thread; every later sibling is judged against the RUNNING
      // union of what has (or would have) merged so far, because after B joins A, C's overlap
      // with the conversation includes what B brought.
      const target = facts[0]!;
      const running: ThreadFacts = { ...target, correspondents: new Set(target.correspondents) };
      const absorb: ThreadFacts[] = [];
      for (const candidate of facts.slice(1)) {
        const verdict = conversationJoinVerdict(running, candidate, self);
        // `verdict` is "join" or the refusing guard's name; the counterparty overlap (mail
        // addresses) deliberately stays out of the log — the ids point at the evidence.
        log.info(apply ? "thread_join_heal_verdict" : "thread_join_heal_verdict_dry", {
          accountId: group.account_id, threadId: target.id, candidateThreadId: candidate.id,
          verdict: verdict.join ? "join" : verdict.reason,
        });
        if (!verdict.join) continue;
        absorb.push(candidate);
        for (const addr of candidate.correspondents) (running.correspondents as Set<string>).add(addr);
        if (candidate.lastMessageAt && (!running.lastMessageAt
          || candidate.lastMessageAt.getTime() > running.lastMessageAt.getTime())) {
          running.lastMessageAt = candidate.lastMessageAt;
        }
      }
      if (absorb.length === 0) continue;

      if (!apply) {
        result.merged += absorb.length;
        continue;
      }

      try {
        const moved = await db.transaction(async (tx) => {
          const movedIds: string[] = [];
          for (const source of absorb) {
            const m = await tx.update(messages)
              .set({ threadId: target.id, updatedAt: now() })
              .where(and(eq(messages.threadId, source.id), eq(messages.accountId, group.account_id)))
              .returning({ id: messages.id });
            for (const r of m) movedIds.push(r.id);
          }

          // Fold the absorbed threads' participants into the survivor, the same union-by-
          // lowercased-address `mergeThreadMessage` performs at ingest.
          const byAddress = new Map(target.participants.map((p) => [p.address.toLowerCase(), p]));
          for (const source of absorb) {
            for (const p of source.participants) {
              const key = p.address.toLowerCase();
              if (key && !byAddress.has(key)) byAddress.set(key, p);
            }
          }
          await tx.update(threads).set({
            participants: [...byAddress.values()],
            lastMessageAt: running.lastMessageAt,
            updatedAt: now(),
          }).where(and(eq(threads.id, target.id), eq(threads.accountId, group.account_id)));

          for (const source of absorb) {
            await tx.delete(threads)
              .where(and(eq(threads.id, source.id), eq(threads.accountId, group.account_id)));
          }

          // All data locks are held; only now the account's seq lock — the documented order.
          await recordChanges(tx as LedgerTx, [
            ...movedIds.map((id) => ({
              accountId: group.account_id, entityType: "message" as const, entityId: id, op: "update" as const, meta: null,
            })),
            { accountId: group.account_id, entityType: "thread" as const, entityId: target.id, op: "update" as const, meta: null },
            ...absorb.map((source) => ({
              accountId: group.account_id, entityType: "thread" as const, entityId: source.id, op: "delete" as const, meta: null,
            })),
          ]);
          return movedIds.length;
        });
        result.merged += absorb.length;
        result.messagesMoved += moved;
        log.info("thread_join_heal_merged", {
          accountId: group.account_id, threadId: target.id, merged: absorb.length,
          // The absorbed ids are on this run's "join" verdict lines.
          moved,
        });
      } catch (err) {
        result.skipped += 1;
        log.error("thread_join_heal_group_failed", {
          accountId: group.account_id, threadId: target.id, err,
          reason: "nothing of this group committed; the candidate set is re-read from reality " +
            "next run, so a user merge or delete racing this pass simply wins",
        });
      }

      if (result.groupsScanned >= maxGroups) break;
    }
  }

  // Only meaningful when the budget, not the candidate set, ended the walk.
  result.capped = result.groupsScanned >= maxGroups;
  log.info(apply ? "thread_join_heal_complete" : "thread_join_heal_dry_complete", {
    ...(deps.accountId ? { accountId: deps.accountId } : {}),
    scanned: result.groupsScanned, merged: result.merged, moved: result.messagesMoved,
    skipped: result.skipped, capped: result.capped,
  });
  return result;
}

/** One thread's join facts, derived from its messages. `null` ⇒ no dated messages: ineligible. */
async function threadFactsOf(db: Tx, threadId: string): Promise<ConversationJoinFacts | null> {
  const page = await db.select({
    subject: messages.subject, date: messages.date,
    from: messages.fromAddress, to: messages.toAddresses, cc: messages.ccAddresses,
  }).from(messages)
    .where(eq(messages.threadId, threadId))
    // NULLS LAST so an undated straggler can never masquerade as the thread's first message.
    .orderBy(sql`${messages.date} asc nulls last`, asc(messages.createdAt))
    .limit(THREAD_JOIN_HEAL_MAX_MESSAGES_PER_THREAD);
  if (page.length === 0 || page[0]!.date === null) return null;

  const correspondents = new Set<string>();
  let lastMessageAt = page[0]!.date;
  for (const m of page) {
    if (m.from) correspondents.add(m.from.toLowerCase());
    for (const list of [m.to, m.cc]) {
      for (const p of (list as EmailAddress[] | null) ?? []) {
        if (p.address) correspondents.add(p.address.toLowerCase());
      }
    }
    if (m.date && m.date.getTime() > lastMessageAt!.getTime()) lastMessageAt = m.date;
  }

  return {
    firstMessageAt: page[0]!.date,
    lastMessageAt,
    firstMessageSubject: page[0]!.subject,
    correspondents,
  };
}
