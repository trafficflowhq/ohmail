/**
 * ONE-OFF RUNNER for the Quarantine→\Junk sweep (`junk-sweep.ts`), scoped to ONE mailbox.
 *
 * DRY-RUN BY DEFAULT: it lists what would move and where (resolving the mailbox's native \Junk
 * read-only), and writes nothing anywhere. `--execute` performs the moves — each one a standing
 * spam verdict of the account's own user, executed against the destination a verdict chooses
 * today — with the same completion the live reconciler runs (locator parked, folder_state
 * satisfied, body husked `junk_filed`). It never runs on a schedule, never touches a mailbox it
 * was not named, and refuses a mailbox with no native \Junk rather than inventing one.
 *
 *   TF_DB_URL=… <key ring> tsx apps/worker/src/run-junk-sweep.ts --mailbox <id>
 *   TF_DB_URL=… <key ring> tsx apps/worker/src/run-junk-sweep.ts --mailbox <id> --execute --limit 5
 *
 * `<key ring>` is the KEK environment `keyProviderFromEnvOptional` reads (packages/core) —
 * the same ring every credential-decrypting process holds.
 */
import { eq } from "drizzle-orm";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { mailboxes, type Tx } from "@trafficflow/db";
import { keyProviderFromEnvOptional } from "@trafficflow/core";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { makeDrizzleRepo, type WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { loadMailboxCreds } from "./mailboxes.js";
import { junkSweepPass } from "./junk-sweep.js";

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(`--${n}`);
const opt = (n: string): string | null => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : null;
};

const mailboxId = opt("mailbox");
const execute = flag("execute");
const limit = opt("limit") ? Number(opt("limit")) : undefined;
const dbUrl = process.env.TF_DB_URL ?? process.env.DATABASE_URL;
if (!mailboxId) { console.error("refusing to run without --mailbox <id>"); process.exit(2); }
if (!dbUrl) { console.error("set TF_DB_URL to the production session URL"); process.exit(2); }

const keyProvider = keyProviderFromEnvOptional(process.env);
if (!keyProvider) { console.error("no KEK ring in the environment — the sweep must decrypt IMAP credentials (see keyProviderFromEnvOptional)"); process.exit(2); }

const owned = makeOwnedDb(dbUrl);
const db = owned.db as unknown as Tx;

const [mb] = await db.select({ id: mailboxes.id, accountId: mailboxes.accountId, address: mailboxes.address })
  .from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
if (!mb) { console.error(`no mailbox ${mailboxId}`); await owned.close(); process.exit(2); }

const creds = await loadMailboxCreds(owned.db, mailboxId, keyProvider);
if (!creds) { console.error("no imap credentials for this mailbox"); await owned.close(); process.exit(2); }

const adapter = new ImapAdapter({
  host: creds.imap.host, port: creds.imap.port, secure: creds.imap.secure,
  ...(creds.imap.allowInsecure ? { allowInsecure: true } : {}),
  auth: creds.imap.auth,
});

try {
  await adapter.connect();
  const repo = makeDrizzleRepo(db) as unknown as WorkerRepo & {
    transaction: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T>;
  };
  const res = await junkSweepPass({
    db, repo, adapter, accountId: mb.accountId, mailboxId: mb.id, execute, ...(limit !== undefined ? { limit } : {}),
  });

  console.log(`mailbox ${mb.address} (${mb.id})`);
  console.log(`native \\Junk: ${res.junkFolder ?? "NONE — nothing can move"}`);
  console.log(`physically in ohmail/Quarantine: ${res.candidates.length}`);
  for (const c of res.candidates.slice(0, 20)) {
    console.log(`  ${c.messageId}  ${c.ref.padEnd(12)}  ${c.subject.slice(0, 60)}`);
  }
  if (res.candidates.length > 20) console.log(`  … and ${res.candidates.length - 20} more`);

  if (res.dryRun) {
    console.log(`\nDRY RUN — nothing written, nothing moved. Re-run with --execute to sweep.`);
  } else {
    console.log(`\nmoved ${res.moved.length}; skipped ${res.skipped.length}.`);
    for (const s of res.skipped) console.log(`  skipped ${s.messageId}: ${s.reason}`);
  }
} finally {
  try { await adapter.close(); } catch { /* ignore */ }
  await owned.close();
}
