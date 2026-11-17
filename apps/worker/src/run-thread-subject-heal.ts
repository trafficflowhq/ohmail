/**
 * ONE-OFF RUNNER for the thread-name heal (`thread-subject-heal.ts`). DB-ONLY, dry-run by default: it
 * renames threads whose stored name still carries a reply/forward prefix the localized clients emit
 * ("WG: …", "Antw.: …") — names written at create before `baseSubject` knew the full prefix table — and
 * appends a `thread` update per healed row so mirrors pick the new name up on their next sync. It never
 * opens IMAP. Idempotent: a second run selects nothing. Run: `tsx apps/worker/src/run-thread-subject-heal.ts [--apply]`.
 */
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { type Tx } from "@trafficflow/db";
import { createLogger } from "@trafficflow/core";
import { runThreadSubjectHeal } from "./thread-subject-heal.js";
import { runnerAccounts } from "./run-cli.js";
import { bindWorker } from "./start/bind.js";

const apply = process.argv.slice(2).includes("--apply");
const dbUrl = process.env.TF_DB_URL ?? process.env.DATABASE_URL;
if (!dbUrl) { console.error("set TF_DB_URL to the production session URL"); process.exit(2); }

const owned = makeOwnedDb(dbUrl);
// The pool's two views (`run-cli.ts`): the accounts on the one that names none, each account's heal on its own.
const binding = bindWorker(owned.db);
const log = createLogger({ service: "thread-subject-heal" });
const r = { scanned: 0, healed: 0, skipped: 0 };
for (const accountId of await runnerAccounts(binding.roster)) {
  const one = await runThreadSubjectHeal({ db: binding.forAccount(accountId).db as unknown as Tx, accountId, apply, log });
  r.scanned += one.scanned; r.healed += one.healed; r.skipped += one.skipped;
}

console.log(`${apply ? "healed" : "DRY RUN — would heal"} ${r.healed} thread names ` +
  `(${r.scanned} candidates scanned, ${r.skipped} skipped under concurrent writes)`);
if (!apply) console.log("Re-run with --apply to write.");
await owned.close();
