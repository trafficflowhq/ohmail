import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { messages, folderState } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { runSyncCycle } from "../src/sync.js";
import { byMessageId, makeHarness, rawClient, emlOf, uidInFolder, dbUrlFor } from "./_workerenv.js";
import { FIXTURE_LEASE } from "./_door.js";

const DB_URL = dbUrlFor(import.meta.url);

describe("worker sync cycle (GreenMail + Postgres)", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it("ingests + routes to a real folder and persists the NEW locator with no duplicate re-ingest", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const deps = { repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };

    // deliver a message from a rule-matched domain → should be filed into ohmail/News
    const c = await rawClient(h.cfg);
    await c.append("INBOX", emlOf({ from: "news@feed.example", subject: "digest", messageId: "d1@feed" }));

    await runSyncCycle(deps);   // cycle 1: ingest (INBOX) → desired=Feed → reconcile moves it
    await runSyncCycle(deps);   // cycle 2: observe the completed move; must NOT duplicate or thrash

    // exactly one message row, its locator now points at Feed
    const rows = await h.db.select().from(messages).where(byMessageId(h.mailboxId, "d1@feed"));
    expect(rows).toHaveLength(1);
    expect((rows[0].nativeLocator as { folder: string }).folder).toBe("ohmail/News");

    // folder_state converged
    const fs = await h.db.select().from(folderState).where(eq(folderState.messageId, rows[0].id));
    expect(fs[0]).toMatchObject({ desiredFolder: "ohmail/News", observedFolder: "ohmail/News", reconcileStatus: "reconciled" });

    // server truth: present in Feed, absent from INBOX
    expect((await uidInFolder(c, "ohmail.News", "d1@feed")).length).toBe(1);
    expect((await uidInFolder(c, "INBOX", "d1@feed")).length).toBe(0);
    await c.logout();
  }, 20000);
});
