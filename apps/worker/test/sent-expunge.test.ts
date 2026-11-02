import { searchIndexBackfillPass, UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import {
  accounts, changeLog, mailboxes, messageBodies, messages, messageSearch, routingDecisions, trackerEvents, type Tx,
} from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { MessageService, SearchService, SyncService, type ServiceContext } from "@trafficflow/services";
import { MemoryMirrorStore } from "@ohmail/client-engine";
import { runSyncCycle } from "../src/sync.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A SENT MESSAGE DELETED IN ANOTHER MAIL APP LEAVES OHMAIL.
 *
 * The real adapter over a recording server, the worker's own cycle, the real repo on this store,
 * and the three surfaces a person reads: History, Search and a client mirror fed from `/sync`.
 * Sent was read from its UID watermark, so an ingested Sent message was never asked about again
 * and its deletion was silence. The INBOX message is the positive control: that path always
 * worked. Mutation: enumerate Sent from the watermark again and the Sent half goes red.
 */

interface Stored { uid: number; raw: Buffer; messageId: string }

/** A server with an INBOX and a name-matched Sent folder whose messages another client can delete. */
type Seeded = { uid: number; messageId: string; subject: string; from: string };

function server(seed: Record<"INBOX" | "Sent", Seeded[]>) {
  const folders = new Map<string, Stored[]>();
  const stored = (m: Seeded): Stored => ({
    uid: m.uid, messageId: m.messageId,
    raw: Buffer.from([
      `Message-ID: <${m.messageId}>`, `From: ${m.from}`, "To: someone@example.test",
      `Subject: ${m.subject}`, "Date: Fri, 25 Sep 2026 07:46:00 +0000",
      "Content-Type: text/plain; charset=utf-8", "", "the whole text of the message",
    ].join("\r\n")),
  });
  for (const [path, list] of Object.entries(seed)) folders.set(path, list.map(stored));
  const uidsOf = (path: string) => (folders.get(path) ?? []).map((m) => m.uid);
  const box = (path: string) => {
    const uids = uidsOf(path);
    return { path, uidValidity: 100n, uidNext: uids.length ? Math.max(...uids) + 1 : 1, highestModseq: 0n, exists: uids.length };
  };
  const client = {
    capabilities: new Map<string, boolean>([["MOVE", true], ["UIDPLUS", true], ["IDLE", true]]),
    mailbox: box("INBOX") as ReturnType<typeof box>,
    _path: "INBOX",
    async list() {
      return ["INBOX", "Sent"].map((path) => ({ path, name: path, delimiter: "/", flags: new Set<string>() }));
    },
    async getMailboxLock(path: string) {
      this._path = path;
      this.mailbox = box(path);
      return { path, release() {} };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *fetch(range: any, query: any, options: any) {
      const list = folders.get(this._path) ?? [];
      if (list.length === 0) return;
      if (query?.source || query?.size) {
        for (const uid of range as number[]) {
          const m = list.find((x) => x.uid === uid);
          if (!m) continue;
          yield query.source
            ? { uid, flags: new Set<string>(), envelope: { messageId: `<${m.messageId}>` }, source: m.raw, internalDate: new Date("2026-09-25T07:46:00Z") }
            : { uid, size: m.raw.length };
        }
        return;
      }
      const uids = list.map((m) => m.uid);
      const start = Number(String(range).split(":")[0]);
      const selected = options?.uid
        ? (uids.some((u) => u >= start) ? uids.filter((u) => u >= start) : [Math.max(...uids)])
        : uids.slice(Math.max(0, start - 1));
      for (const uid of selected) yield { uid };
    },
  };
  /** Another mail app deletes a message: the UID is gone from the folder. */
  const expunge = (path: string, uid: number) => {
    folders.set(path, (folders.get(path) ?? []).filter((m) => m.uid !== uid));
  };
  /** Another mail app puts a letter back: the same bytes under a new UID. */
  const append = (path: string, m: Seeded) => { folders.set(path, [...(folders.get(path) ?? []), stored(m)]); };
  return { client, expunge, append };
}

async function world() {
  const db = (await makeTestDb()) as unknown as Tx;
  const [a] = await db.insert(accounts).values({ name: "sent-expunge" }).returning();
  const accountId = a!.id;
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: "me@example.test" }).returning();
  const imap = server({
    INBOX: [{ uid: 10, messageId: "inbox-1@example.test", subject: "ohmail-fixture question", from: "anna@example.test" }],
    Sent: [{ uid: 40, messageId: "sent-1@example.test", subject: "Re: ohmail-fixture question", from: "me@example.test" }],
  });
  const adapter = new ImapAdapter(
    { host: "x", port: 0, secure: false, auth: { user: "me@example.test", pass: "p" } }, { client: imap.client },
  );
  await adapter.connect();
  const cycle = () => runSyncCycle({
    writeAuthority: FIXTURE_LEASE, repo: makeDrizzleRepo(db), adapter, role: "organizer",
    accountId, mailboxId: mb!.id, storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(),
  });
  const ctx: ServiceContext = { db: db as never, accountId, userId: null, now: () => new Date(), requestId: "sent-expunge" };
  return { db, accountId, imap, cycle, ctx };
}

const idOf = async (db: Tx, header: string): Promise<string> =>
  (await db.select({ id: messages.id }).from(messages).where(eq(messages.messageIdHeader, header)))[0]!.id;

async function drain(store: MemoryMirrorStore, ctx: ServiceContext, since?: string): Promise<string> {
  const sync = new SyncService();
  let cursor = since;
  for (;;) {
    const resp = await sync.getChanges(ctx, cursor === undefined ? {} : { since: cursor });
    await store.applyResponse(resp);
    cursor = resp.cursor;
    if (!resp.hasMore) return cursor;
  }
}

