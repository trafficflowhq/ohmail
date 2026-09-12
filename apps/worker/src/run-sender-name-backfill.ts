/**
 * ONE-OFF RUNNER for the sender-name / recipients backfill (`sender-name-backfill.ts`).
 *
 * DB-ONLY and dry-run by default. It re-reads the stored `message_bodies.headers` of historical
 * messages and fills `messages.from_name` (mail 0057), `to_addresses` and `cc_addresses` where
 * the column is still unset — the pass 0057's own file defers to — and appends a `message`
 * update to the change log per written row, so client mirrors pick the names up on their next
 * ordinary sync. It never opens IMAP and needs no credentials.
 *
 *   TF_DB_URL=… tsx apps/worker/src/run-sender-name-backfill.ts             # census, writes nothing
 *   TF_DB_URL=… tsx apps/worker/src/run-sender-name-backfill.ts --apply     # write
 *   TF_DB_URL=… tsx apps/worker/src/run-sender-name-backfill.ts --max=500   # bound the walk
 *
 * Idempotent and resumable: only unset columns are ever written, the UPDATE repeats the unset
 * predicate so a concurrent writer wins, and each page is its own transaction — a killed run
 * resumes by being run again.
 *
 * ── READING THE CENSUS ─────────────────────────────────────────────────────────────────────
 *
 * `scanned` does NOT fall to zero after a successful apply, and that is not a failure. A message
 * whose sender set no display name keeps a NULL `from_name` and a `from` header for ever, so it
 * stays a candidate. `fillable` — the rows the parse can still supply a value for — is the
 * number that goes to zero, and it is what a re-run is for.
 */
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { type Tx } from "@trafficflow/db";
import { createLogger } from "@trafficflow/core";
import { runSenderNameBackfill } from "./sender-name-backfill.js";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const maxArg = argv.find((a) => a.startsWith("--max="));
const maxRows = maxArg ? Number(maxArg.slice("--max=".length)) : undefined;
if (maxRows !== undefined && (!Number.isInteger(maxRows) || maxRows < 1)) {
  console.error("--max must be a positive integer");
  process.exit(2);
}

const dbUrl = process.env.TF_DB_URL ?? process.env.DATABASE_URL;
if (!dbUrl) { console.error("set TF_DB_URL to the production session URL"); process.exit(2); }

const owned = makeOwnedDb(dbUrl);
const log = createLogger({ service: "sender-name-backfill" });
const started = Date.now();
const r = await runSenderNameBackfill({ db: owned.db as unknown as Tx, apply, log, maxRows });
const secs = ((Date.now() - started) / 1000).toFixed(1);

console.log(
  `${apply ? "backfilled" : "DRY RUN — would backfill"} ${apply ? r.written : r.fillable} messages ` +
  `in ${secs}s\n` +
  `  candidates scanned      ${r.scanned}\n` +
  `  fillable                ${r.fillable}   (from_name ${r.fromName}, to ${r.toAddresses}, cc ${r.ccAddresses})\n` +
  `  rows written            ${r.written}\n` +
  `  no display name in From ${r.noDisplayName}   (correctly left NULL — an address is not a name)\n` +
  `  parse failures          ${r.parseFailures}\n` +
  `  lost to a concurrent writer ${r.skipped}`,
);
if (!apply) console.log("Re-run with --apply to write.");
await owned.close();
