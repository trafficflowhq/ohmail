/**
 * ONE-OFF RUNNER for the Quarantine→\Junk sweep (`junk-sweep.ts`), scoped to ONE mailbox. DRY-RUN BY
 * DEFAULT: it lists what would move and where (resolving the native \Junk read-only) and writes nothing.
 * `--execute` performs the moves — each a standing spam verdict of the account's own user, against the
 * destination a verdict chooses today — with the live reconciler's completion (locator parked, folder_state
 * satisfied, body husked `junk_filed`). Never scheduled, never touches an unnamed mailbox, refuses one with
 * no native \Junk. Invoked `TF_DB_URL=… <key ring> tsx apps/worker/src/run-junk-sweep.ts --mailbox <id>
 * [--execute --limit 5]`; `<key ring>` is the KEK environment `keyProviderFromEnvOptional` reads (packages/core).
 */
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { type Tx } from "@trafficflow/db";
import { keyProviderFromEnvOptional } from "@trafficflow/core";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { makeDrizzleRepo, type WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { loadMailboxCreds } from "./mailboxes.js";
import { checkedDial, dialHostGuardFromEnv } from "./dial-host-guard.js";
import { junkSweepPass } from "./junk-sweep.js";
import { cliArgs, readRunnerMailbox, takeRunnerLease } from "./run-cli.js";
import { type LeasePermit } from "./lease.js";

const { flag, opt } = cliArgs(process.argv.slice(2));

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

/* The one-off runner's scaffold: the mailbox, and the refusal a pending release earns. */
const found = await readRunnerMailbox(db, mailboxId);
if (found === null) { console.error(`no mailbox ${mailboxId}`); await owned.close(); process.exit(2); }
if ("refusal" in found) { console.error(found.refusal); await owned.close(); process.exit(2); }
const mb = found.mailbox;

const creds = await loadMailboxCreds(owned.db, mailboxId, keyProvider);
if (!creds) { console.error("no imap credentials for this mailbox"); await owned.close(); process.exit(2); }

/* This command dials the operator's own deployment, so it asks the deployment's own policy —
   the same variable the organizer and the API read. A tool that dialled a host the always-on
   organizer refuses would be a third answer about one network. */
const adapter = new ImapAdapter({
  host: creds.imap.host, port: creds.imap.port, secure: creds.imap.secure,
  ...(await checkedDial(dialHostGuardFromEnv(process.env), creds.imap.host, "imap")),
  ...(creds.imap.allowInsecure ? { allowInsecure: true } : {}),
  auth: creds.imap.auth,
});

try {
  await adapter.connect();

  // THE ORGANIZER LEASE — TAKEN BEFORE THE FIRST MOVE, RE-VERIFIED BEFORE EVERY CHUNK. This runner
  // performed destructive IMAP moves in a real mailbox with NO LEASE AT ALL. Exactly one active organizer
  // per mailbox is enforced in `ohmail/_meta` (the only medium a LOCAL install and Cloud share), so running
  // this against a mailbox its owner moved to their own machine had both organizers file the same mail — the
  // ordinary dual-mode config. `reconcile-cron.ts` runs this gate at the same seam, and the pass registry
  // ALREADY CLAIMED this runner did (a false claim, worse than a missing one). The permit EXPIRES: a single
  // top check enforces one organizer at the START, but a pile moves for minutes and a takeover inside is the
  // case the lease exists for — `guard` is `junkSweepPass`'s per-chunk write boundary and aborts. ONLY on
  // `--execute`: taking the lease is a WRITE (`runLeaseGate` appends our claim to `ohmail/_meta` and
  // expunges the old), so a dry run must not, and on a mailbox held elsewhere it would (correctly) refuse.
  let permit: LeasePermit | null = null;
  if (execute) {
    permit = await takeRunnerLease({
      adapter, mailboxId, mailbox: mb, auth: creds.imap.auth, env: process.env,
      voice: {
        verb: "sweep",
        nothingDone: "Nothing was moved. Exactly one organizer per mailbox; this process is not it.",
      },
      log: (line) => { console.log(line); },
    });
  }

  const repo = makeDrizzleRepo(db) as unknown as WorkerRepo & {
    transaction: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T>;
  };
  const res = await junkSweepPass({
    db, repo, adapter, accountId: mb.accountId, mailboxId: mb.id, execute, ...(limit !== undefined ? { limit } : {}),
    // This runner has no shard leadership to lose, so it holds the LEASE half only. A dry run
    // holds neither: it must not even read the lease, because a read renews our claim.
    writeAuthority: { lease: permit ?? { noLease: "not_supplied" } },
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
