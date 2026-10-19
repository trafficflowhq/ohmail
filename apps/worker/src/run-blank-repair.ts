/**
 * ONE-OFF RUNNER for the blank repair (`blank-repair.ts`), scoped to ONE mailbox. Dry by default: it
 * counts the mailbox's blank rows and their places from the store and touches no mail server.
 * `--apply` takes the organizer lease and runs the pass: each place is read (BODY.PEEK, no `\Seen`),
 * a letter the blank's move filed away goes back to INBOX, every other place is released and the
 * letter owed a re-read the next visit imports. `--limit N` caps the places of a bounded proof run.
 * Prints counts and the mailbox id, never an address or anything of a message.
 *
 *   TF_DB_URL=… <key ring> tsx apps/worker/src/run-blank-repair.ts --mailbox <id> [--apply --limit 5]
 */
import { makeOwnedDb } from "@trafficflow/db/cloud";
import type { Tx } from "@trafficflow/db";
import { keyProviderFromEnvOptional } from "@trafficflow/core";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { makeDrizzleRepo, type WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { loadMailboxCreds } from "./mailboxes.js";
import { checkedDial, dialHostGuardFromEnv } from "./dial-host-guard.js";
import { blankRepairPass, BLANK_REPAIR_PLACES_PER_VISIT } from "./blank-repair.js";
import { buildVersionOf } from "./build-version.js";
import { cliArgs, readRunnerMailbox, takeRunnerLease } from "./run-cli.js";
import { writeDoorOf } from "./lease.js";

const { flag, opt } = cliArgs(process.argv.slice(2));

const mailboxId = opt("mailbox");
const apply = flag("apply");
const limit = opt("limit") ? Number(opt("limit")) : undefined;
const dbUrl = process.env.TF_DB_URL ?? process.env.DATABASE_URL;
if (!mailboxId) { console.error("refusing to run without --mailbox <id>"); process.exit(2); }
if (!dbUrl) { console.error("set TF_DB_URL to the production session URL"); process.exit(2); }
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) { console.error("--limit takes a positive integer"); process.exit(2); }

const owned = makeOwnedDb(dbUrl);
const db = owned.db as unknown as Tx;
const repo: WorkerRepo = makeDrizzleRepo(db);

const found = await readRunnerMailbox(db, mailboxId);
if (found === null) { console.error(`no mailbox ${mailboxId}`); await owned.close(); process.exit(2); }
if ("refusal" in found) { console.error(found.refusal); await owned.close(); process.exit(2); }
const mb = found.mailbox;

const rows = typeof repo.listBlankMessages === "function" ? await repo.listBlankMessages(mailboxId) : [];
// Every place, counted in the store: the listing is bounded, the count is not. Primaries list first.
const held = rows.reduce((n, r) => n + r.placeCount, 0);
console.log(`mailbox ${mb.id}`);
console.log(`blank rows: ${rows.length}, places: ${held} (primary ${rows.flatMap((r) => r.places).filter((p) => p.isPrimary).length})`);
console.log(`moved by ohmail and settled outside INBOX: ${rows.filter((r) => r.folderState !== null
  && r.folderState.lastSetBy === "us" && r.folderState.desired === r.folderState.observed
  && r.folderState.desired !== "INBOX").length}, a move still owed: ${rows.filter((r) => r.folderState !== null
  && r.folderState.lastSetBy === "us" && r.folderState.desired !== r.folderState.observed).length}`);

if (!apply) {
  console.log(`\nDRY RUN — nothing read from the mail server, nothing written. Re-run with --apply${limit ? ` --limit ${limit}` : ""} to repair.`);
  await owned.close();
  process.exit(0);
}

const keyProvider = keyProviderFromEnvOptional(process.env);
if (!keyProvider) { console.error("no KEK ring in the environment — the repair must decrypt IMAP credentials (see keyProviderFromEnvOptional)"); await owned.close(); process.exit(2); }
const creds = await loadMailboxCreds(owned.db, mailboxId, keyProvider);
if (!creds) { console.error("no imap credentials for this mailbox"); await owned.close(); process.exit(2); }

/* The operator's own deployment policy on the hosts it may dial, as the organizer and the API read it. */
const adapter = new ImapAdapter({
  host: creds.imap.host, port: creds.imap.port, secure: creds.imap.secure,
  ...(await checkedDial(dialHostGuardFromEnv(process.env), creds.imap.host, creds.imap.port, "imap", creds.imap)),
  auth: creds.imap.auth,
});
const total = { returned: 0, released: 0, owed: 0, kept: 0, unreadable: 0, failed: 0, deferred: 0, places: 0, remaining: 0 };
try {
  await adapter.connect();
  // THE ORGANIZER LEASE, BEFORE THE FIRST WRITE — the pass moves mail back to INBOX under it.
  const permit = await takeRunnerLease({
    adapter, mailboxId, mailbox: mb, auth: creds.imap.auth, env: process.env,
    voice: { verb: "repair", nothingDone: "Nothing was moved and nothing was written." },
    log: (line) => { console.log(line); },
  });
  await adapter.ensureFolders(writeDoorOf({ lease: permit }));
  for (;;) {
    const r = await blankRepairPass({
      repo, adapter, accountId: mb.accountId, mailboxId, role: "organizer", mode: "apply",
      write: (fn) => repo.transaction(fn), writeAuthority: { lease: permit }, version: buildVersionOf(process.env),
      placesPerVisit: limit ?? BLANK_REPAIR_PLACES_PER_VISIT,
    });
    total.returned += r.returned; total.released += r.released; total.owed += r.owed;
    total.kept += r.kept; total.unreadable += r.unreadable; total.failed += r.failed; total.deferred += r.deferred;
    total.places += r.places; total.remaining = r.remaining;
    // A --limit run is one bounded pass; otherwise until a pass finds nothing it may try. A place that
    // failed waits (BLANK_REPAIR_RETRY_BASE_MS and more), so the next pass tries the others, and no
    // place is read twice unless its read failed and its wait ran out.
    if (limit !== undefined || r.places === 0) break;
  }
} finally {
  try { await adapter.close(); } catch { /* ignore */ }
  await owned.close();
}
console.log(`\nread ${total.places} places: returned ${total.returned} to INBOX, released ${total.released} `
  + `(${total.owed} owed a re-read), kept ${total.kept} letters with no content, ${total.unreadable} unreadable, `
  + `${total.failed} moves failed, ${total.deferred} left for a later run; ${total.remaining} places still to repair.`);
