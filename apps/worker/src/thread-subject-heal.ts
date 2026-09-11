import { and, asc, eq, sql } from "drizzle-orm";
import { recordChanges, threads, type LedgerTx, type Tx } from "@trafficflow/db";
import { baseSubject, SUBJECT_PREFIX_PATTERN, silentLogger, type Logger } from "@trafficflow/core";

/* THE THREAD-NAME HEAL — one-shot, DB-only. `thread-backfill.ts` heals thread IDENTITY
 * (`messages.thread_id IS NULL`); this heals thread NAMES. A thread's subject is written ONCE at create
 * through `baseSubject`, and until the localized prefix table existed a localized FORWARD kept its prefix
 * ("WG: …" while the same conversation's "AW:" replies were stripped). Fixing `baseSubject` renames nothing
 * retroactively (a subject is never overwritten at ingest — `POST /threads/:id/rename` is a user write), so
 * the heal is a separate, explicit, one-shot decision. The transform is exactly `subject →
 * baseSubject(subject)` where it changes something, guarded `WHERE subject = <the value read>` so a user
 * rename mid-pass wins. Every healed row appends a `thread` update to `change_log` in the same transaction
 * (else invisible until re-bootstrap); lock order is `threads` first, `allocateSeq` last
 * (`ThreadResolution.changes`). KEYSET-paged (`id > last`), not predicate extinction (a dry run changes nothing). */

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
