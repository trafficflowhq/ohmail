/**
 * ONE-OFF RUNNER for the [REDACTED] body restore (`redacted-restore.ts`), scoped to ONE mailbox. It
 * re-reads originals with BODY.PEEK (no `\Seen`) and stores the full body, KEEPING sensitivity flags. It
 * opens IMAP, so it needs `TF_KEK_V1` to decrypt the mailbox's stored credentials (the same material the
 * always-on worker holds). Dry-run by default; `--apply` writes, `--limit N` caps the fetches for a bounded
 * proof run. Reversible in the sense that matters: it MUTATES NOTHING ON THE MAIL SERVER (peek-only) and
 * only overwrites a DB body with the server's authoritative copy.
 *
 *   TF_DB_URL=… TF_KEK_V1=… tsx apps/worker/src/run-redacted-restore.ts --mailbox <id> [--apply --limit 5]
 */
import { and, eq, like, sql } from "drizzle-orm";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { mailboxes, messageBodies, messages, type Tx } from "@trafficflow/db";
import { keyProviderFromEnvOptional } from "@trafficflow/core";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { loadMailboxCreds } from "./mailboxes.js";
import { checkedDial, dialHostGuardFromEnv } from "./dial-host-guard.js";
import { redactedRestorePass } from "./redacted-restore.js";
import { cliFlag, cliOpt, readOperatorMailbox } from "./operator-cli.js";
import {
  CLOUD_DISPLAY_NAME, LeaseUnavailableError, OrganizerStandDownError, acquireLeasePermit,
  assertNoLiveTwin, mailboxHasRequestKey, resolveCloudInstallId,
} from "./lease.js";

const argv = process.argv.slice(2);

const mailboxId = cliOpt(argv, "mailbox");
const apply = cliFlag(argv, "apply");
const limit = cliOpt(argv, "limit") ? Number(cliOpt(argv, "limit")) : undefined;
const dbUrl = process.env.TF_DB_URL ?? process.env.DATABASE_URL;
if (!mailboxId) { console.error("refusing to run without --mailbox <id>"); process.exit(2); }
if (!dbUrl) { console.error("set TF_DB_URL to the production session URL"); process.exit(2); }

const keyProvider = keyProviderFromEnvOptional(process.env);
if (!keyProvider) { console.error("set TF_KEK_V1 — the restore must decrypt IMAP credentials"); process.exit(2); }

const owned = makeOwnedDb(dbUrl);
const db = owned.db as unknown as Tx;

const read = await readOperatorMailbox(db, mailboxId);
if ("refusal" in read) { console.error(read.refusal); await owned.close(); process.exit(2); }
const mb = read.mailbox;

const [{ n: candidates }] = await db.select({ n: sql<number>`count(*)::int` })
  .from(messages).innerJoin(messageBodies, eq(messageBodies.messageId, messages.id))
  .where(and(eq(messages.mailboxId, mailboxId), like(messageBodies.text, "%[REDACTED]%"))) as unknown as [{ n: number }];

console.log(`mailbox ${mb.address} (${mb.id})`);
console.log(`still-redacted bodies: ${candidates}`);

if (!apply) {
  console.log(`\nDRY RUN — nothing written. Re-run with --apply${limit ? ` --limit ${limit}` : ""} to restore.`);
  await owned.close();
  process.exit(0);
}

const creds = await loadMailboxCreds(owned.db, mailboxId, keyProvider);
if (!creds) { console.error("no imap credentials for this mailbox"); await owned.close(); process.exit(2); }

/* This command dials the operator's own deployment, so it asks the deployment's own policy —
   the same variable the organizer and the API read. A tool that dialled a host the always-on
   organizer refuses would be a third answer about one network. */
