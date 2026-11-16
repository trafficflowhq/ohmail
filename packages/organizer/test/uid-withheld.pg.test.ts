import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mailboxFolders, messageFailures } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { realPgAvailable } from "@trafficflow/db/testing";
import type { ChangeBatch, ImapCursor, MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { runSyncCycle } from "../src/sync.js";
import { DeadLetterLedger } from "../src/dead-letter.js";
import { makeHarness, rawClient, emlOf, repoWithFailingMethod, DB_URL } from "./_workerenv.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A UID THE SERVER LISTED AND WOULD NOT HAND OVER — the worker's half
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `ChangeBatch.unanswered` carries the UIDs the adapter asked for and did not receive. No `Change`
 * exists for them, so the ingest loop's `attempt` boundary — which is where every other skip
 * becomes a durable row — never sees them. Before this slice they were crossed in SILENCE: the
 * folder cursor published the server's `uidNext`, `hasBacklog` stayed false, and on a live iCloud
 * mailbox `initial_import_completed_at` was stamped over a folder holding two messages and zero
 * imports.
 *
 * The rule the rest of this file already obeys is that a folder cursor may cross a UID only once a
 * durable row for it is committed. These tests pin that the withheld UIDs obey it too:
 *
 *   1. the row is written, and the cursor advances — the mail is OWED, not lost, and the targeted
 *      retry re-reads it by UID on a schedule and on every deploy;
 *   2. when the row CANNOT be written, the folder's cursor is held and the cycle fails, which is
 *      the same answer `sync_message_skip_unrecordable` gives for the same reason.
 *
 * Real Postgres: the claim is about what commits and in what order, and `message_failures` carries
 * a CHECK-constrained code column that PGlite has been blind to before.
 */

const AVAILABLE = await realPgAvailable(DB_URL);

/** Hand `changesSince` back unchanged, plus a UID the "server" refused to return. */
function withholdUid(
  inner: MailboxAdapter, site: { folder: string; uidValidity: string; uid: number },
): MailboxAdapter {
  return new Proxy(inner, {
    get(t, prop, recv) {
      if (prop === "changesSince") {
        return async (c: ImapCursor): Promise<ChangeBatch> => {
          const batch = await (t as MailboxAdapter).changesSince(c);
          return { ...batch, unanswered: [site] };
        };
      }
      const v = Reflect.get(t, prop, recv);
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

describe.skipIf(!AVAILABLE)("a UID the server withheld (GreenMail + real Postgres)", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  type Harness = Awaited<ReturnType<typeof makeHarness>>;

  const failures = async (h: Harness) =>
    h.db.select().from(messageFailures).where(eq(messageFailures.mailboxId, h.mailboxId));
  const inboxCursor = async (h: Harness) => {
    const rows = await h.db.select().from(mailboxFolders).where(eq(mailboxFolders.mailboxId, h.mailboxId));
    return rows.find((f) => f.folder === "INBOX");
  };

  async function seedInbox(h: Harness, mids: readonly string[]): Promise<void> {
    const c = await rawClient(h.cfg);
    for (const mid of mids) {
      await c.append("INBOX", emlOf({ from: "anna@x.example", subject: mid, messageId: mid }));
    }
    await c.logout();
  }

  it("records the withheld UID durably, and only then lets the cursor cross it", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    await seedInbox(h, [`kept-${randomUUID()}@trafficflow.test`]);

    // The UID below is not in the folder — which is the point. Nothing enumerated it, nothing
    // ingested it, and without `unanswered` nothing would ever have mentioned it again.
    const site = { folder: "INBOX", uidValidity: "1", uid: 9999 };
    const adapter = withholdUid(h.adapter, site);

    await expect(runSyncCycle({
      repo: h.repo, adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
      deadLetters: new DeadLetterLedger(), buildVersion: "build-one",
    })).resolves.toMatchObject({ hasBacklog: false });

    // ── THE DURABLE RECORD. Its absence was the whole defect ──────────────────────────────
    const owed = await failures(h);
    expect(owed).toHaveLength(1);
    expect(owed[0]).toMatchObject({
      folder: "INBOX", uid: 9999, code: "unclassified", resolvedAt: null,
    });
    // On a clock, so it is re-read without waiting for a deploy — and the version arm of
    // `claimMessageFailures` wakes it on every build regardless.
    expect(owed[0]!.nextAttemptAt).not.toBeNull();
    expect(owed[0]!.attemptedVersion).toBe("build-one");

    // The cursor DID advance: the UID is owed by a committed row, which is exactly the condition
    // under which crossing it is safe. Holding it instead would re-fetch for ever and pin the
    // mailbox in "importing" — the failure mode two earlier slices were written to remove.
    expect(await inboxCursor(h)).toBeDefined();
  });

  it("HOLDS the folder cursor when the durable record cannot be written", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    await seedInbox(h, [`kept-${randomUUID()}@trafficflow.test`]);

    const site = { folder: "INBOX", uidValidity: "1", uid: 4242 };
    const boom = new Error("message_failures is unwritable");
    // The repo the cycle runs on, with the ONE write this slice added made to fail.
    const repo = repoWithFailingMethod(h.repo, "recordMessageFailure", () => { throw boom; });

    await expect(runSyncCycle({
      repo, adapter: withholdUid(h.adapter, site), accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
      deadLetters: new DeadLetterLedger(), buildVersion: "build-one",
    })).rejects.toThrow(boom);

    // NO cursor row for INBOX. A watermark written across a UID whose record was refused is the
    // mail-loss shape reached through a database hiccup instead of through a restart.
    expect(await inboxCursor(h), "INBOX's cursor must be held when the record could not be written")
      .toBeUndefined();
    expect(await failures(h)).toHaveLength(0);
  });
});
