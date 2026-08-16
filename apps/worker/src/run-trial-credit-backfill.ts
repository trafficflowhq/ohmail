/**
 * ONE-OFF RUNNER for the trial-bounty backfill (`trial-credit-backfill.ts`).
 *
 * DB-ONLY and dry-run by default. It grants the trial's fixed AI allowance to every account whose
 * live subscription row says `trialing` and that has no trial grant recorded yet — the accounts
 * that were already mid-trial when the policy changed from "a trial grants nothing" to "a trial
 * gets a bounty". It never opens IMAP and needs no credentials.
 *
 * Idempotent, and structurally so: every grant is written under `trial:<account_id>` and
 * `credit_ledger` is unique on `(account_id, source)`, so a second run — or a race with the live
 * subscription-event path — grants nothing more.
 *
 *   TF_DB_URL=… tsx apps/worker/src/run-trial-credit-backfill.ts            # dry run: counts
 *   TF_DB_URL=… tsx apps/worker/src/run-trial-credit-backfill.ts --apply    # write
 */
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { type Tx } from "@trafficflow/db";
import { createLogger } from "@trafficflow/core";
import { runTrialCreditBackfill } from "./trial-credit-backfill.js";

const apply = process.argv.slice(2).includes("--apply");
const dbUrl = process.env.TF_DB_URL ?? process.env.DATABASE_URL;
if (!dbUrl) { console.error("set TF_DB_URL to the production session URL"); process.exit(2); }

const owned = makeOwnedDb(dbUrl);
const log = createLogger({ service: "trial-credit-backfill" });
const r = await runTrialCreditBackfill({ db: owned.db as unknown as Tx, apply, log });

console.log(`${r.trialing} account(s) on a trial; ` +
  `${apply ? `granted ${r.granted}` : `DRY RUN — would grant ${r.eligible}`}` +
  `${r.raced > 0 ? ` (${r.raced} already granted by the live path mid-run)` : ""}` +
  `${r.failed > 0 ? ` — ${r.failed} account(s) FAILED and were skipped; see the log lines above` : ""}`);
if (!apply) console.log("Re-run with --apply to write.");
await owned.close();
// A pass that skipped accounts finished, and saying so with a zero exit is how an operator's
// wrapper decides nothing needs doing. The failures are named in the log and a rerun is safe.
if (r.failed > 0) process.exitCode = 1;
