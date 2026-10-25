import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { messages, folderState } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { MessageService, type ServiceContext } from "@trafficflow/services";
import { runSyncCycle } from "../src/sync.js";
import { byMessageId, makeHarness, rawClient, emlOf, uidInFolder, dbUrlFor } from "./_workerenv.js";
import { FIXTURE_LEASE } from "./_door.js";

const DB_URL = dbUrlFor(import.meta.url);

/**
 * End-to-end proof: the serverless API is the single writer of DESIRED state
 * and DEFERS the physical IMAP move to the always-on worker. Here we call
 * `MessageService.move` (the exact code path the `POST /messages/:id/move` handler
 * invokes — the handler is a thin wrapper) against the SAME Postgres the worker
 * reads. The API opens NO IMAP connection; it only writes folder_state
 * desired=Feed / lastSetBy='us' / reconcileStatus='pending'. The worker's
 * `runSyncCycle` (→ reconcileMailbox drains listPendingFolderStates) then performs
 * the real IMAP move on GreenMail. We assert both the physical move AND
 * convergence (folder_state no longer pending), proving the API→worker handoff.
 */
describe("API move → worker IMAP handoff (real GreenMail)", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it("API sets desired=Feed (pending); the worker executes the physical IMAP move and converges", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const deps = { repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };

    // A message from a known contact (anna) stays in INBOX after ingest → reconciled.
    const c = await rawClient(h.cfg);
    await c.append("INBOX", emlOf({ from: "anna@x.example", subject: "hi", messageId: "api1@x" }));
    await runSyncCycle(deps);

    const [msg] = await h.db.select().from(messages)
      .where(byMessageId(h.mailboxId, "api1@x"));
    expect(msg).toBeTruthy();

    // ── API side (NO IMAP): write DESIRED state only, via the same service the HTTP handler calls. ──
    const ctx: ServiceContext = {
      db: h.db, accountId: h.accountId, userId: null, now: () => new Date(), requestId: "e2e",
    };
    // `move` answers a union: written here, or a request routed to the install that organizes
    // the mailbox. This rig organizes it, so the local arm is the one under test — narrowed
    // rather than cast, and in this file rather than through a helper in another package's tests.
    const outcome = await new MessageService().move(ctx, msg.id, { folder: "ohmail/News" });
    if ("pending" in outcome) {
      throw new Error("the move became a request — this rig organizes the mailbox it is moving in");
    }
    const { dto, seq } = outcome;
    expect(dto.folder).toBe("ohmail/News");
    expect(seq).toBeGreaterThan(0);

    // folder_state now pending toward Feed, observed still INBOX (worker hasn't run).
    const [pending] = await h.db.select().from(folderState).where(eq(folderState.messageId, msg.id));
    expect(pending).toMatchObject({ desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us", reconcileStatus: "pending" });
    // Still physically in INBOX — the API opened no IMAP connection.
    expect((await uidInFolder(c, "INBOX", "api1@x")).length).toBe(1);
    expect((await uidInFolder(c, "ohmail.News", "api1@x")).length).toBe(0);

    // ── Worker side: the reconcile path performs the real IMAP move + converges. ──
    await runSyncCycle(deps);

    const [convergedFs] = await h.db.select().from(folderState).where(eq(folderState.messageId, msg.id));
    expect(convergedFs.reconcileStatus).not.toBe("pending");
    expect(convergedFs).toMatchObject({ desiredFolder: "ohmail/News", observedFolder: "ohmail/News", reconcileStatus: "reconciled" });

    const [movedMsg] = await h.db.select().from(messages).where(eq(messages.id, msg.id));
    expect((movedMsg.nativeLocator as { folder: string }).folder).toBe("ohmail/News");

    // Server truth: physically moved to Feed, gone from INBOX.
    expect((await uidInFolder(c, "ohmail.News", "api1@x")).length).toBe(1);
    expect((await uidInFolder(c, "INBOX", "api1@x")).length).toBe(0);
    await c.logout();
  }, 30000);
});
