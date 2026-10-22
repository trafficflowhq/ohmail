import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import {
  accounts, changeLog, contacts, mailboxFolders, mailboxes, messageInstances, messages, type Tx,
} from "@trafficflow/db";
import { makeTestDb, serviceUp } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import type { ImapConfig } from "@trafficflow/core/adapters/imap-types";
import { MessageService, SearchService, SyncService, type ServiceContext } from "@trafficflow/services";
import { MemoryMirrorStore } from "@ohmail/client-engine";
import { runSyncCycle } from "../src/sync.js";
import { FIXTURE_DOOR, FIXTURE_LEASE } from "./_door.js";
import { greenmailPorts } from "./_greenmail-ports.js";

/**
 * A LETTER DELETED WHILE THE APP WAS CLOSED LEAVES ON THE FIRST DRAIN AFTER LAUNCH.
 *
 * The real adapter over GreenMail (no CONDSTORE) and Dovecot (CONDSTORE, QRESYNC), the worker's
 * cycle on the store this project runs (PGlite here, the phone's SQLite in `test:sqlite`), as a
 * reader and as an organizer. The letter a person sends to themselves is ONE row with an INBOX and
 * a Sent instance; while Sent was read from its watermark, deleting it kept the Sent instance, the
 * row was promoted onto it and stayed in the list, the thread and search. Mutation: enumerate Sent
 * from the watermark again (`imap.ts`, `enumFloorUid = watermark`) and the self letter stays.
 */

type Role = "organizer" | "reader";
type Server = "greenmail" | "dovecot";

function eml(o: { messageId: string; from: string; to: string; subject: string }): string {
  return [
    `Message-ID: <${o.messageId}>`, `From: ${o.from}`, `To: ${o.to}`, `Subject: ${o.subject}`,
    "Date: Sat, 26 Sep 2026 22:13:00 +0000", "Content-Type: text/plain; charset=utf-8", "", "the letter",
  ].join("\r\n");
}

function configFor(server: Server): ImapConfig {
  const user = `t-${randomUUID()}@trafficflow.test`;
  if (server === "dovecot") {
    return {
      host: process.env.IMAP_CONDSTORE_HOST ?? process.env.IMAP_HOST ?? "127.0.0.1",
      port: Number(process.env.IMAP_CONDSTORE_PORT ?? 3144), secure: false,
      auth: { user, pass: process.env.IMAP_CONDSTORE_PASS ?? "testpass-password" },
    };
  }
  const p = greenmailPorts();
  return { host: p.imapHost, port: p.imapPort, secure: false, auth: { user, pass: "test" } };
}

async function uidOf(c: ImapFlow, path: string, messageId: string): Promise<number> {
  const l = await c.getMailboxLock(path);
  try {
    const r = await c.search({ header: { "message-id": messageId } }, { uid: true });
    return Array.isArray(r) && r.length ? r[0]! : 0;
  } finally { l.release(); }
}

/** Another mail app acts on the mailbox. Each helper asserts the letter was where it acts. */
async function expungeIn(c: ImapFlow, path: string, messageId: string): Promise<void> {
  const uid = await uidOf(c, path, messageId);
  expect(uid, `${messageId} is in ${path} before the delete`).toBeGreaterThan(0);
  const l = await c.getMailboxLock(path);
  try { await c.messageDelete([uid], { uid: true }); } finally { l.release(); }
}
async function moveTo(c: ImapFlow, from: string, to: string, messageId: string): Promise<void> {
  const uid = await uidOf(c, from, messageId);
  expect(uid, `${messageId} is in ${from} before the move`).toBeGreaterThan(0);
  const l = await c.getMailboxLock(from);
  try { await c.messageMove([uid], to, { uid: true }); } finally { l.release(); }
}

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c().catch(() => undefined); });

