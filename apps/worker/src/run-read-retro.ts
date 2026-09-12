/**
 * ONE-OFF RUNNER for the read-state retro (`read-retro.ts`), scoped to ONE mailbox.
 *
 * DB-ONLY and dry-run by default. It writes `flag_state.desired_seen = true` (+ the `unread`
 * mirror and a delta) for the unread backlog in `ohmail/Screened` and `ohmail/Quarantine`, and the
 * ALWAYS-ON worker's `reconcileFlags` adds `\Seen` on the real server. It never opens IMAP itself,
 * so it needs no credentials. Additive and reversible — an undo runner exists in the operator tooling.
 *
 *   TF_DB_URL=… tsx apps/worker/src/run-read-retro.ts --mailbox <id>            # dry run: counts
 *   TF_DB_URL=… tsx apps/worker/src/run-read-retro.ts --mailbox <id> --apply    # write
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { folderState, mailboxes, messages, type Tx } from "@trafficflow/db";
import { readStateRetroPass, READ_RETRO_FOLDERS } from "./read-retro.js";

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(`--${n}`);
const opt = (n: string): string | null => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : null;
};

const mailboxId = opt("mailbox");
const apply = flag("apply");
const dbUrl = process.env.TF_DB_URL ?? process.env.DATABASE_URL;
if (!mailboxId) { console.error("refusing to run without --mailbox <id>"); process.exit(2); }
if (!dbUrl) { console.error("set TF_DB_URL to the production session URL"); process.exit(2); }

const owned = makeOwnedDb(dbUrl);
const db = owned.db as unknown as Tx;

const [mb] = await db.select({ id: mailboxes.id, accountId: mailboxes.accountId, address: mailboxes.address })
  .from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
if (!mb) { console.error(`no mailbox ${mailboxId}`); await owned.close(); process.exit(2); }

const [{ n: candidates }] = await db.select({ n: sql<number>`count(*)::int` })
  .from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
  .where(and(
    eq(messages.mailboxId, mailboxId), eq(messages.unread, true),
    inArray(folderState.desiredFolder, [...READ_RETRO_FOLDERS]),
  )) as unknown as [{ n: number }];

console.log(`mailbox ${mb.address} (${mb.id}) account ${mb.accountId}`);
console.log(`unread in ${READ_RETRO_FOLDERS.join(" + ")}: ${candidates}`);

if (!apply) {
  console.log(`\nDRY RUN — nothing written. Re-run with --apply to mark these ${candidates} read.`);
  await owned.close();
  process.exit(0);
}

let marked = 0;
for (;;) {
  const r = await readStateRetroPass(db, { accountId: mb.accountId, mailboxId });
  marked += r.marked;
  if (!r.capped) break;
}
console.log(`\nmarked ${marked} messages desired_seen (pending). The worker's reconcileFlags will \\Seen them.`);
await owned.close();
