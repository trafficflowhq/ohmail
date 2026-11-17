import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { messages, folderState } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { runSyncCycle } from "../src/sync.js";
import { byMessageId, makeHarness, rawClient, emlOf, uidInFolder, dbUrlFor } from "./_workerenv.js";
import { FIXTURE_LEASE } from "./_door.js";

const DB_URL = dbUrlFor(import.meta.url);

describe("external move → adopted, never reverted (user-wins)", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it("detects a user's manual move as a MOVE and keeps it (no revert, no duplicate)", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const deps = { repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };

    // anna is a known contact → the message settles in INBOX (desired = INBOX)
    const c = await rawClient(h.cfg);
    await c.append("INBOX", emlOf({ from: "anna@x.example", subject: "keep me", messageId: "e1@x" }));
    await runSyncCycle(deps);

    const [msg] = await h.db.select().from(messages).where(byMessageId(h.mailboxId, "e1@x"));
    expect((msg.nativeLocator as { folder: string }).folder).toBe("INBOX");

    // the USER manually moves it INBOX → ohmail/Screened (external change)
    const uid = Number((msg.nativeLocator as { ref: string }).ref.split(":")[1]);
    const lock = await c.getMailboxLock("INBOX");
    try {
      await c.messageMove([uid], "ohmail.Screened", { uid: true }).catch(async () => {
        await c.messageCopy([uid], "ohmail.Screened", { uid: true }); await c.messageDelete([uid], { uid: true });
      });
    } finally { lock.release(); }

    await runSyncCycle(deps); // must adopt (observe move), not revert to INBOX
    await runSyncCycle(deps); // idempotent

    const rows = await h.db.select().from(messages).where(byMessageId(h.mailboxId, "e1@x"));
    expect(rows).toHaveLength(1);
    expect((rows[0].nativeLocator as { folder: string }).folder).toBe("ohmail/Screened"); // adopted

    // server truth: still in Screened, NOT moved back to INBOX
    expect((await uidInFolder(c, "ohmail.Screened", "e1@x")).length).toBe(1);
    expect((await uidInFolder(c, "INBOX", "e1@x")).length).toBe(0);

    // folder_state adopted the user's choice (desired follows observed; no destructive conflict)
    const fs = await h.db.select().from(folderState).where(eq(folderState.messageId, rows[0].id));
    expect(fs[0].observedFolder).toBe("ohmail/Screened");
    await c.logout();
  }, 20000);
});