/** One mailbox, seeded as the finding's: a letter to oneself in INBOX and Sent, and three others. */
async function world(server: Server, role: Role) {
  const cfg = configFor(server);
  const me = cfg.auth.user;
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: false, auth: cfg.auth, logger: false });
  await c.connect();
  closers.push(() => c.logout());
  for (const p of ["Sent", "Trash", "Projects"]) await c.mailboxCreate(p).catch(() => undefined);
  const letter = (messageId: string, subject: string, from = "anna@x.example") =>
    eml({ messageId, from, to: me, subject: `r8 ${subject}` });
  await c.append("INBOX", letter("gone-inbox@x", "deleted in the inbox"));
  await c.append("INBOX", letter("gone-trash@x", "moved to trash and deleted there"));
  await c.append("INBOX", letter("stays@x", "still on the server"));
  await c.append("INBOX", letter("moved@x", "filed in another folder"));
  await c.append("INBOX", letter("self@x", "a letter to myself", me));
  await c.append("Sent", letter("self@x", "a letter to myself", me), ["\\Seen"]);

  const db = (await makeTestDb()) as unknown as Tx;
  const [a] = await db.insert(accounts).values({ name: `deleted-while-closed-${role}` }).returning();
  const accountId = a!.id;
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: me }).returning();
  const mailboxId = mb!.id;
  // A known correspondent, so the organizer leaves anna's letters in INBOX and a delete is a delete.
  await db.insert(contacts).values({ accountId, address: "anna@x.example" });
  const repo = makeDrizzleRepo(db);

  async function launch(): Promise<ImapAdapter> {
    const adapter = new ImapAdapter(cfg);
    await adapter.connect();
    closers.push(() => adapter.close());
    if (role === "organizer") await adapter.ensureFolders(FIXTURE_DOOR);
    return adapter;
  }
  /** One drain: cycles until the cycle owes nothing, bounded. */
  async function drain(adapter: ImapAdapter): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const out = await runSyncCycle({
        repo, adapter, accountId, mailboxId, role,
        writeAuthority: role === "reader" ? { noLease: "reader" as const } : FIXTURE_LEASE,
        storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(),
      });
      if (!out.hasBacklog && !out.owesFiling) return;
    }
    throw new Error("the drain did not settle in ten cycles");
  }
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => new Date(), requestId: "r8" };
  const rowOf = async (header: string) => (await db.select({
    id: messages.id, deletedAt: messages.deletedAt, threadId: messages.threadId, locator: messages.nativeLocator,
  }).from(messages).where(and(eq(messages.mailboxId, mailboxId), eq(messages.messageIdHeader, header))))[0];
  const listed = async () => (await new MessageService().list(ctx, { view: "all", limit: 50 })).items.map((m) => m.id);
  const found = async () => (await new SearchService().search(ctx, { q: "r8", limit: 50 })).items.map((m) => m.id);
  /** A client mirror fed from `/sync`, as the desktop window and the phone read it. */
  const mirror = new MemoryMirrorStore();
  await mirror.load();
  let since: string | undefined;
  const pull = async (): Promise<void> => {
    for (;;) {
      const resp = await new SyncService().getChanges(ctx, since === undefined ? {} : { since });
      await mirror.applyResponse(resp);
      since = resp.cursor;
      if (!resp.hasMore) return;
    }
  };
  return { cfg, c, db, accountId, mailboxId, ctx, launch, drain, rowOf, listed, found, mirror, pull };
}

/** The run's one probe (test/setup/services.global.ts); a server that does not answer skips its cases BY NAME. */
const absent: Record<Server, string> = { greenmail: "", dovecot: "" };
const at = (server: Server): string => `${configFor(server).host}:${configFor(server).port}`;
for (const [server, s] of [["greenmail", serviceUp("greenmail", at("greenmail"))], ["dovecot", serviceUp("dovecot", at("dovecot"))]] as const) {
  if (!s.up) absent[server] = ` (SKIPPED: ${s.why})`;
}

