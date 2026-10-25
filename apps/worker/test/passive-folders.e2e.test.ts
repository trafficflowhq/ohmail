import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { messages, folderState, mailboxFolders, messageInstances } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { runSyncCycle } from "../src/sync.js";
import { stampInitialImportComplete } from "../src/mailboxes.js";
import { byMessageId, makeHarness, rawClient, emlOf, uidInFolder, dbUrlFor } from "./_workerenv.js";
import { mailboxes } from "@trafficflow/db";
import { FIXTURE_DOOR, FIXTURE_LEASE } from "./_door.js";

const DB_URL = dbUrlFor(import.meta.url);

/**
 * MAIL IN A FOLDER THE CUSTOMER MADE — end to end, against a real IMAP server.
 *
 * The unit guards prove the rules against fakes; this proves the round trip nothing else can: a real
 * LIST, a real `toServerPath` on a server with its own delimiter, a real SELECT, a real body fetch,
 * and a real `folder_state` row. It is the acceptance for the whole slice:
 *
 *   a folder the customer made, holding old mail  →  INGESTED, and findable
 *                                                 →  UNTOUCHED: still on the server, in that folder
 *                                                 →  the import stamp lands
 *
 * The rule seeded by `makeHarness` (`domain feed.example → ohmail/News`) is what makes the middle line
 * a measurement rather than a hope: the message filed into the customer's folder is FROM
 * `feed.example`, so a pipeline that treated it as an ordinary arrival would move it, and the assertion
 * that the server still holds it where the customer put it is the one that goes red.
 */
