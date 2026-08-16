import { sql } from "drizzle-orm";
import { auditLog } from "@trafficflow/db";
import type { Tx } from "@trafficflow/db";
import { silentLogger, type Logger } from "@trafficflow/core";

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE TRIAL-GRANT DEDUP — one-shot, DB-only, dry-run by default. The apply half of cloud
   migration 0013's TRIAL-ONCE index.
   ══════════════════════════════════════════════════════════════════════════════════════════

   ── WHY THIS EXISTS AND WHY IT IS NOT A MIGRATION STATEMENT ────────────────────────────────

   0013 builds `credit_ledger_one_trial_grant_idx`: UNIQUE on `(account_id)` over un-voided
   `trial_grant` rows, so a second bounty for an account stops being representable. A unique
   index CANNOT BUILD over existing duplicates — an account already holding two `trial_grant`
   rows fails the whole migration transaction at deploy time, which is the least recoverable
   place to learn about it. So the resolution runs BEFORE the deploy, as a runner in the
   `trial-credit-backfill` shape: it counts first, writes only when asked, prints what it found
   (account ids and counts — never mailbox content), and can be run again.

   ── WHAT "VOID" MEANS, AND WHAT IT DOES NOT ────────────────────────────────────────────────

   Keep the EARLIEST grant; stamp `meta.voided_at` (+ `void_reason`, + the kept row's id) on the
   extras. The row keeps its delta, its balance_after and its place in the chain — NO MONEY
   MOVES, and none may: a duplicate bounty's credits were really granted and possibly really
   spent, so whether to also claw the balance back is a staff adjustment decision
   (`adjustment_debit`, audited, per account), never a side effect of making an index buildable.
   The void is an ANNOTATION with an audit row beside it, reversible in principle: remove the
   key and the row participates in the index predicate again.

   DELETE was rejected outright (a money record that can lose rows is not a money record), and
   so was rewriting `reason`/`source` (the row would stop saying what happened). `meta` is the
   ledger's free-form provenance column; the 0013 index predicate and every trial-grant reader
   in `credits.ts` exclude rows where `meta ->> 'voided_at'` is set, and the 0013
   `credit_ledger_trial_guard` trigger refuses an INSERT that arrives already voided, so this
   annotation cannot be used as a mint by a future writer.

   ── THE APPEND-ONLY TRIGGER, DISABLED FOR EXACTLY ONE TRANSACTION ──────────────────────────

   `credit_ledger` refuses UPDATE at statement level (`credit_ledger_append_only`). That trigger
   exists to stop a wrong admin tool and a stray "cleanup" job — and its own migration comment is
   explicit that it does not bind the table's OWNER, whose deliberate, audited act this is. Each
   account's transaction disables the trigger, voids, writes the audit rows and re-enables it;
   a rollback restores the trigger state with everything else.

   The `ALTER TABLE … DISABLE TRIGGER` takes an ACCESS EXCLUSIVE lock on `credit_ledger` that is
   held to commit. That is not a cost, it is the serialization: every in-flight ledger write
   finishes before the SELECT below reads the account's rows, and no grant can land between the
   read and the void. (It also means: run this in a quiet moment; each account's transaction
   briefly stalls ledger writers. A deadlock against a live webhook mid-transaction is possible
   and harmless — Postgres aborts one side, the account is counted `failed`, and a rerun picks
   it up.) It requires the table owner: run with the production OWNER url, the same credential
   migrations use — the runtime role deliberately cannot do this.

   ── EXPECTED POPULATION: ZERO ──────────────────────────────────────────────────────────────

   Every live writer builds its source through the trial-grant primitive in `credits.ts`
   (`trial:<account_id>`), which `UNIQUE (account_id, source)` already caps at one row per
   account. A duplicate therefore requires a hand-written `trial_grant` row under some other
   `trial:` source — the exact hole 0013 closes. The dry run is how "zero" stops being an
   assumption: run it, read the count, THEN deploy 0013.
   ══════════════════════════════════════════════════════════════════════════════════════════ */

export interface TrialDedupDeps {
  db: Tx;
  /** False ⇒ dry run: count and report, write nothing. */
  apply: boolean;
  log?: Logger;
}

/** One account holding more than one un-voided trial grant. Ids are ledger row ids, in id order. */
export interface DuplicateTrialGrants {
  accountId: string;
  /** Un-voided `trial_grant` rows on the account — always ≥ 2 when reported. */
  count: number;
  /** The row a dedup keeps: the EARLIEST (smallest id). */
  keptLedgerId: string;
  /** The rows a dedup voids. */
  voidLedgerIds: string[];
}

export interface TrialDedupResult {
  /** Accounts holding >1 un-voided trial grant when the pass read the ledger. */
  duplicateAccounts: number;
  /** Ledger rows actually voided. Always 0 on a dry run. */
  voided: number;
  /**
   * Accounts whose own transaction THREW and rolled back — same isolation contract as the
   * trial-credit backfill: one bad account must not take the rest of the population with it.
   */
  failed: number;
  /** The full report, dry run and apply alike. Account ids and row ids only. */
  accounts: DuplicateTrialGrants[];
}

/** The reporting read: every account with more than one un-voided trial grant. */
async function findDuplicates(db: Tx): Promise<DuplicateTrialGrants[]> {
  const result = await db.execute<{ account_id: string; ids: string[] }>(sql`
    select account_id, array_agg(id order by id) as ids
      from credit_ledger
     where reason = 'trial_grant' and (meta ->> 'voided_at') is null
     group by account_id
    having count(*) > 1
     order by account_id`);
  const rows = Array.isArray(result)
    ? result
    : (result as unknown as { rows: Array<{ account_id: string; ids: string[] }> }).rows;
  return (rows as Array<{ account_id: string; ids: unknown[] }>).map((r) => {
    const ids = r.ids.map((id) => String(id));
    return {
      accountId: r.account_id,
      count: ids.length,
      keptLedgerId: ids[0]!,
      voidLedgerIds: ids.slice(1),
    };
  });
}

/**
 * Report — and on `apply`, void — duplicate trial grants, keeping each account's earliest.
 *
 * ONE TRANSACTION PER ACCOUNT, the backfill's isolation contract: an account whose void fails
 * is counted and logged, and every other account is still attempted. Rerunning is safe — a
 * voided row no longer matches the duplicate predicate, so a second pass finds nothing to do.
 *
 * The rows are RE-READ inside each account's transaction, after the ACCESS EXCLUSIVE lock the
 * trigger toggle takes, so the void decision can never act on a stale report: a row voided by a
 * concurrent copy of this pass, or an account that stopped being a duplicate, simply drops out.
 */
export async function runTrialGrantDedup(deps: TrialDedupDeps): Promise<TrialDedupResult> {
  const { db, apply } = deps;
  const log = deps.log ?? silentLogger;

  const report = await findDuplicates(db);
  const result: TrialDedupResult = {
    duplicateAccounts: report.length, voided: 0, failed: 0, accounts: report,
  };
  if (!apply) {
    log.info("trial grant dedup complete", { ...summarize(result), apply });
    return result;
  }

  for (const dup of report) {
    try {
      // Counted from the transaction's RETURN VALUE, not from inside it: an increment made
      // inside the closure would survive a rollback the voids themselves did not.
      const voidedHere = await db.transaction(async (tx) => {
        // Serializes every ledger writer (held to commit) AND lifts append-only for this
        // transaction alone. Owner-only by design.
        await tx.execute(sql`alter table credit_ledger disable trigger credit_ledger_append_only`);

        // Decide from what is true NOW, under the exclusive lock — not from the report.
        const fresh = await tx.execute<{ id: string }>(sql`
          select id from credit_ledger
           where account_id = ${dup.accountId}
             and reason = 'trial_grant' and (meta ->> 'voided_at') is null
           order by id`);
        const rows = Array.isArray(fresh)
          ? fresh
          : (fresh as unknown as { rows: Array<{ id: string }> }).rows;
        const ids = (rows as Array<{ id: unknown }>).map((r) => String(r.id));
        if (ids.length < 2) return 0;   // resolved since the report — nothing to void

        const keptId = ids[0]!;
        let voidedInTx = 0;
        for (const voidId of ids.slice(1)) {
          const stamp = {
            voided_at: new Date().toISOString(),
            void_reason: "duplicate_trial_grant",
            kept_ledger_id: keptId,
          };
          await tx.execute(sql`
            update credit_ledger
               set meta = meta || ${JSON.stringify(stamp)}::jsonb
             where id = ${voidId}::bigint`);
          // The audit row is the void's provenance, in the same transaction — the suspension
          // writers' rule. `inverse` documents the in-principle reversal (remove the keys); a
          // reversal is the same break-glass act this was, never something code performs.
          await tx.insert(auditLog).values({
            accountId: dup.accountId,
            action: "billing.trial_grant.void_duplicate",
            payload: { ledger_id: voidId, ...stamp },   // stamp carries kept_ledger_id
            inverse: {
              action: "billing.trial_grant.unvoid",
              ledger_id: voidId,
              remove_meta_keys: ["voided_at", "void_reason", "kept_ledger_id"],
            },
          });
          voidedInTx++;
          log.info("duplicate trial grant voided", {
            accountId: dup.accountId, ledgerId: voidId, keptLedgerId: keptId,
          });
        }

        await tx.execute(sql`alter table credit_ledger enable trigger credit_ledger_append_only`);
        return voidedInTx;
      });
      result.voided += voidedHere;
    } catch (err) {
      result.failed++;
      log.error("trial grant dedup: account skipped", {
        accountId: dup.accountId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("trial grant dedup complete", { ...summarize(result), apply });
  return result;
}

/** The log line's shape: counts only — the per-account detail is in `accounts`. */
function summarize(r: TrialDedupResult): Record<string, number> {
  return { duplicateAccounts: r.duplicateAccounts, voided: r.voided, failed: r.failed };
}
