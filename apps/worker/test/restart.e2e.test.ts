import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { messages, folderState } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { runSyncCycle } from "../src/sync.js";
import { reconcileOnRestart } from "../src/restart.js";
import { byMessageId, makeHarness, rawClient, emlOf, uidInFolder, dbUrlFor } from "./_workerenv.js";
import { FIXTURE_LEASE } from "./_door.js";

const DB_URL = dbUrlFor(import.meta.url);

describe("reconcile-on-restart (crash-safety)", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it("converges when the IMAP move completed but the DB was not updated before the crash", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const deps = { repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };

    // ingest a message that stays in INBOX (anna is a known contact → stays in INBOX, reconciled)
    const c = await rawClient(h.cfg);
    await c.append("INBOX", emlOf({ from: "anna@x.example", subject: "hello", messageId: "r1@x" }));
    await runSyncCycle(deps);

    const [msg] = await h.db.select().from(messages).where(byMessageId(h.mailboxId, "r1@x"));
    const oldLoc = msg.nativeLocator as { folder: string; ref: string };

    // SIMULATE crash mid-move: perform the IMAP move out-of-band, and mark folder_state pending toward Feed
    // with the STALE (old INBOX) locator still on the message row.
    const lock = await c.getMailboxLock("INBOX");
    try {
      const uid = Number(oldLoc.ref.split(":")[1]);
      await c.messageMove([uid], "ohmail.News", { uid: true }).catch(async () => {
        await c.messageCopy([uid], "ohmail.News", { uid: true }); await c.messageDelete([uid], { uid: true });
      });
    } finally { lock.release(); }
    await h.db.insert(folderState).values({ messageId: msg.id, desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us", reconcileStatus: "pending" })
      .onConflictDoUpdate({ target: folderState.messageId, set: { desiredFolder: "ohmail/News", observedFolder: "INBOX", lastSetBy: "us", reconcileStatus: "pending" } });

    // RESTART
    await reconcileOnRestart(deps);
    await reconcileOnRestart(deps); // running twice must be idempotent (no thrash)

    const rows = await h.db.select().from(messages).where(byMessageId(h.mailboxId, "r1@x"));
    expect(rows).toHaveLength(1); // no duplicate re-ingest
    expect((rows[0].nativeLocator as { folder: string }).folder).toBe("ohmail/News"); // locator refreshed

    const fs = await h.db.select().from(folderState).where(eq(folderState.messageId, msg.id));
    expect(fs[0]).toMatchObject({ desiredFolder: "ohmail/News", observedFolder: "ohmail/News", reconcileStatus: "reconciled" });

    // server truth: in Feed once, not back in INBOX
    expect((await uidInFolder(c, "ohmail.News", "r1@x")).length).toBe(1);
    expect((await uidInFolder(c, "INBOX", "r1@x")).length).toBe(0);
    await c.logout();
  }, 20000);
});
