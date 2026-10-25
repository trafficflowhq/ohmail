import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { messages, folderState, whyTheyStayed, type Tx } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { runSyncCycle, type SyncDeps } from "../src/sync.js";
import { byMessageId, makeHarness, rawClient, emlOf, uidInFolder, dbUrlFor } from "./_workerenv.js";
import { FIXTURE_DOOR, FIXTURE_LEASE } from "./_door.js";

const DB_URL = dbUrlFor(import.meta.url);

/**
 * THE SERVER HALF OF "FILED IN ANOTHER MAIL APP". Another client moves a
 * message ohmail filed into a folder of the person's own with a plain IMAP MOVE; the sync adopts
 * it as the person's hand ('external'), and the why-stayed ask names it `filed-elsewhere`. The
 * sheet can only say so if it asks about that row.
 */
describe("another mail app's filing is adopted and answers filed-elsewhere", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it("a plain IMAP MOVE into Fixture reads external, at Fixture, filed-elsewhere", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const deps: SyncDeps = { repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
      role: "organizer", trustedAuthservIds: new Set<string>() };
    const c = await rawClient(h.cfg);
    closers.push(async () => { await c.logout(); });
    await c.mailboxCreate("Fixture").catch(() => undefined);
    // The adapter listed its folders at connect, before Fixture existed: a real worker re-lists.
    await h.adapter.ensureFolders(FIXTURE_DOOR);
    await c.append("INBOX", emlOf({ from: "letters@vendor.example", subject: "issue 6", messageId: "fx6@vendor" }));
    await runSyncCycle(deps);
    const [msg] = await h.db.select().from(messages).where(byMessageId(h.mailboxId, "fx6@vendor"));
    const from = (msg!.nativeLocator as { folder: string }).folder;
    const uid = Number((msg!.nativeLocator as { ref: string }).ref.split(":")[1]);
    const serverFrom = from === "INBOX" ? "INBOX" : from.replace("/", ".");
    const lock = await c.getMailboxLock(serverFrom);
    try { await c.messageMove([uid], "Fixture", { uid: true }); } finally { lock.release(); }
    expect((await uidInFolder(c, "Fixture", "fx6@vendor")).length).toBe(1);

    for (let i = 0; i < 4; i++) await runSyncCycle(deps);

    const [row] = await h.db.select().from(messages).where(byMessageId(h.mailboxId, "fx6@vendor"));
    const [fs] = await h.db.select().from(folderState).where(eq(folderState.messageId, row!.id));
    expect((row!.nativeLocator as { folder: string }).folder).toBe("Fixture");
    expect(fs?.lastSetBy).toBe("external");
    const why = await whyTheyStayed(h.db as unknown as Tx, h.accountId, [row!.id], []);
    expect(why.get(row!.id)).toBe("filed-elsewhere");
  }, 30000);
});
