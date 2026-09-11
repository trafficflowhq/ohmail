/**
 * ONE-OFF RUNNER for the sender-name / recipients backfill (`sender-name-backfill.ts`). DB-ONLY, dry-run by
 * default: it re-reads stored `message_bodies.headers` and fills `messages.from_name` (mail 0057),
 * `to_addresses` and `cc_addresses` where still unset, appending a `message` update per written row so
 * mirrors pick the names up on their next sync. It never opens IMAP. Idempotent and resumable (only unset
 * columns written, the UPDATE repeats the predicate, each page its own transaction). READING THE CENSUS:
 * `scanned` does NOT fall to zero after an apply (a sender that set no display name keeps a NULL `from_name`
 * for ever), so `fillable` — the rows the parse can still supply a value for — is the number that goes to
 * zero and what a re-run is for. Run: `tsx apps/worker/src/run-sender-name-backfill.ts [--apply] [--max=500]`.
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
