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
import { MessageService, SearchService, SyncService, ThreadService, type ServiceContext } from "@trafficflow/services";
import { MemoryMirrorStore, threadSizeIndex } from "@ohmail/client-engine";
import { runSyncCycle } from "../src/sync.js";
import { FIXTURE_DOOR, FIXTURE_LEASE } from "./_door.js";
import { greenmailPorts } from "./_greenmail-ports.js";

/**
 * A FOLDER OF THE PERSON'S OWN, DELETED IN ANOTHER MAIL APP WHILE THE APP WAS CLOSED, LEAVES WITH
 * ITS LETTERS on the first drain after launch. The real adapter over GreenMail and Dovecot, the
 * worker's cycle on this project's store (PGlite; the phone's SQLite in `test:sqlite`), reader and
 * organizer. The folder drops out of LIST; the adapter asks it by name and reaps only on the
 * server's "does not exist". Controls: a rename moves, a LIST that omits a folder STATUS finds
 * keeps it, a STATUS that never answers keeps it, a folder the rule excludes is never asked.
 */

type Role = "organizer" | "reader";
type Server = "greenmail" | "dovecot";

function eml(o: { messageId: string; from: string; to: string; subject: string; inReplyTo?: string }): string {
  return [
    `Message-ID: <${o.messageId}>`, `From: ${o.from}`, `To: ${o.to}`, `Subject: ${o.subject}`,
    ...(o.inReplyTo ? [`In-Reply-To: <${o.inReplyTo}>`, `References: <${o.inReplyTo}>`] : []),
    "Date: Sun, 27 Sep 2026 04:30:00 +0000", "Content-Type: text/plain; charset=utf-8", "", "the letter",
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

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const c of closers.splice(0)) await c().catch(() => undefined); });

/** How the next launch's client is bent, for the controls. Absent: the adapter dials itself. */
interface Bend { omitFromList?: string; noselectInList?: string; statusHangs?: true }

async function world(server: Server, role: Role) {
  const cfg = configFor(server);
  const me = cfg.auth.user;
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: false, auth: cfg.auth, logger: false });
  await c.connect();
  closers.push(() => c.logout());
  for (const p of ["Sent", "Trash", "Projects"]) await c.mailboxCreate(p).catch(() => undefined);
  const letter = (messageId: string, subject: string, inReplyTo?: string) =>
    eml({ messageId, from: "anna@x.example", to: me, subject: `r9 ${subject}`, ...(inReplyTo ? { inReplyTo } : {}) });
  await c.append("INBOX", letter("stays@x", "still on the server"));
  await c.append("INBOX", letter("root@x", "the plan"));
  await c.append("INBOX", letter("both@x", "held in two folders"));
  await c.append("INBOX", letter("meanwhile@x", "deleted while the epoch moved"));
  await c.append("Projects", letter("filed@x", "filed away"));
  await c.append("Projects", letter("reply@x", "Re: the plan", "root@x"));
  await c.append("Projects", letter("both@x", "held in two folders"));

  const db = (await makeTestDb()) as unknown as Tx;
  const [a] = await db.insert(accounts).values({ name: `folder-deleted-elsewhere-${role}` }).returning();
  const accountId = a!.id;
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: me }).returning();
  const mailboxId = mb!.id;
  // A known correspondent, so the organizer leaves anna's letters where they are.
  await db.insert(contacts).values({ accountId, address: "anna@x.example" });
  const repo = makeDrizzleRepo(db);

  let now = Date.now();
  const statusAsked: string[] = [];
  async function launch(bend: Bend = {}): Promise<ImapAdapter> {
    let adapter: ImapAdapter;
    if (Object.keys(bend).length === 0) {
      adapter = new ImapAdapter(cfg);
    } else {
      const client = new ImapFlow({ host: cfg.host, port: cfg.port, secure: false, auth: cfg.auth, logger: false });
      await client.connect();
      const list = client.list.bind(client);
      // `noselectInList`: the folder is gone from the server and this LIST still names it, as a
      // node nothing selects — the exclusion rule's class.
      client.list = (async (o?: Parameters<ImapFlow["list"]>[0]) => {
        const rows = (await list(o)).filter((f) => f.path !== bend.omitFromList && f.path !== bend.noselectInList);
        if (bend.noselectInList) {
          rows.push({ ...rows[0]!, path: bend.noselectInList, name: bend.noselectInList, flags: new Set(["\\Noselect"]), specialUse: undefined } as never);
        }
        return rows;
      }) as ImapFlow["list"];
      const status = client.status.bind(client);
      client.status = (async (path: string, q: Parameters<ImapFlow["status"]>[1]) => {
        if (path === "Projects") statusAsked.push(path);
        if (bend.statusHangs) { now += 10 * 60_000; return new Promise(() => undefined); }
        return status(path, q);
      }) as ImapFlow["status"];
      adapter = new ImapAdapter(cfg, { client, nowMs: () => now });
    }
    await adapter.connect();
    closers.push(() => adapter.close());
    if (role === "organizer") await adapter.ensureFolders(FIXTURE_DOOR);
    return adapter;
  }
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
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => new Date(), requestId: "r9" };
  const rowOf = async (header: string) => (await db.select({
    id: messages.id, deletedAt: messages.deletedAt, threadId: messages.threadId, locator: messages.nativeLocator,
  }).from(messages).where(and(eq(messages.mailboxId, mailboxId), eq(messages.messageIdHeader, header))))[0]!;
  const listed = async () => (await new MessageService().list(ctx, { view: "all", limit: 50 })).items.map((m) => m.id);
  const found = async () => (await new SearchService().search(ctx, { q: "r9", limit: 50 })).items.map((m) => m.id);
  const deletesLogged = async () => (await db.select({ id: changeLog.entityId, op: changeLog.op, type: changeLog.entityType })
    .from(changeLog).where(eq(changeLog.accountId, accountId)))
    .filter((r) => r.type === "message" && r.op === "delete").map((r) => r.id).sort();
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
  /** The conversation's size two ways: the service's thread, and the badge a synced client draws. */
  const conversation = async (threadId: string) => ({
    service: (await new ThreadService().get(ctx, threadId)).messageIds.length,
    client: threadSizeIndex(mirror).get(threadId)?.count ?? 0,
  });
  /** First launch, drained twice, pulled into the mirror, closed: the state before the other app acts. */
  async function settled(): Promise<Record<string, string>> {
    const first = await launch();
    await drain(first);
    await drain(first);
    await pull();
    await first.close();
    const ids: Record<string, string> = {};
    for (const h of ["stays@x", "root@x", "both@x", "meanwhile@x", "filed@x", "reply@x"]) ids[h] = (await rowOf(h)).id;
    expect(await found(), "the precondition: search finds every letter").toEqual(expect.arrayContaining(Object.values(ids)));
    return ids;
  }
  /** Another mail app, on a connection of its own. */
  async function elsewhere(act: (other: ImapFlow) => Promise<unknown>): Promise<void> {
    const other = new ImapFlow({ host: cfg.host, port: cfg.port, secure: false, auth: cfg.auth, logger: false });
    await other.connect();
    try { await act(other); } finally { await other.logout().catch(() => undefined); }
  }
  return { cfg, c, db, accountId, mailboxId, launch, drain, rowOf, listed, found, deletesLogged, pull, mirror, conversation, settled, statusAsked, elsewhere };
}

