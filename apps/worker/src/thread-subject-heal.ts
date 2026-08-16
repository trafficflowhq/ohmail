import { and, asc, eq, sql } from "drizzle-orm";
import { recordChanges, threads, type LedgerTx, type Tx } from "@trafficflow/db";
import { baseSubject, SUBJECT_PREFIX_PATTERN, silentLogger, type Logger } from "@trafficflow/core";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE THREAD-NAME HEAL — one-shot, DB-only
   ══════════════════════════════════════════════════════════════════════════════════════════

   ── WHAT IT REPAIRS, AND WHY IT IS NOT THE THREAD BACKFILL ─────────────────────────────────

   `thread-backfill.ts` heals thread IDENTITY (`messages.thread_id IS NULL`), and its backlog
   is drained: identity comes from the header chain, which was always stored. This pass heals
   thread NAMES. A thread's subject is written ONCE, at create, through `baseSubject` — and
   until the localized prefix table existed, a thread created by a localized FORWARD kept the
   prefix ("WG: …" while the same conversation's "AW:" replies were stripped). Those rows are
   already written; fixing `baseSubject` renames nothing retroactively, because a thread's
   subject is deliberately never overwritten at ingest (`POST /threads/:id/rename` is a user
   write). So the heal is a separate, explicit, one-shot decision — not something ingest may do.

   ── THE RENAME INVARIANT, AND WHY THIS PASS DOES NOT VIOLATE IT IN PRACTICE ────────────────

   The transform is exactly `subject → baseSubject(subject)`, applied only where it changes
   something. A user rename is clobbered only if the user deliberately renamed a conversation
   TO a reply/forward-prefixed string — which is byte-indistinguishable from the stored defect
   this pass exists to repair, and the outcome is the same string the product would have named
   it at create. The update is guarded (`WHERE subject = <the value read>`), so a rename that
   lands mid-pass wins over the heal, not the other way round.

   ── MIRRORS LEARN THROUGH THE CHANGE LOG, WHICH IS WHY THIS IS NOT AN UPDATE STATEMENT ─────

   Every healed row appends a `thread` update to `change_log` in the same transaction, or the
   fix would be invisible on every client until a re-bootstrap. Lock order matches ingest and
   the thread backfill: ALL `threads` row locks first, `allocateSeq`'s account row lock last
   (see `ThreadResolution.changes` in packages/core for why that order is load-bearing).

   ── KEYSET PAGINATION, NOT PREDICATE EXTINCTION ────────────────────────────────────────────

   The backfill can loop "select WHERE thread_id IS NULL until empty" because every row it
   touches leaves the predicate. A DRY RUN of this pass changes nothing, so a predicate loop
   would re-read the first page for ever; the cursor (`id > last`) makes dry and apply walk
   the same pages exactly once.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/** Rows examined per page — one transaction per page in apply mode, same figure as the backfill. */
export const SUBJECT_HEAL_BATCH = 100;

export interface SubjectHealDeps {
  db: Tx;
  /** False ⇒ dry run: count and report, write nothing. */
  apply: boolean;
  log?: Logger;
  batch?: number;
}

export interface SubjectHealResult {
  /** Rows the SQL pre-filter surfaced (their names LOOK prefixed). */
  scanned: number;
  /** Rows whose name actually reduced under `baseSubject` (dry run: would reduce). */
  healed: number;
  /** Rows that changed under a concurrent writer between read and update, and were left alone. */
  skipped: number;
}

/**
 * Rename every thread whose stored name still reduces under `baseSubject`, emitting a
 * `thread` update per healed row. Idempotent: a healed name no longer matches the pre-filter,
 * and a second run over an already-healed table selects nothing and takes no locks.
 */
export async function runThreadSubjectHeal(deps: SubjectHealDeps): Promise<SubjectHealResult> {
  const { db, apply } = deps;
  const log = deps.log ?? silentLogger;
  const batch = deps.batch ?? SUBJECT_HEAL_BATCH;

  let scanned = 0;
  let healed = 0;
  let skipped = 0;
  let cursor: string | null = null;

  for (;;) {
    const page = await db
      .select({ id: threads.id, accountId: threads.accountId, subject: threads.subject })
      .from(threads)
      .where(and(
        // The SAME anatomy the JS regex is built from — see SUBJECT_PREFIX_PATTERN. `~*` for
        // the case-insensitivity the JS side gets from the `i` flag.
        sql`${threads.subject} ~* ${SUBJECT_PREFIX_PATTERN}`,
        cursor === null ? undefined : sql`${threads.id} > ${cursor}::uuid`,
      ))
      .orderBy(asc(threads.id))
      .limit(batch);
    if (page.length === 0) break;
    cursor = page[page.length - 1]!.id;
    scanned += page.length;

    // `baseSubject` is the authority; the SQL filter is only a pre-filter. A row the SQL
    // matched but JS would not change (leading whitespace oddities) is counted scanned, not
    // healed — and the cursor, not the predicate, is what guarantees it is never re-read.
    const reducible = page
      .map((r) => ({ ...r, next: baseSubject(r.subject) }))
      .filter((r) => r.next !== r.subject);

    if (!apply) {
      healed += reducible.length;
      for (const r of reducible) log.info("thread_subject_heal_dry", { threadId: r.id, from: r.subject, to: r.next });
      continue;
    }

    const result = await db.transaction(async (tx) => {
      const done: typeof reducible = [];
      for (const r of reducible) {
        const updated = await tx.update(threads)
          .set({ subject: r.next, updatedAt: new Date() })
          // Guarded on the value READ: if a user rename (or another pass) landed in between,
          // zero rows match and their write stands.
          .where(and(eq(threads.id, r.id), eq(threads.subject, r.subject)))
          .returning({ id: threads.id });
        if (updated.length > 0) done.push(r);
      }
      // All `threads` locks are held; only now the seq locks — one allocation per account.
      const byAccount = new Map<string, typeof done>();
      for (const r of done) {
        const list = byAccount.get(r.accountId) ?? [];
        list.push(r);
        byAccount.set(r.accountId, list);
      }
      for (const [accountId, rows] of byAccount) {
        await recordChanges(tx as LedgerTx, rows.map((r) => ({
          accountId, entityType: "thread" as const, entityId: r.id, op: "update" as const, meta: null,
        })));
      }
      return { done: done.length, missed: reducible.length - done.length };
    });

    healed += result.done;
    skipped += result.missed;
  }

  log.info(apply ? "thread_subject_heal_complete" : "thread_subject_heal_dry_complete", {
    scanned, healed, skipped,
  });
  return { scanned, healed, skipped };
}