describe("a letter deleted while the app was closed", () => {
  for (const server of ["greenmail", "dovecot"] as const) for (const role of ["reader", "organizer"] as const) {
    it.skipIf(absent[server] !== "")(`${server}, ${role}: gone from the list, the thread and search on the first drain after launch${absent[server]}`, async () => {
      const w = await world(server, role);
      const first = await w.launch();
      await w.drain(first);
      await w.drain(first);
      const self = (await w.rowOf("self@x"))!;
      const gone = ["gone-inbox@x", "gone-trash@x", "self@x"];
      const ids = Object.fromEntries(await Promise.all(
        [...gone, "stays@x", "moved@x"].map(async (h) => [h, (await w.rowOf(h))!.id] as const)));
      // The finding's shape: ONE row for the letter to oneself, held in INBOX and in Sent.
      const selfFolders = (await w.db.select({ f: messageInstances.folder }).from(messageInstances)
        .where(eq(messageInstances.messageId, self.id))).map((r) => r.f).sort();
      expect(selfFolders).toEqual(["INBOX", "Sent"]);
      expect(await w.found()).toEqual(expect.arrayContaining(Object.values(ids)));
      await w.pull();
      expect(w.mirror.get("message", self.id), "the precondition: the mirror holds the letter").toBeDefined();
      await first.close();

      await expungeIn(w.c, "INBOX", "gone-inbox@x");
      await moveTo(w.c, "INBOX", "Trash", "gone-trash@x");
      await expungeIn(w.c, "Trash", "gone-trash@x");
      await expungeIn(w.c, "INBOX", "self@x");
      await expungeIn(w.c, "Sent", "self@x");
      await moveTo(w.c, "INBOX", "Projects", "moved@x");

      const second = await w.launch();
      await w.drain(second);
      await w.pull();

      for (const h of gone) {
        expect((await w.rowOf(h))!.deletedAt, `${h} is still live in the store`).not.toBeNull();
        expect(await w.listed(), `${h} is still listed`).not.toContain(ids[h]);
        expect(await w.found(), `${h} is still found`).not.toContain(ids[h]);
        expect(w.mirror.get("message", ids[h]!), `${h} is still in the mirror`).toBeUndefined();
      }
      // The conversation as the client builds it: the mirror's messages under the letter's thread.
      const members = w.mirror.list<{ id: string; threadId: string | null }>("message")
        .filter((m) => m.threadId === self.threadId).map((m) => m.id);
      expect(members, "the conversation still shows the deleted letter").not.toContain(self.id);
      // Controls: a letter still on the server stays; a letter filed elsewhere is moved, not deleted.
      expect((await w.rowOf("stays@x"))!.deletedAt).toBeNull();
      const moved = (await w.rowOf("moved@x"))!;
      expect(moved.deletedAt, "a letter filed in another folder was deleted").toBeNull();
      expect((moved.locator as { folder: string }).folder).toBe("Projects");
      expect(await w.found()).toEqual(expect.arrayContaining([ids["stays@x"], ids["moved@x"]]));
      expect(w.mirror.get("message", ids["moved@x"]!), "the mirror dropped a letter that was moved").toBeDefined();
      const tombstoned = (await w.db.select({ id: changeLog.entityId, op: changeLog.op, type: changeLog.entityType })
        .from(changeLog).where(eq(changeLog.accountId, w.accountId)))
        .filter((r) => r.type === "message" && r.op === "delete").map((r) => r.id);
      expect(tombstoned, "the moved letter was deleted and brought back").not.toContain(ids["moved@x"]);
      expect(tombstoned.sort()).toEqual(gone.map((h) => ids[h]!).sort());
    }, 90_000);

    it.skipIf(absent[server] !== "")(`${server}, ${role}: a store an older build left behind heals on the first drain${absent[server]}`, async () => {
      // The kept profile the finding was read on: 0.25.2 observed the INBOX delete, forgot that
      // instance and promoted the Sent twin, which it never asked about again. That is exactly
      // `forgetInstanceAt` on the INBOX locator, so the state is made by the repo's own door.
      const w = await world(server, role);
      const first = await w.launch();
      await w.drain(first);
      await w.drain(first);
      await first.close();
      const self = (await w.rowOf("self@x"))!;
      const [inbox] = await w.db.select({ v: messageInstances.uidvalidity, u: messageInstances.uid }).from(messageInstances)
        .where(and(eq(messageInstances.messageId, self.id), eq(messageInstances.folder, "INBOX")));
      await expungeIn(w.c, "INBOX", "self@x");
      await expungeIn(w.c, "Sent", "self@x");
      const promoted = await makeDrizzleRepo(w.db).forgetInstanceAt(w.mailboxId, { folder: "INBOX", ref: `${inbox!.v}:${inbox!.u}` });
      expect(promoted?.folder, "the precondition: the row was promoted onto its Sent twin").toBe("Sent");
      expect(await w.listed()).toContain(self.id);

      const second = await w.launch();
      await w.drain(second);

      expect((await w.rowOf("self@x"))!.deletedAt, "the letter an older build kept is still live").not.toBeNull();
      expect(await w.found()).not.toContain(self.id);
      expect((await w.rowOf("stays@x"))!.deletedAt).toBeNull();
    }, 90_000);

    it.skipIf(absent[server] !== "")(`${server}, ${role}: a UIDVALIDITY change is a re-read, not a wipe${absent[server]}`, async () => {
      const w = await world(server, role);
      const first = await w.launch();
      await w.drain(first);
      await first.close();
      // The store believes INBOX one epoch behind the server: what a server-side reset leaves.
      const [row] = await w.db.select({ v: mailboxFolders.uidvalidity }).from(mailboxFolders)
        .where(and(eq(mailboxFolders.mailboxId, w.mailboxId), eq(mailboxFolders.folder, "INBOX")));
      const live = row!.v!;
      const behind = live - 1n;
      await w.db.update(mailboxFolders).set({ uidvalidity: behind })
        .where(and(eq(mailboxFolders.mailboxId, w.mailboxId), eq(mailboxFolders.folder, "INBOX")));
      const inInbox = await w.db.select({ id: messageInstances.id, mid: messageInstances.messageId, uid: messageInstances.uid })
        .from(messageInstances).where(and(eq(messageInstances.mailboxId, w.mailboxId), eq(messageInstances.folder, "INBOX")));
      for (const i of inInbox) {
        await w.db.update(messageInstances).set({ uidvalidity: behind }).where(eq(messageInstances.id, i.id));
        const [m] = await w.db.select({ loc: messages.nativeLocator }).from(messages).where(eq(messages.id, i.mid));
        const loc = m!.loc as { folder: string; ref: string };
        if (loc.folder === "INBOX") {
          await w.db.update(messages).set({ nativeLocator: { folder: "INBOX", ref: `${behind}:${i.uid}` } })
            .where(eq(messages.id, i.mid));
        }
      }
      const before = await w.listed();

      const second = await w.launch();
      await w.drain(second);

      expect((await w.listed()).sort(), "the reset wiped the list").toEqual(before.sort());
      const deletes = (await w.db.select({ op: changeLog.op, type: changeLog.entityType }).from(changeLog)
        .where(eq(changeLog.accountId, w.accountId))).filter((r) => r.type === "message" && r.op === "delete");
      expect(deletes, "the reset was read as every letter deleted").toEqual([]);
      const stale = await w.db.select({ id: messages.id }).from(messages).where(and(
        eq(messages.mailboxId, w.mailboxId), isNull(messages.deletedAt)));
      expect(stale.length).toBe(before.length);
      const epochs = (await w.db.select({ v: messageInstances.uidvalidity }).from(messageInstances)
        .where(and(eq(messageInstances.mailboxId, w.mailboxId), eq(messageInstances.folder, "INBOX")))).map((r) => r.v);
      expect(new Set(epochs), "the INBOX locators were not re-learned at the server's epoch").toEqual(new Set([live]));
    }, 90_000);
  }
});
