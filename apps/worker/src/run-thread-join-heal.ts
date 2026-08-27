/**
 * ONE-OFF RUNNER for the thread-join heal (`thread-join-heal.ts`).
 *
 * DB-ONLY and dry-run by default. It merges threads that are provably one conversation under
 * `conversationJoinVerdict` — the split a forward's fresh header chain leaves behind — moving
 * the later thread's messages onto the older one and appending the message updates, the
 * surviving thread's update and the absorbed thread's delete to the change log, so client
 * mirrors re-render the united conversation on their next sync. It never opens IMAP and needs
 * no credentials. Idempotent: a merged group holds one thread and is never selected again.
 *
 *   TF_DB_URL=… tsx apps/worker/src/run-thread-join-heal.ts            # dry run: verdicts + counts
 *   TF_DB_URL=… tsx apps/worker/src/run-thread-join-heal.ts --apply    # write
 */
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { type Tx } from "@trafficflow/db";
import { createLogger } from "@trafficflow/core";
import { threadJoinHealPass } from "./thread-join-heal.js";

const apply = process.argv.slice(2).includes("--apply");
const dbUrl = process.env.TF_DB_URL ?? process.env.DATABASE_URL;
if (!dbUrl) { console.error("set TF_DB_URL to the production session URL"); process.exit(2); }

const owned = makeOwnedDb(dbUrl);
const log = createLogger({ service: "thread-join-heal" });

// The pass caps one invocation; loop, RESUMING FROM ITS CURSOR, until the candidate set —
// not the budget — is what ends the walk. Without the cursor a group whose verdict is "no"
// would be rescanned by every iteration, and this loop would never terminate.
let merged = 0, moved = 0, groups = 0, skipped = 0, failed = 0;
let cursor: import("./thread-join-heal.js").ThreadJoinHealCursor | undefined;
for (;;) {
  const r = await threadJoinHealPass({ db: owned.db as unknown as Tx, apply, log, cursor });
  merged += r.merged; moved += r.messagesMoved; groups += r.groupsScanned;
  skipped += r.skipped; failed += r.failed;
  if (!r.capped || !r.cursor) break;
  cursor = r.cursor;
}

console.log(`${apply ? "merged" : "DRY RUN — would merge"} ${merged} split threads ` +
  `(${moved} messages moved, ${groups} duplicate-name groups examined, ${skipped} skipped, ` +
  `${failed} failed${failed > 0 ? " — re-run to retry them" : ""})`);
if (!apply) console.log("Re-run with --apply to write.");
await owned.close();