const absent: Record<Server, string> = { greenmail: "", dovecot: "" };
const at = (server: Server): string => `${configFor(server).host}:${configFor(server).port}`;
for (const [server, s] of [["greenmail", serviceUp("greenmail", at("greenmail"))], ["dovecot", serviceUp("dovecot", at("dovecot"))]] as const) {
  if (!s.up) absent[server] = ` (SKIPPED: ${s.why})`;
}

describe("a folder deleted in another mail app while the app was closed", () => {
  for (const server of ["greenmail", "dovecot"] as const) for (const role of ["reader", "organizer"] as const) {
    const skip = absent[server] !== "";
    const at = `${server}, ${role}`;
    // Measured 2026-09-27: once a session has read a folder and logged out, GreenMail ends the
    // connection that DELETEs it and keeps the folder. So a delete while the app was closed is
    // modelled on Dovecot alone; the rename and the reset run on both.
    const noDelete = server === "greenmail"
      ? " (SKIPPED: GreenMail ends the connection that deletes a folder a closed session read)" : "";

    it.skipIf(skip || noDelete !== "")(`${at}: its letters leave the list, search, the mirror and the conversation count${absent[server] || noDelete}`, async () => {
      const w = await world(server, role);
      const ids = await w.settled();
      const root = await w.rowOf("root@x");
      expect((await w.rowOf("reply@x")).threadId, "the precondition: the reply joined the conversation").toBe(root.threadId);
      expect(await w.conversation(root.threadId!)).toEqual({ service: 2, client: 2 });

      await w.elsewhere((o) => o.mailboxDelete("Projects"));

      const second = await w.launch();
      await w.drain(second);
      await w.pull();
      for (const h of ["filed@x", "reply@x"]) {
        expect((await w.rowOf(h)).deletedAt, `${h} is still live in the store`).not.toBeNull();
        expect(await w.listed(), `${h} is still listed`).not.toContain(ids[h]);
        expect(await w.found(), `${h} is still found`).not.toContain(ids[h]);
        expect(w.mirror.get("message", ids[h]!), `${h} is still in the mirror`).toBeUndefined();
      }
      expect(await w.conversation(root.threadId!), "the conversation still counts the deleted reply").toEqual({ service: 1, client: 1 });
      // A letter the server still holds in INBOX stays, though its other copy went with the folder.
      const both = await w.rowOf("both@x");
      expect(both.deletedAt, "a letter still in INBOX was taken with the folder").toBeNull();
      expect((both.locator as { folder: string }).folder).toBe("INBOX");
      expect(await w.deletesLogged()).toEqual([ids["filed@x"], ids["reply@x"]].sort());
      const live = await w.db.select({ h: messages.messageIdHeader }).from(messages)
        .where(and(eq(messages.mailboxId, w.mailboxId), isNull(messages.deletedAt)));
      expect(live.map((r) => r.h).sort()).toEqual(["both@x", "meanwhile@x", "root@x", "stays@x"]);
    }, 120_000);

    it.skipIf(skip)(`${at}: renamed elsewhere, its letters move with it${absent[server]}`, async () => {
      const w = await world(server, role);
      const ids = await w.settled();
      await w.elsewhere((o) => o.mailboxRename("Projects", "Work"));

      const second = await w.launch();
      await w.drain(second);
      for (const h of ["filed@x", "reply@x"]) {
        const row = await w.rowOf(h);
        expect(row.deletedAt, `${h} was taken by a rename`).toBeNull();
        expect(row.id, `${h} was deleted and brought back as another row`).toBe(ids[h]);
        expect((row.locator as { folder: string }).folder).toBe("Work");
      }
      expect(await w.deletesLogged(), "a renamed folder's letters were deleted and brought back").toEqual([]);
    }, 120_000);

    it.skipIf(skip || noDelete !== "")(`${at}: a folder the exclusion rule skips is never asked, and keeps its letters${absent[server] || noDelete}`, async () => {
      const w = await world(server, role);
      const ids = await w.settled();
      await w.elsewhere((o) => o.mailboxDelete("Projects"));

      const second = await w.launch({ noselectInList: "Projects" });
      await w.drain(second);
      expect(w.statusAsked, "a folder the rule excludes was asked").toEqual([]);
      expect((await w.rowOf("filed@x")).deletedAt).toBeNull();
      expect(await w.found()).toEqual(expect.arrayContaining([ids["filed@x"], ids["reply@x"]]));
    }, 120_000);

    it.skipIf(skip)(`${at}: a LIST that omits a folder STATUS then finds keeps its letters${absent[server]}`, async () => {
      const w = await world(server, role);
      const ids = await w.settled();

      const second = await w.launch({ omitFromList: "Projects" });
      await w.drain(second);
      expect(w.statusAsked).toEqual(["Projects"]);
      expect((await w.rowOf("filed@x")).deletedAt, "a folder the server still holds was reaped").toBeNull();
      expect(await w.deletesLogged()).toEqual([]);
      expect(await w.found()).toEqual(expect.arrayContaining([ids["filed@x"], ids["reply@x"]]));
    }, 120_000);

    it.skipIf(skip || noDelete !== "")(`${at}: a STATUS that never answers keeps the folder's letters${absent[server] || noDelete}`, async () => {
      const w = await world(server, role);
      const ids = await w.settled();
      await w.elsewhere((o) => o.mailboxDelete("Projects"));

      const second = await w.launch({ statusHangs: true });
      await expect(w.drain(second)).rejects.toThrow(/cycle_deadline/);
      expect(w.statusAsked).toEqual(["Projects"]);
      expect((await w.rowOf("filed@x")).deletedAt, "an unanswered STATUS reaped the folder").toBeNull();
      expect(await w.deletesLogged()).toEqual([]);
      expect(await w.found()).toEqual(expect.arrayContaining([ids["filed@x"], ids["reply@x"]]));
    }, 120_000);

    it.skipIf(skip)(`${at}: a UIDVALIDITY reset keeps no letter deleted meanwhile${absent[server]}`, async () => {
      const w = await world(server, role);
      const ids = await w.settled();
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
        if ((m!.loc as { folder: string }).folder === "INBOX") {
          await w.db.update(messages).set({ nativeLocator: { folder: "INBOX", ref: `${behind}:${i.uid}` } }).where(eq(messages.id, i.mid));
        }
      }
      const uid = await uidOf(w.c, "INBOX", "meanwhile@x");
      expect(uid, "meanwhile@x is in INBOX before the delete").toBeGreaterThan(0);
      const l = await w.c.getMailboxLock("INBOX");
      try { await w.c.messageDelete([uid], { uid: true }); } finally { l.release(); }

      const second = await w.launch();
      await w.drain(second);
      expect((await w.rowOf("meanwhile@x")).deletedAt, "the letter deleted meanwhile is still live").not.toBeNull();
      expect(await w.found()).not.toContain(ids["meanwhile@x"]);
      expect(await w.deletesLogged(), "the reset was read as other letters deleted").toEqual([ids["meanwhile@x"]]);
      for (const h of ["stays@x", "root@x", "both@x"]) expect((await w.rowOf(h)).deletedAt, `${h} was taken by the reset`).toBeNull();
      const epochs = (await w.db.select({ v: messageInstances.uidvalidity }).from(messageInstances)
        .where(and(eq(messageInstances.mailboxId, w.mailboxId), eq(messageInstances.folder, "INBOX")))).map((r) => r.v);
      expect(new Set(epochs), "an INBOX locator was left at the old epoch").toEqual(new Set([live]));
    }, 120_000);
  }
});
