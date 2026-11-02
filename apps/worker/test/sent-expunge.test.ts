import { reindexMessageSearch, searchIndexBackfillPass, UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  accounts, autoReplyByUsWhere, changeLog, folderState, mailboxes, messageBodies, messageInstances, messages, messageSearch,
  routingDecisions, trackerEvents, weAnsweredThisSenderWhere, type Tx,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { MessageService, SearchService, SyncService, buildSeedReview, type ServiceContext } from "@trafficflow/services";
import { MemoryMirrorStore } from "@ohmail/client-engine";
import { runSyncCycle } from "../src/sync.js";
import { goneLetterTidyPass } from "../src/gone-letter-tidy.js";
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
type Seeded = { uid: number; messageId: string; subject: string; from: string; to?: string; extra?: string[] };

function server(seed: Record<"INBOX" | "Sent", Seeded[]>) {
  const folders = new Map<string, Stored[]>();
  const stored = (m: Seeded): Stored => ({
    uid: m.uid, messageId: m.messageId,
    raw: Buffer.from([
      `Message-ID: <${m.messageId}>`, `From: ${m.from}`, `To: ${m.to ?? "someone@example.test"}`,
      `Subject: ${m.subject}`, "Date: Fri, 25 Sep 2026 07:46:00 +0000", ...(m.extra ?? []),
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

async function world(seed: Record<"INBOX" | "Sent", Seeded[]> = {
  INBOX: [{ uid: 10, messageId: "inbox-1@example.test", subject: "ohmail-fixture question", from: "anna@example.test" }],
  Sent: [{ uid: 40, messageId: "sent-1@example.test", subject: "Re: ohmail-fixture question", from: "me@example.test" }],
}) {
  const db = (await makeTestDb()) as unknown as Tx;
  const [a] = await db.insert(accounts).values({ name: "sent-expunge" }).returning();
  const accountId = a!.id;
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: "me@example.test" }).returning();
  const imap = server(seed);
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

  it("the deleted row keeps who, when and what about, not its preview, words or other header lines; its return brings them back", async () => {
    const w = await world();
    await w.cycle();
    await w.cycle();
    const inbox = await idOf(w.db, "inbox-1@example.test");
    const identity = async () => (await w.db.select({
      dedupKey: messages.dedupKey, header: messages.messageIdHeader, from: messages.fromAddress,
      subject: messages.subject, date: messages.date, bodyHash: messages.bodyHash,
    }).from(messages).where(eq(messages.id, inbox)))[0];
    const headersOf = async () => (await w.db.select({ h: messageBodies.headers }).from(messageBodies)
      .where(eq(messageBodies.messageId, inbox)))[0]!.h as Record<string, string[]>;
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
    const block = await headersOf();
    expect(Object.keys(block), "the precondition: a header block").toEqual(expect.arrayContaining(["from", "to", "subject", "message-id"]));
    expect(await kept(), "the precondition: a preview and a search document").toEqual({
      snippet: "the whole text of the message", documents: 1, drawn: ["Anna asks about the fixture", "https://t.example.test/o?r=anna"],
    });

    w.imap.expunge("INBOX", 10);
    await w.cycle();
    expect(await identity(), "the deleted row lost what identifies it").toEqual(before);
    // Of its header block, only the lines readers of deleted mail act on: here its To line.
    expect(await headersOf(), "a letter gone from the server kept header lines nothing reads").toEqual({ to: block.to });
    expect(await kept(), "a letter gone from the server kept its preview or words").toEqual({ snippet: "", documents: 0, drawn: [] });
    await searchIndexBackfillPass({ db: w.db, accountId: w.accountId });
    expect((await kept()).documents, "the backfill wrote a gone letter's words back").toBe(0);

    w.imap.append("INBOX", { uid: 11, messageId: "inbox-1@example.test", subject: "ohmail-fixture question", from: "anna@example.test" });
    await w.cycle();
    expect(await kept(), "the returned letter has no preview or words")
      .toEqual({ snippet: "the whole text of the message", documents: 1, drawn: [] });
    expect(await headersOf(), "the returned letter's header block is not whole again").toEqual(block);
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

describe("a reply deleted on the server still says who was answered", () => {
  /**
   * Three people wrote; we answered two of them and our responder answered the third. Each reply
   * leaves the server, and the store must still read them as before: ohbox tidy, the rule retro and
   * the Screener move mail on this answer. Anna's reply went to her list and names her letter only by
   * References; Bob's names him only in its To line (an older row: its recipient columns empty);
   * Carol's is an automatic reply. Mutation: drop `references`, `to` or `auto-submitted` from what a
   * gone letter keeps and the arm it carries goes red.
   */
  it("References, an unknown recipient list and an automatic reply keep their answer, and the seed review stays", async () => {
    const w = await world({
      INBOX: [
        { uid: 10, messageId: "anna-1@example.test", subject: "ohmail-fixture harbour", from: "anna@example.test" },
        { uid: 11, messageId: "bob-1@example.test", subject: "ohmail-fixture ledger", from: "bob@example.test" },
        { uid: 12, messageId: "carol-1@example.test", subject: "ohmail-fixture parcel", from: "carol@example.test" },
      ],
      Sent: [
        { uid: 40, messageId: "re-anna@example.test", subject: "Re: ohmail-fixture harbour", from: "me@example.test",
          to: "harbour-list@lists.example.test", extra: ["References: <anna-1@example.test>"] },
        { uid: 41, messageId: "re-bob@example.test", subject: "Ledger, as asked", from: "me@example.test", to: "bob@example.test" },
        { uid: 42, messageId: "re-carol@example.test", subject: "Re: ohmail-fixture parcel", from: "me@example.test",
          to: "carol@example.test", extra: ["In-Reply-To: <carol-1@example.test>", "Auto-Submitted: auto-replied"] },
      ],
    });
    await w.cycle();
    await w.cycle();
    const [anna, bob, carol, reBob] = await Promise.all(
      ["anna-1@example.test", "bob-1@example.test", "carol-1@example.test", "re-bob@example.test"].map((h) => idOf(w.db, h)),
    );
    // Bob's reply as an older row holds it: in his conversation, its recipients known only to its header lines.
    const [bobRow] = await w.db.select({ threadId: messages.threadId }).from(messages).where(eq(messages.id, bob));
    await w.db.update(messages).set({ threadId: bobRow!.threadId, toAddresses: [], ccAddresses: [] }).where(eq(messages.id, reBob));
    const d = dialect(w.db);
    const answered = async (id: string): Promise<boolean> => (await w.db.select({ id: messages.id }).from(messages).where(and(
      eq(messages.id, id),
      weAnsweredThisSenderWhere(d, {
        accountId: messages.accountId as never, threadId: messages.threadId as never,
        fromAddress: messages.fromAddress as never, ownAddresses: ["me@example.test"],
      }),
    ))).length === 1;
    const automatic = async (header: string): Promise<boolean> => (await w.db.select({ id: messages.id }).from(messages).where(and(
      eq(messages.messageIdHeader, header),
      autoReplyByUsWhere(d, {
        accountId: messages.accountId as never, id: messages.id as never,
        fromAddress: messages.fromAddress as never, messageIdHeader: messages.messageIdHeader as never,
      }),
    ))).length === 1;
    const reading = async () => ({
      anna: await answered(anna), bob: await answered(bob), carol: await answered(carol),
      carolsReplyIsAutomatic: await automatic("re-carol@example.test"),
    });
    const before = await reading();
    expect(before, "the premise: two people answered, one by our responder").toEqual({
      anna: true, bob: true, carol: false, carolsReplyIsAutomatic: true,
    });
    const review = await buildSeedReview(w.ctx);

    for (const uid of [40, 41, 42]) w.imap.expunge("Sent", uid);
    await w.cycle();
    const gone = await w.db.select({ deletedAt: messages.deletedAt }).from(messages).where(eq(messages.fromAddress, "me@example.test"));
    expect(gone.map((r) => r.deletedAt !== null), "the premise: every reply left the store's live mail").toEqual([true, true, true]);

    expect(await reading(), "a reply that left the server changed who counts as answered").toEqual(before);
    expect(await buildSeedReview(w.ctx), "the consent seed's review changed when the replies left").toEqual(review);
  });
});

describe("letters emptied before deleted mail took its words keep none of them", () => {
  const WHOLE = {
    from: ["Anna <anna@example.test>"], to: ["me@example.test"], subject: ["harbour ledger"], date: ["Fri, 25 Sep 2026 07:46:00 +0000"],
    "message-id": ["<old@example.test>"], received: ["from mx.example.test by in.example.test"], references: ["<first@example.test>"],
  };
  const CUT = { to: WHOLE.to, references: WHOLE.references };

  async function store() {
    const db = (await makeTestDb()) as unknown as Tx;
    const account = async (name: string) => {
      const [a] = await db.insert(accounts).values({ name }).returning();
      const [mb] = await db.insert(mailboxes).values({
        accountId: a!.id, provider: "imap", address: `${name}@example.test`, trashFolder: "Trash",
      }).returning();
      return { accountId: a!.id, mailboxId: mb!.id };
    };
    return { db, account };
  }

  /**
   * One stored letter with all its words: a preview, a search document, the classifier's summary, a
   * tracker's address and a whole header block. `gone`: deleted, emptied for `withheld`, no copy on
   * record; `state`: a folder_state row at that desired folder, `pending` or settled.
   */
  async function letter(db: Tx, at: { accountId: string; mailboxId: string }, key: string, o: {
    deleted?: boolean; withheld?: "expunged" | "storage_cap" | null; state?: { desired: string; pending: boolean };
    scrubbed?: boolean; copy?: boolean;
  } = {}): Promise<string> {
    const [m] = await db.insert(messages).values({
      accountId: at.accountId, mailboxId: at.mailboxId, bodyHash: `h-${key}`, dedupKey: `tidy:${key}`,
      subject: "harbour ledger", fromAddress: "anna@example.test", snippet: o.scrubbed ? "" : "the preview of the ledger",
      deletedAt: o.deleted === false ? null : new Date(), nativeLocator: { folder: "INBOX", ref: `1:${key.length}` },
    }).returning();
    const id = m!.id;
    await db.insert(messageBodies).values({ messageId: id, text: "", html: null, headers: WHOLE, withheldReason: o.withheld ?? "expunged" });
    if (o.copy) {
      await db.insert(messageInstances).values({
        accountId: at.accountId, messageId: id, mailboxId: at.mailboxId, folder: "INBOX", uid: 7, uidvalidity: 1n, isPrimary: true,
      });
    }
    if (o.state) {
      await db.insert(folderState).values({
        messageId: id, desiredFolder: o.state.desired, observedFolder: "INBOX", lastSetBy: "us",
        reconcileStatus: o.state.pending ? "pending" : "reconciled",
      });
    }
    if (!o.scrubbed) {
      await reindexMessageSearch(db, at.accountId, id);
      await db.insert(routingDecisions).values({
        accountId: at.accountId, messageId: id, inputProvenance: "ai", destination: "ohmail/Receipts", status: "auto_applied",
        rationale: "Order 4411 shipping to the harbour office",
      });
      await db.insert(trackerEvents).values({
        accountId: at.accountId, messageId: id, kind: "pixel", trackerHost: "t.example.test", url: "https://t.example.test/o/4411",
      });
    }
    return id;
  }

  const wordsOf = async (db: Tx, id: string) => ({
    snippet: (await db.select({ s: messages.snippet }).from(messages).where(eq(messages.id, id)))[0]!.s,
    documents: (await db.select({ id: messageSearch.messageId }).from(messageSearch).where(eq(messageSearch.messageId, id))).length,
    rationale: (await db.select({ v: routingDecisions.rationale }).from(routingDecisions).where(eq(routingDecisions.messageId, id)))[0]?.v ?? null,
    tracker: (await db.select({ v: trackerEvents.url }).from(trackerEvents).where(eq(trackerEvents.messageId, id)))[0]?.v ?? null,
    headers: (await db.select({ h: messageBodies.headers }).from(messageBodies).where(eq(messageBodies.messageId, id)))[0]!.h,
  });
  const ALL = {
    snippet: "the preview of the ledger", documents: 1, rationale: "Order 4411 shipping to the harbour office",
    tracker: "https://t.example.test/o/4411", headers: WHOLE,
  };
  const NONE = { snippet: "", documents: 0, rationale: null, tracker: null, headers: CUT };

  it("one run takes every gone letter's words and cuts its header block; a letter still there, or not this account's, keeps them", async () => {
    const { db, account } = await store();
    const mine = await account("tidy");
    const theirs = await account("other");
    const erasing = { accountId: mine.accountId, mailboxId: (await db.insert(mailboxes).values({
      accountId: mine.accountId, provider: "imap", address: "erasing@example.test",
    }).returning())[0]!.id };
    const expunged = await letter(db, mine, "expunged");
    const capped = await letter(db, mine, "capped", { withheld: "storage_cap", state: { desired: "INBOX", pending: false } });
    const scrubbed = await letter(db, mine, "scrubbed", { scrubbed: true });
    const kept = {
      trash: await letter(db, mine, "trash", { withheld: "storage_cap", state: { desired: "Trash", pending: false } }),
      pending: await letter(db, mine, "pending", { withheld: "storage_cap", state: { desired: "Archive", pending: true } }),
      copy: await letter(db, mine, "copy", { copy: true }),
      live: await letter(db, mine, "live", { deleted: false, withheld: "storage_cap" }),
      erasing: await letter(db, erasing, "erasing"),
      theirs: await letter(db, theirs, "theirs"),
    };
    await db.update(mailboxes).set({ erasedAt: new Date() }).where(eq(mailboxes.id, erasing.mailboxId));
    const changesBefore = (await db.select().from(changeLog)).length;

    expect(await goneLetterTidyPass(db, mine.accountId)).toMatchObject({ tidied: 3, done: true });
    for (const id of [expunged, capped]) expect(await wordsOf(db, id), "a gone letter kept its words").toEqual(NONE);
    expect(await wordsOf(db, scrubbed), "an emptied letter kept its whole header block").toEqual(NONE);
    for (const [why, id] of Object.entries(kept)) expect(await wordsOf(db, id), `${why} lost its words`).toEqual(ALL);
    expect((await db.select().from(changeLog)).length, "the tidy wrote a change row").toBe(changesBefore);

    expect(await goneLetterTidyPass(db, mine.accountId), "a second run found more").toMatchObject({ tidied: 0, done: true });
  });

  it("a run takes at most its limit: one letter more than the limit takes two runs", async () => {
    const { db, account } = await store();
    const mine = await account("paged");
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await letter(db, mine, `paged-${i}`));
    const memo = new Set<string>();
    expect(await goneLetterTidyPass(db, mine.accountId, { limit: 3, batch: 2, done: memo })).toMatchObject({ tidied: 3, done: false });
    expect(memo.has(mine.accountId)).toBe(false);
    expect(await goneLetterTidyPass(db, mine.accountId, { limit: 3, batch: 2, done: memo })).toMatchObject({ tidied: 1, done: true });
    for (const id of ids) expect(await wordsOf(db, id)).toEqual(NONE);
    // Done for this process: the next run asks nothing.
    expect(await goneLetterTidyPass(db, mine.accountId, { limit: 3, batch: 2, done: memo })).toMatchObject({ ran: false, tidied: 0 });
  });
});
