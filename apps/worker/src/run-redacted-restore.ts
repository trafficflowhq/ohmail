/**
 * ONE-OFF RUNNER for the [REDACTED] body restore (`redacted-restore.ts`), scoped to ONE mailbox.
 *
 * It re-reads originals with BODY.PEEK (no `\Seen`) and stores the full body, KEEPING sensitivity
 * flags. It opens IMAP, so it needs `TF_KEK_V1` to decrypt the mailbox's stored credentials — the
 * same material the always-on worker holds. Dry-run by default; `--apply` writes. `--limit N` caps
 * the fetches for a bounded proof run. Reversible in the sense that matters: it MUTATES NOTHING ON
 * THE MAIL SERVER (peek-only) and only overwrites a DB body with the server's authoritative copy.
 *
 *   TF_DB_URL=… TF_KEK_V1=… tsx apps/worker/src/run-redacted-restore.ts --mailbox <id>
 *   TF_DB_URL=… TF_KEK_V1=… tsx apps/worker/src/run-redacted-restore.ts --mailbox <id> --apply --limit 5
 */
import { and, eq, like, sql } from "drizzle-orm";
import { makeOwnedDb } from "@trafficflow/db/cloud";
import { mailboxes, messageBodies, messages, type Tx } from "@trafficflow/db";
import { keyProviderFromEnvOptional } from "@trafficflow/core";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { loadMailboxCreds } from "./mailboxes.js";
import { redactedRestorePass } from "./redacted-restore.js";
import {
  CLOUD_DISPLAY_NAME, LeaseUnavailableError, OrganizerStandDownError, acquireLeasePermit,
  cloudInstallId,
} from "./lease.js";

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(`--${n}`);
const opt = (n: string): string | null => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : null;
};

const mailboxId = opt("mailbox");
const apply = flag("apply");
const limit = opt("limit") ? Number(opt("limit")) : undefined;
const dbUrl = process.env.TF_DB_URL ?? process.env.DATABASE_URL;
if (!mailboxId) { console.error("refusing to run without --mailbox <id>"); process.exit(2); }
if (!dbUrl) { console.error("set TF_DB_URL to the production session URL"); process.exit(2); }

const keyProvider = keyProviderFromEnvOptional(process.env);
if (!keyProvider) { console.error("set TF_KEK_V1 — the restore must decrypt IMAP credentials"); process.exit(2); }

const owned = makeOwnedDb(dbUrl);
const db = owned.db as unknown as Tx;

const [mb] = await db.select({ id: mailboxes.id, accountId: mailboxes.accountId, address: mailboxes.address })
  .from(mailboxes).where(eq(mailboxes.id, mailboxId)).limit(1);
if (!mb) { console.error(`no mailbox ${mailboxId}`); await owned.close(); process.exit(2); }

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

const adapter = new ImapAdapter({
  host: creds.imap.host, port: creds.imap.port, secure: creds.imap.secure,
  ...(creds.imap.allowInsecure ? { allowInsecure: true } : {}),
  // The assembled `auth` union from the shared builder (this CLI passes no token source, so an
  // oauth2 mailbox refuses rather than restoring — a redacted-body restore is a password-era tool).
  auth: creds.imap.auth,
});
let restored = 0, fetched = 0, mismatched = 0, unreadable = 0;
try {
  await adapter.connect();

  // ── THE ORGANIZER LEASE, BEFORE `ensureFolders()` — WHICH IS A WRITE ─────────────────────────
  //
  // The pass below only FETCHES bodies and writes to our own database, so it looks like a
  // read-only tool. `ensureFolders()` is not: it CREATES the `ohmail/*` tree, in somebody else's
  // mailbox. `reconcile-cron.ts` runs its gate at exactly this seam and says why in those words,
  // and the pass registry ALREADY CLAIMED this runner "takes the mailbox's lease for its fetches"
  // — it did not take one at all. The seam is the same one `run-junk-sweep.ts` had.
  //
  // No permit and no `guard` beyond this point, and that is not an omission: `ensureFolders()` is
  // the only server MUTATION this process performs, so there is no later write boundary for a
  // permit to be re-verified at. A single check immediately before the single write is the whole
  // requirement here — which is precisely why the permit's expiry matters for the sweep and not
  // for this. The dry-run path returns before `connect()` and so never reaches the lease, keeping
  // its promise to write nothing anywhere, `ohmail/_meta` included.
  try {
    await acquireLeasePermit({
      adapter,
      self: {
        installId: process.env.TF_ORGANIZER_INSTALL_ID
          ?? cloudInstallId(process.env.TF_ENVIRONMENT ?? "production"),
        kind: "cloud",
        displayName: CLOUD_DISPLAY_NAME,
        lastNonce: null,
      },
      // A takeover is a human decision recorded on the mailbox row; an operator invoking a repair
      // has not made it.
      takeover: "none",
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
