/**
 * ONE-OFF RUNNER for the thread-name heal (`thread-subject-heal.ts`).
 *
 * DB-ONLY and dry-run by default. It renames threads whose stored name still carries a
 * reply/forward prefix the localized clients emit ("WG: …", "Antw.: …") — names written at
 * create before `baseSubject` knew the full prefix table — and appends a `thread` update to
 * the change log per healed row so client mirrors pick the new name up on their next sync.
 * It never opens IMAP and needs no credentials. Idempotent: a second run selects nothing.
 *
 *   TF_DB_URL=… tsx apps/worker/src/run-thread-subject-heal.ts            # dry run: counts
 *   TF_DB_URL=… tsx apps/worker/src/run-thread-subject-heal.ts --apply    # write
 */
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { type Tx } from "@trafficflow/db";
import { createLogger } from "@trafficflow/core";
import { runThreadSubjectHeal } from "./thread-subject-heal.js";

const apply = process.argv.slice(2).includes("--apply");
const dbUrl = process.env.TF_DB_URL ?? process.env.DATABASE_URL;
if (!dbUrl) { console.error("set TF_DB_URL to the production session URL"); process.exit(2); }

const owned = makeOwnedDb(dbUrl);
const log = createLogger({ service: "thread-subject-heal" });
const r = await runThreadSubjectHeal({ db: owned.db as unknown as Tx, apply, log });

console.log(`${apply ? "healed" : "DRY RUN — would heal"} ${r.healed} thread names ` +
  `(${r.scanned} candidates scanned, ${r.skipped} skipped under concurrent writes)`);
if (!apply) console.log("Re-run with --apply to write.");
await owned.close();