const adapter = new ImapAdapter({
  host: creds.imap.host, port: creds.imap.port, secure: creds.imap.secure,
  ...(await checkedDial(dialHostGuardFromEnv(process.env), creds.imap.host, "imap")),
  ...(creds.imap.allowInsecure ? { allowInsecure: true } : {}),
  // The assembled `auth` union from the shared builder (this CLI passes no token source, so an
  // oauth2 mailbox refuses rather than restoring — a redacted-body restore is a password-era tool).
  auth: creds.imap.auth,
});
let restored = 0, fetched = 0, mismatched = 0, unreadable = 0;
try {
  await adapter.connect();

  // THE ORGANIZER LEASE, BEFORE `ensureFolders()` — WHICH IS A WRITE. The pass only FETCHES bodies and
  // writes our own database, so it looks read-only; `ensureFolders()` is not — it CREATES the `ohmail/*`
  // tree in somebody else's mailbox. `reconcile-cron.ts` gates at this seam, and the pass registry ALREADY
  // CLAIMED this runner took a lease (it did not; same seam as `run-junk-sweep.ts`). No `guard` or `check()`
  // beyond this: the acquisition IS the check (`acquireLeasePermit` reads the lease and throws on a
  // stand-down, and `ensureFolders()` is the next statement). `ensureFolders()` is not one write — it issues
  // a `mailboxCreate` per missing folder (up to five), so a takeover after the second leaves this creating
  // folders in a mailbox it no longer organizes; NOT fixed here because the check would have to live in
  // `packages/core/src/adapters/imap.ts` (the same seam that bounds `moveMany` and `move`'s COPY-then-DELETE),
  // and creating a folder is additive where a move is destructive. The dry-run path returns before `connect()`.
  try {
    // Before the gate, and for the reason `assertNoLiveTwin` sets out: this runner shares the
    // always-on worker's install id and holds no leader lock, so `lastNonce: null` would let it
    // adopt a live worker's claim as its own and expunge it.
    await assertNoLiveTwin({
      adapter,
      installId: resolveCloudInstallId(process.env),
      now: new Date(),
    });

    await acquireLeasePermit({
      adapter,
      mailboxId,
      // The SAME set the worker and the backstop advertise — this command renews their shared
      // claim, so a narrower set here would make `requests` blink out for readers mid-repair.
      hasRequestKey: mailboxHasRequestKey({ auth: creds.imap.auth, address: mb.address }),
      self: {
        installId: resolveCloudInstallId(process.env),
        kind: "cloud",
        displayName: CLOUD_DISPLAY_NAME,
        // Safe only because of the check above — see `run-junk-sweep.ts`'s note at the same seam.
        lastNonce: null,
      },
      // A takeover is a human decision recorded on the mailbox row; an operator invoking a repair
      // has not made it.
      takeover: null,
      log: (event, detail) => { console.log(`${event} ${JSON.stringify(detail)}`); },
    });
  } catch (err) {
    if (err instanceof OrganizerStandDownError) {
      console.error(
        `refusing to restore: ${err.message}\n` +
        `  held by: ${err.heldBy ?? "(unnamed)"} — ${err.state === "held" ? "still renewing" : "stopped, but not ours to take"}\n` +
        `  reason:  ${err.reason}\n` +
        `Nothing was created and nothing was fetched.`,
      );
      process.exitCode = 3;
    } else if (err instanceof LeaseUnavailableError) {
      // NOT a stand-down: our problem or the connection's, never evidence about who holds it.
      console.error(`refusing to restore: the organizer lease could not be read — ${err.message}`);
      process.exitCode = 4;
    }
    throw err;
  }

  await adapter.ensureFolders();
  for (;;) {
    const r = await redactedRestorePass({
      db, adapter, accountId: mb.accountId, mailboxId,
      fetchesPerCycle: limit ?? undefined,
    });
    restored += r.restored; fetched += r.fetched; mismatched += r.mismatched; unreadable += r.unreadable;
    if (limit !== undefined || !r.capped) break; // a --limit run does exactly one bounded pass
  }
} finally {
  try { await adapter.close(); } catch { /* ignore */ }
  await owned.close();
}
console.log(`\nrestored ${restored} bodies (fetched ${fetched}, mismatched ${mismatched}, unreadable ${unreadable}).`);
