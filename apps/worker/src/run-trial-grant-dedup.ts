/**
 * ONE-OFF RUNNER for the trial-grant dedup (`trial-grant-dedup.ts`) — the pre-deploy half of the
 * cloud migration that makes the trial bounty unique per account at the table level.
 *
 * DB-ONLY and dry-run by default. The dry run reports every account holding more than one
 * un-voided `trial_grant` ledger row (account ids and row counts — no mailbox content); the
 * apply run keeps each account's EARLIEST grant and voids the extras in place
 * (`meta.voided_at` + an audit row, no money moved, reversible in principle). The migration's
 * partial unique index cannot build while such duplicates exist, so the sequence is:
 * dry run → (apply, only if it found any) → deploy the migration.
 *
 * Needs the table OWNER's url (the migration credential): voiding lifts the ledger's
 * append-only trigger for exactly one transaction per account, which the runtime role
 * deliberately cannot do.
 *
 *   TF_DB_URL=… tsx apps/worker/src/run-trial-grant-dedup.ts            # dry run: report only
 *   TF_DB_URL=… tsx apps/worker/src/run-trial-grant-dedup.ts --apply    # void the extras
 */
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { type Tx } from "@trafficflow/db";
import { createLogger } from "@trafficflow/core";
import { runTrialGrantDedup } from "./trial-grant-dedup.js";

const apply = process.argv.slice(2).includes("--apply");
const dbUrl = process.env.TF_DB_URL ?? process.env.DATABASE_URL;
if (!dbUrl) { console.error("set TF_DB_URL to the production OWNER url"); process.exit(2); }

const owned = makeOwnedDb(dbUrl);
const log = createLogger({ service: "trial-grant-dedup" });
const r = await runTrialGrantDedup({ db: owned.db as unknown as Tx, apply, log });

if (r.duplicateAccounts === 0) {
  console.log("No account holds more than one trial grant — the 0013 index can build as-is.");
} else {
  for (const a of r.accounts) {
    console.log(`account ${a.accountId}: ${a.count} trial grants — keep ${a.keptLedgerId}, ` +
      `void ${a.voidLedgerIds.join(", ")}`);
  }
  console.log(`${r.duplicateAccounts} account(s) with duplicate trial grants; ` +
    `${apply ? `voided ${r.voided} row(s)` : "DRY RUN — nothing written"}` +
    `${r.failed > 0 ? ` — ${r.failed} account(s) FAILED and were skipped; see the log lines above` : ""}`);
  if (!apply) console.log("Re-run with --apply to void (keeps each account's earliest grant).");
}
await owned.close();
if (r.failed > 0) process.exitCode = 1;