describe("a message deleted on the mail server leaves History, Search and the mirror", () => {
  it("the Sent reply goes as the INBOX message does, within one cycle", async () => {
    const w = await world();
    await w.cycle();
    await w.cycle();   // the steady state: the Sent watermark is published
    const sent = await idOf(w.db, "sent-1@example.test");
    const inbox = await idOf(w.db, "inbox-1@example.test");
    const history = async () =>
      (await new MessageService().list(w.ctx, { view: "all", limit: 50 })).items.map((m) => m.id);
    const search = async () =>
      (await new SearchService().search(w.ctx, { q: "fixture", limit: 50 })).items.map((m) => m.id);
    expect(await history(), "the precondition: History lists both").toEqual(expect.arrayContaining([sent, inbox]));
    expect(await search(), "the precondition: Search finds both").toEqual(expect.arrayContaining([sent, inbox]));
    const store = new MemoryMirrorStore();
    await store.load();
    const cursor = await drain(store, w.ctx);
    expect(store.get("message", sent), "the precondition: the mirror holds the reply").toBeDefined();

    w.imap.expunge("Sent", 40);
    w.imap.expunge("INBOX", 10);
    await w.cycle();
    await drain(store, w.ctx, cursor);

    expect(await history(), "History still lists the deleted Sent reply").not.toContain(sent);
    expect(await search(), "Search still finds the deleted Sent reply").not.toContain(sent);
    expect(store.get("message", sent), "the mirror still holds the deleted Sent reply").toBeUndefined();
    // POSITIVE CONTROL — the path that always worked.
    expect(await history(), "History still lists the deleted INBOX message").not.toContain(inbox);
    expect(store.get("message", inbox), "the mirror still holds the deleted INBOX message").toBeUndefined();
    const deletes = (await w.db.select().from(changeLog).where(eq(changeLog.accountId, w.accountId)))
      .filter((r) => r.entityType === "message" && r.op === "delete").map((r) => r.entityId);
    expect(deletes.sort()).toEqual([sent, inbox].sort());
  });

  it("the deleted row keeps who, when and what about, not its preview or words; its return brings them back", async () => {
    const w = await world();
    await w.cycle();
    await w.cycle();
    const inbox = await idOf(w.db, "inbox-1@example.test");
    // The header block stays with the identity: it is written once, at ingest.
    const identity = async () => ({
      ...(await w.db.select({
        dedupKey: messages.dedupKey, header: messages.messageIdHeader, from: messages.fromAddress,
        subject: messages.subject, date: messages.date, bodyHash: messages.bodyHash,
      }).from(messages).where(eq(messages.id, inbox)))[0],
      headers: (await w.db.select({ h: messageBodies.headers }).from(messageBodies).where(eq(messageBodies.messageId, inbox)))[0]!.h,
    });
    // What was drawn from its words: the classifier's summary, a tracker's address.
    await w.db.insert(routingDecisions).values({
      accountId: w.accountId, messageId: inbox, inputProvenance: "ai", destination: "INBOX", status: "auto_applied",
      rationale: "Anna asks about the fixture",
    });
    await w.db.insert(trackerEvents).values({
      accountId: w.accountId, messageId: inbox, kind: "pixel", trackerHost: "t.example.test", url: "https://t.example.test/o?r=anna",
    });
    const kept = async () => ({
      snippet: (await w.db.select({ s: messages.snippet }).from(messages).where(eq(messages.id, inbox)))[0]!.s,
      documents: (await w.db.select({ id: messageSearch.messageId }).from(messageSearch).where(eq(messageSearch.messageId, inbox))).length,
      drawn: [
        ...(await w.db.select({ v: routingDecisions.rationale }).from(routingDecisions).where(eq(routingDecisions.messageId, inbox))),
        ...(await w.db.select({ v: trackerEvents.url }).from(trackerEvents).where(eq(trackerEvents.messageId, inbox))),
      ].flatMap((r) => (r.v === null ? [] : [r.v])),
    });
    const found = async () => (await new SearchService().search(w.ctx, { q: "whole", limit: 50 })).items.map((m) => m.id);
    const before = await identity();
    expect(Object.keys(before.headers as object), "the precondition: a header block").not.toEqual([]);
    expect(await kept(), "the precondition: a preview and a search document").toEqual({
      snippet: "the whole text of the message", documents: 1, drawn: ["Anna asks about the fixture", "https://t.example.test/o?r=anna"],
    });

    w.imap.expunge("INBOX", 10);
    await w.cycle();
    expect(await identity(), "the deleted row lost what identifies it").toEqual(before);
    expect(await kept(), "a letter gone from the server kept its preview or words").toEqual({ snippet: "", documents: 0, drawn: [] });
    await searchIndexBackfillPass({ db: w.db, accountId: w.accountId });
    expect((await kept()).documents, "the backfill wrote a gone letter's words back").toBe(0);

    w.imap.append("INBOX", { uid: 11, messageId: "inbox-1@example.test", subject: "ohmail-fixture question", from: "anna@example.test" });
    await w.cycle();
    expect(await kept(), "the returned letter has no preview or words")
      .toEqual({ snippet: "the whole text of the message", documents: 1, drawn: [] });
    expect(await found(), "search does not find the returned letter by its words").toContain(inbox);
  });

  it("a Sent reply the server still holds stays — the scan below the watermark is no delete of its own", async () => {
    const w = await world();
    await w.cycle();
    await w.cycle();
    const sent = await idOf(w.db, "sent-1@example.test");
    await w.cycle();
    const [row] = await w.db.select({ deletedAt: messages.deletedAt }).from(messages).where(eq(messages.id, sent));
    expect(row!.deletedAt, "a Sent reply still on the server was tombstoned").toBeNull();
  });
});
