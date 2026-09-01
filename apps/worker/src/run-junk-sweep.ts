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
import {
  CLOUD_DISPLAY_NAME, LeaseUnavailableError, OrganizerStandDownError, acquireLeasePermit,
  cloudInstallId, type LeasePermit,
} from "./lease.js";

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

  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  THE ORGANIZER LEASE — TAKEN BEFORE THE FIRST MOVE, RE-VERIFIED BEFORE EVERY CHUNK
  // ══════════════════════════════════════════════════════════════════════════════════════════
  //
  // This runner performed destructive IMAP moves in somebody's real mailbox with NO LEASE AT ALL.
  // Exactly one active organizer per mailbox is the standing invariant, and it is enforced in
  // `ohmail/_meta` — the only medium a LOCAL install and Cloud share — so an operator running this
  // against a mailbox whose owner has since moved it to their own machine was the invariant's one
  // hole: the desktop install holds the claim, this process never looked, and both organizers file
  // the same mail. No infrastructure failure required; it is the ordinary dual-mode configuration.
  // `reconcile-cron.ts` already runs this gate for the same reason at the same seam, and the pass
  // registry ALREADY CLAIMED this runner did too ("the CLI takes the mailbox's own lease") — a
  // false claim, which is worse than a missing one, because it answers the question for a reader.
  //
  // THE PERMIT EXPIRES. A single check at the top would enforce "one organizer at the instant the
  // sweep began"; a pile of thousands moves for minutes, and a takeover inside that window is
  // exactly the case the lease exists for. `guard` is `junkSweepPass`'s per-chunk write boundary
  // and its contract is already an abort — the members not yet moved stay where they are.
  //
  // ONLY WHEN `--execute`. A dry run's promise is that it "writes nothing anywhere", and taking
  // the lease is a WRITE: `runLeaseGate` appends our claim to `ohmail/_meta` and expunges the old
  // one. A dry run that renewed a claim would announce this process as the organizer of a mailbox
  // it was only asked to inspect — and on a mailbox held elsewhere it would (correctly) refuse,
  // making the read-only preview fail for a reason that has nothing to do with the preview.
  let permit: LeasePermit | null = null;
  if (execute) {
    try {
      permit = await acquireLeasePermit({
        adapter,
        self: {
          // The SAME identity the always-on worker and the reconcile backstop claim with. A
          // per-process id here would read as a new organizer arriving and stand the worker down
          // — see `cloudInstallId`'s own docblock for why this constant is the dangerous one.
          installId: process.env.TF_ORGANIZER_INSTALL_ID
            ?? cloudInstallId(process.env.TF_ENVIRONMENT ?? "production"),
          kind: "cloud",
          displayName: CLOUD_DISPLAY_NAME,
          lastNonce: null,
        },
        // NOT `authorized`. A takeover is a human decision recorded on the mailbox row; an
        // operator invoking a sweep has not made it, and reading the flag from the CLI would let
        // this runner seize a mailbox back from the machine its owner moved it to.
        takeover: "none",
        log: (event, detail) => { console.log(`${event} ${JSON.stringify(detail)}`); },
      });
    } catch (err) {
      if (err instanceof OrganizerStandDownError) {
        console.error(
          `refusing to sweep: ${err.message}\n` +
          `  held by: ${err.heldBy ?? "(unnamed)"} — ${err.state === "held" ? "still renewing" : "stopped, but not ours to take"}\n` +
          `  reason:  ${err.reason}\n` +
          `Nothing was moved. Exactly one organizer per mailbox; this process is not it.`,
        );
        process.exitCode = 3;
        throw err;
      }
      if (err instanceof LeaseUnavailableError) {
        // NOT a stand-down, and it must not be reported as one: an unreadable lease is our
        // problem or the connection's, never evidence that somebody else holds the mailbox.
        console.error(`refusing to sweep: the organizer lease could not be read — ${err.message}`);
        process.exitCode = 4;
        throw err;
      }
      throw err;
    }
  }

  const repo = makeDrizzleRepo(db) as unknown as WorkerRepo & {
    transaction: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T>;
  };
  const res = await junkSweepPass({
    db, repo, adapter, accountId: mb.accountId, mailboxId: mb.id, execute, ...(limit !== undefined ? { limit } : {}),
    // The lease at the write boundary. The worker cycle wires its fresh LEADER read here
    // (`fenceImapMutation`, worker-to-worker); this runner has no leader to lose and wires the
    // ORGANIZER lease (install-to-install) — the two fences answer different questions and the
    // cycle, which passes the leader one, is covered for the organizer one by the gate its
    // attach/cycle already ran. Both abort the pass rather than skipping a member.
    ...(permit ? { guard: () => permit!.check() } : {}),
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
