import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { changeLog, mailboxes, messages } from "@trafficflow/db";
import { isSentFolderOf } from "@trafficflow/core";
import { recordSpecialFolders } from "@trafficflow/core/adapters/drizzle-repo";
import { runMigrations } from "@trafficflow/db/admin";
import { realPgAvailable } from "@trafficflow/db/testing";
import { MessageService, SearchService, type ServiceContext } from "@trafficflow/services";
import { runSyncCycle, type SyncDeps } from "../src/sync.js";
import { makeHarness, rawClient, uidInFolder, DB_URL } from "./_workerenv.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A SENT MESSAGE DELETED BY ANOTHER CLIENT, AGAINST A REAL SERVER.
 *
 * The off-box twin (`sent-expunge.test.ts`) drives the adapter over a recording server; this one
 * expunges over a second IMAP connection, the way another mail app deletes, and reads History,
 * Search and the change log on real Postgres. The INBOX message is the positive control.
 */

const AVAILABLE = await realPgAvailable(DB_URL);

function eml(o: { from: string; to: string; subject: string; messageId: string }): string {
  return [
    `Message-ID: <${o.messageId}>`, `From: ${o.from}`, `To: ${o.to}`, `Subject: ${o.subject}`,
    "Content-Type: text/plain; charset=utf-8", "", "the whole text of the message",
  ].join("\r\n");
}

describe.skipIf(!AVAILABLE)("a message deleted on the server leaves History and Search (GreenMail + real Postgres)", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it("a Sent reply expunged by another client is tombstoned at the next cycle, as the INBOX one is", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const deps: SyncDeps = {
      repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId,
      storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
      role: "organizer", trustedAuthservIds: new Set<string>(),
    };
    const tag = randomUUID().slice(0, 8);
    const sentId = `sent-${tag}@trafficflow.test`;
    const inboxId = `inbox-${tag}@x.example`;
    const c = await rawClient(h.cfg);
    closers.push(async () => { await c.logout().catch(() => undefined); });
    await c.mailboxCreate("Sent").catch(() => undefined);
    await c.append("Sent", eml({ from: h.cfg.auth.user, to: "anna@x.example", subject: `Re: fixture ${tag}`, messageId: sentId }), ["\\Seen"]);
    await c.append("INBOX", eml({ from: "anna@x.example", to: h.cfg.auth.user, subject: `fixture ${tag}`, messageId: inboxId }));

    await runSyncCycle(deps);
    await runSyncCycle(deps);   // the steady state: the Sent watermark is published
    const idOf = async (header: string) => (await h.db.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.mailboxId, h.mailboxId), eq(messages.messageIdHeader, header))))[0]?.id;
    const sent = await idOf(sentId);
    const inbox = await idOf(inboxId);
    expect(sent, "the precondition: the Sent reply was ingested").toBeDefined();
    expect(inbox, "the precondition: the INBOX message was ingested").toBeDefined();
    const ctx: ServiceContext = { db: h.db, accountId: h.accountId, userId: null, now: () => new Date(), requestId: "r" };
    const history = async () => (await new MessageService().list(ctx, { view: "all", limit: 50 })).items.map((m) => m.id);
    const search = async () => (await new SearchService().search(ctx, { q: tag, limit: 50 })).items.map((m) => m.id);
    expect(await history(), "the precondition: History lists both").toEqual(expect.arrayContaining([sent, inbox]));
    expect(await search(), "the precondition: Search finds the reply").toContain(sent);

    for (const [folder, id] of [["Sent", sentId], ["INBOX", inboxId]] as const) {
      const uids = await uidInFolder(c, folder, id);
      expect(uids, `the precondition: ${folder} holds the message`).toHaveLength(1);
      const l = await c.getMailboxLock(folder);
      try { await c.messageDelete(uids, { uid: true }); } finally { l.release(); }
    }
    await runSyncCycle(deps);

    const rows = await h.db.select({ id: messages.id, deletedAt: messages.deletedAt }).from(messages)
      .where(eq(messages.mailboxId, h.mailboxId));
    expect(rows.find((r) => r.id === sent)?.deletedAt, "the deleted Sent reply is still live").not.toBeNull();
    expect(rows.find((r) => r.id === inbox)?.deletedAt, "the deleted INBOX message is still live").not.toBeNull();
    expect(await history(), "History still lists a message the server no longer holds").not.toContain(sent);
    expect(await search(), "Search still finds a message the server no longer holds").not.toContain(sent);
    const deletes = (await h.db.select().from(changeLog).where(eq(changeLog.accountId, h.accountId)))
      .filter((r) => r.entityType === "message" && r.op === "delete").map((r) => r.entityId);
    expect(deletes.sort(), "a mirror is not told").toEqual([sent, inbox].sort());
  });

  /**
   * A MAILBOX WITH NO SENT FOLDER AT CONNECT, AND A LOCALIZED ONE MADE LATER IN ANOTHER APP. No
   * `\Sent` flag on GreenMail, so 'Envoyés' is the folder the app files into by name; one cycle
   * records it, and a letter the person wrote there reads as theirs without connecting again.
   */
  for (const recorded of [null, "Sent Items"] as const) {
    it(recorded === null
      ? "one cycle records an 'Envoyés' made after the attach, and the letter in it is the account's own"
      : "CONTROL: a recorded Sent folder is never overwritten by one made later", async () => {
      const h = await makeHarness();
      closers.push(() => h.adapter.close());
      await recordSpecialFolders(h.adapter, h.repo, h.mailboxId);
      const column = async () => (await h.db.select({ f: mailboxes.sentFolder }).from(mailboxes)
        .where(eq(mailboxes.id, h.mailboxId)))[0]!.f;
      expect(await column(), "the precondition: no Sent folder at connect").toBeNull();
      if (recorded !== null) await h.db.update(mailboxes).set({ sentFolder: recorded }).where(eq(mailboxes.id, h.mailboxId));
      const tag = randomUUID().slice(0, 8);
      const id = `own-${tag}@trafficflow.test`;
      const c = await rawClient(h.cfg);
      closers.push(async () => { await c.logout().catch(() => undefined); });
      await c.mailboxCreate("Envoyés");
      const raw = `Date: Thu, 05 Nov 2026 09:14:00 +0000\r\n${eml({ from: h.cfg.auth.user, to: "anna@x.example", subject: `Re: fixture ${tag}`, messageId: id })}`;
      await c.append("Envoyés", raw, ["\\Seen"], new Date("2026-11-05T09:14:00Z"));

      await runSyncCycle({
        repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId,
        storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE,
        role: "organizer", trustedAuthservIds: new Set<string>(),
      });

      expect(await column()).toBe(recorded ?? "Envoyés");
      const [row] = await h.db.select({ locator: messages.nativeLocator }).from(messages)
        .where(and(eq(messages.mailboxId, h.mailboxId), eq(messages.messageIdHeader, id)));
      const folder = (row?.locator as { folder?: string } | undefined)?.folder;
      expect(folder, "the letter was not ingested from the new folder").toBe("Envoyés");
      expect(isSentFolderOf(folder!, await column()), "the person's own letter reads as received").toBe(recorded === null);
    });
  }
});