describe("a folder the customer made is read, and never re-filed", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it("ingests it, leaves it exactly where it was, and lands the import stamp", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const deps = { repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };

    // The customer's own folder, made in their own mail client years ago, with mail already in it.
    // `feed.example` is the sender the seeded rule files into `ohmail/News`.
    const c = await rawClient(h.cfg);
    closers.push(() => c.logout().then(() => undefined));
    await c.mailboxCreate("Private");
    await c.append("Private", emlOf({
      from: "newsletter@feed.example", subject: "Frischer Auftritt", messageId: "passive-e2e-1@x",
    }));
    // …and one ordinary arrival, so the same cycle is known to be doing its normal work.
    await c.append("INBOX", emlOf({ from: "anna@x.example", subject: "keep me", messageId: "passive-e2e-2@x" }));

    // The adapter learned its folder inventory at `connect()`, before `Private` existed. A reconnect
    // is what a real worker does on its next attach; `ensureFolders` re-LISTs on the same connection.
    await h.adapter.ensureFolders(FIXTURE_DOOR);

    // Drain — a first import is bounded per cycle, so the loop is the contract, not an optimisation.
    let hasBacklog = true;
    for (let i = 0; i < 10 && hasBacklog; i++) ({ hasBacklog } = await runSyncCycle(deps));
    expect(hasBacklog, "the import must end a cycle owing nothing").toBe(false);

    // ── 1. INGESTED. Without the passive scan there is no row at all, and the mail is in no search.
    const [msg] = await h.db.select().from(messages)
      .where(byMessageId(h.mailboxId, "passive-e2e-1@x"));
    expect(msg, "mail in the customer's own folder was not ingested").toBeDefined();
    expect((msg!.nativeLocator as { folder: string }).folder).toBe("Private");

    // ── 2. NEVER RE-FILED. The rule matches this sender and would have moved it to `ohmail/News`.
    const [fs] = await h.db.select().from(folderState).where(eq(folderState.messageId, msg!.id));
    expect(fs!.desiredFolder, "a rule re-filed the customer's own folder").toBe("Private");
    expect(fs!.observedFolder).toBe("Private");
    // `'external'` — a placement the USER made. Every retro pass requires `'us'`.
    expect(fs!.lastSetBy).toBe("external");

    // ── 3. THE SERVER IS THE MASTER, AND IT IS UNTOUCHED. The strongest statement available: the
    // message is still in the folder the customer put it in, and nothing was written to Reads.
    expect(await uidInFolder(c, "Private", "passive-e2e-1@x")).toHaveLength(1);
    expect(await uidInFolder(c, "ohmail.News", "passive-e2e-1@x")).toHaveLength(0);

    // …and the ordinary arrival beside it went through the pipeline normally, so the cycle above is
    // not passing because nothing happened.
    const [ordinary] = await h.db.select().from(messages)
      .where(byMessageId(h.mailboxId, "passive-e2e-2@x"));
    expect(ordinary).toBeDefined();

    // ── 4. THE CURSOR IS PUBLISHED for the new folder, which is what keeps it read next cycle.
    const folders = await h.db.select().from(mailboxFolders)
      .where(eq(mailboxFolders.mailboxId, h.mailboxId));
    const priv = folders.find((f) => f.folder === "Private");
    expect(priv, "no cursor row for the customer's folder").toBeDefined();
    expect(Number(priv!.uidnext)).toBeGreaterThan(0);

    // ── 5. THE STAMP LANDS. `hasBacklog === false` above is the gate the organizer writes behind.
    await stampInitialImportComplete(h.db, h.mailboxId, new Date());
    const [mb] = await h.db.select().from(mailboxes).where(eq(mailboxes.id, h.mailboxId));
    expect(mb!.initialImportCompletedAt).not.toBeNull();
  }, 60_000);

  it("follows the customer's hand when they file mail away themselves", async () => {
    // The other half, and it needs no passive flag: the adapter pairs the INBOX delete with the
    // create in their folder, and the existing adoption path writes `last_set_by: 'external'`. This
    // is the flow that produced the slice — somebody filing mail in Apple Mail — so it is asserted
    // against a real server rather than inferred from the unit test.
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const deps = { repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };

    const c = await rawClient(h.cfg);
    closers.push(() => c.logout().then(() => undefined));
    await c.mailboxCreate("Archive");
    await h.adapter.ensureFolders(FIXTURE_DOOR);
    await c.append("INBOX", emlOf({ from: "anna@x.example", subject: "file me", messageId: "passive-e2e-3@x" }));

    let hasBacklog = true;
    for (let i = 0; i < 10 && hasBacklog; i++) ({ hasBacklog } = await runSyncCycle(deps));
    const [before] = await h.db.select().from(messages)
      .where(byMessageId(h.mailboxId, "passive-e2e-3@x"));
    expect((before!.nativeLocator as { folder: string }).folder).toBe("INBOX");

    // The customer drags it to their archive in their own mail client.
    const uid = Number((before!.nativeLocator as { ref: string }).ref.split(":")[1]);
    const lock = await c.getMailboxLock("INBOX");
    try {
      await c.messageMove([uid], "Archive", { uid: true }).catch(async () => {
        await c.messageCopy([uid], "Archive", { uid: true });
        await c.messageDelete([uid], { uid: true });
      });
    } finally { lock.release(); }

    hasBacklog = true;
    for (let i = 0; i < 10 && hasBacklog; i++) ({ hasBacklog } = await runSyncCycle(deps));
    await runSyncCycle(deps);   // idempotent: it must not drag the message back

    const rows = await h.db.select().from(messages)
      .where(byMessageId(h.mailboxId, "passive-e2e-3@x"));
    expect(rows, "the move produced a second row").toHaveLength(1);
    expect((rows[0]!.nativeLocator as { folder: string }).folder).toBe("Archive");
    const [fs] = await h.db.select().from(folderState).where(eq(folderState.messageId, rows[0]!.id));
    expect(fs!.desiredFolder).toBe("Archive");
    expect(fs!.lastSetBy).toBe("external");
    // ONE instance, at the place they put it — no phantom locator left behind in the Imbox.
    const inst = await h.db.select().from(messageInstances)
      .where(eq(messageInstances.messageId, rows[0]!.id));
    expect(inst.map((i) => i.folder)).toEqual(["Archive"]);
    // Server truth.
    expect(await uidInFolder(c, "Archive", "passive-e2e-3@x")).toHaveLength(1);
    expect(await uidInFolder(c, "INBOX", "passive-e2e-3@x")).toHaveLength(0);
  }, 60_000);
});
