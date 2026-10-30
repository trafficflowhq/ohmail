import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { and, eq, sql } from "drizzle-orm";
import {
  AccountErasedError, accounts, accountSettings, accountStorage, applyBodyBytesDelta, bodyBytesOf, changeLog,
  mailboxes, messageBodies, messages, messageSearch, type Tx,
} from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  HTML_WORDS_MAX, normalizeMime, searchInputsFromStore, silentLogger, snippetOfText, UNMETERED_STORAGE_CAP,
  upsertMessageSearchRows,
} from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { runSyncCycle } from "../src/sync.js";
import { htmlWordsBackfillPass, htmlWordsOwedAccounts, type HtmlWordsBackfillOptions } from "../src/html-words-backfill.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * THE HTML-WORDS BACKFILL (mail 0172), on the in-process store (PGlite here, the device's SQLite in
 * the `sqlite` project). Every letter is a real ingest through the sync cycle, then put back the way
 * a build before the words stored it: the parse's own text, no preview, the document from the html.
 * One pass gives it exactly what ingest stores now and moves nothing else.
 */

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");
const head = (name: string): string[] => [
  `From: Shop <news-${name}@sender.invalid>`, "To: me@example.test", `Subject: ${name}`,
  "Date: Wed, 30 Sep 2026 12:00:00 +0000", `Message-ID: <${name}@lane.invalid>`, "MIME-Version: 1.0",
];
/** Pictures and html, no text part. */
const related = (name: string, html: string): Buffer => Buffer.from([...head(name),
  'Content-Type: multipart/related; boundary="R"', "", "--R", "Content-Type: text/html; charset=utf-8",
  "Content-Transfer-Encoding: base64", "", b64(html), "--R", "Content-Type: image/png", "Content-ID: <p@x>",
  "Content-Transfer-Encoding: base64", "", "iVBORw0KGgo=", "--R--", ""].join("\r\n"));
/** A text part beside the html; an empty one is what #470 calls the empty-text alternative. */
const alternative = (name: string, text: string, html: string): Buffer => Buffer.from([...head(name),
  'Content-Type: multipart/alternative; boundary="B"', "", "--B", "Content-Type: text/plain; charset=utf-8", "", text,
  "--B", "Content-Type: text/html; charset=utf-8", "Content-Transfer-Encoding: base64", "", b64(html), "--B--", ""].join("\r\n"));

const SALE = '<style>.zorblatt{color:red}</style><table><tr><td>Autumn</td><td>sale</td></tr></table>'
  + '<div>All week</div><div>off <a href="https://shop.example/x">everything</a></div><img src="cid:p@x">';

async function world() {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `hw-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `hw-${accountId.slice(0, 8)}@example.test`,
  }).returning();
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory({ host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials */ } });
  const delivered: Array<{ from: string; subject: string; messageId: string; raw: Buffer }> = [];
  const raws = new Map<string, Buffer>();
  /** Delivered through the real cycle, as a mailbox hands them over. */
  const deliver = async (letters: Array<[string, Buffer]>) => {
    for (const [name, raw] of letters) {
      delivered.push({ from: "x", subject: name, messageId: `${name}-${delivered.length}`, raw });
      raws.set(name, raw);
    }
    fleet.behave(mb!.id, { deliver: [...delivered] });
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE, repo: makeDrizzleRepo(db as never), adapter, accountId, mailboxId: mb!.id,
      storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(), signatures: null, log: silentLogger,
    });
  };
  const rows = async (name: string) => db.select({
    id: messages.id, text: messageBodies.text, html: messageBodies.html, snippet: messages.snippet,
    dedupKey: messages.dedupKey, bodyHash: messages.bodyHash, withheld: messageBodies.withheldReason,
    noAi: messages.noAi, noKb: messages.noKb,
  }).from(messages).innerJoin(messageBodies, eq(messageBodies.messageId, messages.id))
    .where(and(eq(messages.accountId, accountId), eq(messages.subject, name)));
  const row = async (name: string) => (await rows(name))[0]!;
  /** Back to a build before the words: the parse's own text, its preview, the document read from the html. */
  const asBefore = async (name: string) => {
    const parsed = await normalizeMime(raws.get(name)!);
    const before = parsed.ownText ?? parsed.textBody;
    const r = await row(name);
    await db.update(messageBodies).set({ text: before }).where(eq(messageBodies.messageId, r.id));
    await db.update(messages).set({ snippet: snippetOfText(before) }).where(eq(messages.id, r.id));
    await upsertMessageSearchRows(db, await searchInputsFromStore(db, accountId, [r.id]));
    await applyBodyBytesDelta(db, dialect(db), accountId,
      bodyBytesOf({ text: before, html: null }) - bodyBytesOf({ text: r.text, html: null }));
    return r.id;
  };
  const counter = async () => (await db.select({ b: accountStorage.bytes }).from(accountStorage)
    .where(eq(accountStorage.accountId, accountId)))[0]?.b ?? 0;
  const deltas = async (id?: string) => (await db.select({ id: changeLog.entityId, op: changeLog.op }).from(changeLog)
    .where(and(eq(changeLog.accountId, accountId), eq(changeLog.entityType, "message"))))
    .filter((c) => id === undefined || c.id === id);
  const settings = async () => (await db.select({
    at: accountSettings.htmlWordsBackfillAt, cursor: accountSettings.htmlWordsBackfillCursor,
  }).from(accountSettings).where(eq(accountSettings.accountId, accountId)))[0] ?? { at: null, cursor: null };
  const source = async (id: string) => (await db.select({ s: messageSearch.source }).from(messageSearch)
    .where(eq(messageSearch.messageId, id)))[0]?.s;
  const pass = (o: Omit<HtmlWordsBackfillOptions, "accountId"> = {}) => htmlWordsBackfillPass(db, { accountId, ...o });
  /** The letters the store's own word index finds by this word in their text. */
  const found = async (word: string) => {
    const d = dialect(db);
    const rowsFound = await d.exec(db, sql`select m.id from messages m
      join message_bodies b on b.message_id = m.id join message_search s on s.message_id = m.id
      where m.account_id = ${accountId} and ${d.search.words(word).text.pred}`);
    return rowsFound.map((r) => String(r[0]));
  };
  return { db, accountId, deliver, row, rows, asBefore, counter, deltas, settings, source, pass, found, raws };
}

describe("a stored html-only letter", () => {
  it("gets ingest's words, preview and document in one pass, under the key and hash it always had", async () => {
    const w = await world();
    await w.deliver([["sale", related("sale", SALE)]]);
    const ingested = await w.row("sale");
    const parsed = await normalizeMime(w.raws.get("sale")!);
    expect(ingested.text).toBe(parsed.textBody);
    const id = await w.asBefore("sale");
    expect((await w.row("sale")).text).toBe("");
    expect(await w.source(id)).toBe("html");
    const bytes = await w.counter();
    const changes = (await w.deltas(id)).length;

    const r = await w.pass();
    expect(r).toMatchObject({ ran: true, scanned: 1, blank: 1, filled: 1, wordless: 0, cut: false, marked: true });
    const after = await w.row("sale");
    expect([after.text, after.snippet]).toEqual([ingested.text, ingested.snippet]);
    expect(after.text).toBe("Autumn sale\n\nAll week\noff everything");
    expect([after.dedupKey, after.bodyHash, after.html]).toEqual([ingested.dedupKey, ingested.bodyHash, ingested.html]);
    expect(await w.source(id)).toBe("text");
    expect(await w.found("Autumn")).toEqual([id]);
    expect(await w.counter() - bytes).toBe(Buffer.byteLength(after.text, "utf8"));
    expect((await w.deltas(id)).slice(changes)).toEqual([{ id, op: "update" }]);

    await w.deliver([["sale", related("sale", SALE)]]);
    expect(await w.rows("sale"), "a second delivery finds the filled row").toHaveLength(1);
  }, 120_000);

  it("an empty text part stored as a line break is blank too, and is filled", async () => {
    const w = await world();
    await w.deliver([["empty-text", alternative("empty-text", "", "<p>Your order</p><p>has shipped</p>")]]);
    await w.asBefore("empty-text");
    expect((await w.row("empty-text")).text, "mailparser's text of an empty part").toBe("\n");
    expect(await w.pass()).toMatchObject({ filled: 1, marked: true });
    expect((await w.row("empty-text")).text).toBe("Your order\n\nhas shipped");
  }, 120_000);
});

describe("what it leaves alone", () => {
  it("a letter's own text, a withheld body and a deleted letter stay byte-identical, with no delta and no bytes", async () => {
    const w = await world();
    await w.deliver([
      ["own-text", alternative("own-text", "Hello there", "<p>Other words</p>")],
      ["capped", related("capped", SALE)], ["junk", related("junk", SALE)], ["gone", related("gone", SALE)],
    ]);
    for (const n of ["capped", "junk", "gone"]) await w.asBefore(n);
    await w.db.update(messageBodies).set({ withheldReason: "storage_cap" }).where(eq(messageBodies.messageId, (await w.row("capped")).id));
    await w.db.update(messageBodies).set({ withheldReason: "junk_filed" }).where(eq(messageBodies.messageId, (await w.row("junk")).id));
    await w.db.update(messages).set({ deletedAt: new Date() }).where(eq(messages.id, (await w.row("gone")).id));
    const before = await Promise.all(["own-text", "capped", "junk", "gone"].map((n) => w.row(n)));
    const bytes = await w.counter();
    const changes = (await w.deltas()).length;

    expect(await w.pass()).toMatchObject({ filled: 0, marked: true });
    expect(await Promise.all(["own-text", "capped", "junk", "gone"].map((n) => w.row(n)))).toEqual(before);
    expect(await w.counter()).toBe(bytes);
    expect((await w.deltas()).length).toBe(changes);
  }, 120_000);

  it("a letter of pictures, hidden text or filler keeps an empty text; the walk stamps and the next call reads nothing", async () => {
    const w = await world();
    await w.deliver([
      ["pictures", related("pictures", '<img src="cid:p@x"><img src="https://x.example/a.png">')],
      ["hidden", related("hidden", '<div style="display:none">secret</div><img src="cid:p@x">')],
      ["filler", related("filler", "<p>͏&zwnj; ͏&zwnj; ­</p>")],
    ]);
    for (const n of ["pictures", "hidden", "filler"]) await w.asBefore(n);
    expect(await w.pass()).toMatchObject({ ran: true, blank: 3, filled: 0, wordless: 3, marked: true });
    for (const n of ["pictures", "hidden", "filler"]) expect((await w.row(n)).text).toBe("");
    expect((await w.settings()).at).not.toBeNull();
    expect(await w.pass()).toMatchObject({ ran: false, scanned: 0 });
    expect(await htmlWordsOwedAccounts(w.db, { limit: 10 })).not.toContain(w.accountId);
  }, 120_000);
});

describe("the walk resumes", () => {
  it("after a short page, at its cursor, and every letter gets one delta", async () => {
    const w = await world();
    const names = ["r1", "r2", "r3", "r4", "r5"];
    await w.deliver(names.map((n) => [n, related(n, `<p>Words of ${n}</p>`)] as [string, Buffer]));
    const ids: string[] = [];
    for (const n of names) ids.push(await w.asBefore(n));
    const changes = (await w.deltas()).length;
    expect(await htmlWordsOwedAccounts(w.db, { limit: 10 })).toContain(w.accountId);

    expect(await w.pass({ scanRows: 2 })).toMatchObject({ scanned: 2, filled: 2, marked: false });
    const sorted = [...ids].sort();
    expect((await w.settings()).cursor).toBe(sorted[1]);
    expect((await w.settings()).at).toBeNull();
    expect(await w.pass()).toMatchObject({ scanned: 3, filled: 3, marked: true });
    expect((await w.settings()).cursor).toBeNull();
    expect((await w.settings()).at, "stamped over the cursor's row").not.toBeNull();
    expect(await w.pass()).toMatchObject({ ran: false, scanned: 0 });
    for (const n of names) expect((await w.row(n)).text).toBe(`Words of ${n}`);
    expect((await w.deltas()).slice(changes).map((c) => c.id).sort()).toEqual(sorted);
  }, 120_000);

  it("after a page its clock cut, at the next row", async () => {
    const w = await world();
    const names = ["c1", "c2", "c3"];
    await w.deliver(names.map((n) => [n, related(n, `<p>Words of ${n}</p>`)] as [string, Buffer]));
    for (const n of names) await w.asBefore(n);
    let turns = 0;
    expect(await w.pass({ until: () => turns >= 1, turn: async () => { turns += 1; } }))
      .toMatchObject({ scanned: 1, filled: 1, cut: true, marked: false });
    expect(await w.pass()).toMatchObject({ scanned: 2, filled: 2, marked: true });
    for (const n of names) expect((await w.row(n)).text).toBe(`Words of ${n}`);
  }, 120_000);

  it("a clock spent before the first row still decides one row and moves the cursor", async () => {
    const w = await world();
    const names = ["s1", "s2", "s3"];
    await w.deliver(names.map((n) => [n, related(n, `<p>Words of ${n}</p>`)] as [string, Buffer]));
    const sorted = (await Promise.all(names.map((n) => w.asBefore(n)))).sort();
    expect(await w.pass({ until: () => true })).toMatchObject({ scanned: 1, filled: 1, cut: true, marked: false });
    expect((await w.settings()).cursor).toBe(sorted[0]);
    expect(await w.pass({ until: () => true })).toMatchObject({ scanned: 1, filled: 1, cut: true });
    expect((await w.settings()).cursor).toBe(sorted[1]);
    expect(await w.pass()).toMatchObject({ scanned: 1, filled: 1, marked: true });
    for (const n of names) expect((await w.row(n)).text).toBe(`Words of ${n}`);
  }, 120_000);
});

describe("the phone's store", () => {
  it("guards each fill by its own letter, never by a list of the account's letters", async (ctx) => {
    const w = await world();
    if (dialect(w.db).name !== "sqlite") ctx.skip();
    await w.deliver([["planned", related("planned", SALE)]]);
    await w.asBefore("planned");
    const node = createRequire(import.meta.url)("node:sqlite") as { DatabaseSync: { prototype: { prepare: (...a: unknown[]) => unknown } } };
    const proto = node.DatabaseSync.prototype;
    const prepare = proto.prepare;
    const sent: Array<{ conn: { prepare: (t: string) => { all: () => Array<Record<string, unknown>> } }; text: string }> = [];
    proto.prepare = function (this: (typeof sent)[number]["conn"], ...a: unknown[]) {
      sent.push({ conn: this, text: String(a[0]) }); return prepare.apply(this, a);
    };
    try { expect(await w.pass()).toMatchObject({ filled: 1 }); } finally { proto.prepare = prepare; }
    const fill = sent.find((s) => /^update "message_bodies"/.test(s.text))!;
    const plan = fill.conn.prepare(`explain query plan ${fill.text}`).all().map((r) => String(r.detail));
    expect(plan.filter((l) => /LIST SUBQUERY/.test(l)), plan.join("\n")).toEqual([]);
    const reads = plan.filter((l) => /\bmessages\b/.test(l));
    expect(reads.length, plan.join("\n")).toBeGreaterThan(0);
    expect(reads.filter((l) => !/^SEARCH messages USING .*\(id=\?/.test(l)), "every read of messages is by the letter's id").toEqual([]);
  }, 120_000);
});

describe("hostile html", () => {
  const shapes: Array<[string, string]> = [
    ["spaces", "<pre>a" + " ".repeat(262_000) + "b</pre>"],
    ["tabs", "<pre>a" + "\t".repeat(262_000) + "b</pre>"],
    ["deep", "<blockquote>".repeat(5_000) + "<pre>" + "\n".repeat(200_000) + "x"],
    ["at-cap", "<p>" + "word ".repeat(60_000) + "</p>"],
  ];

  it("each row is decided within the bound, its words within theirs, and as ingest stores them", async () => {
    const w = await world();
    await w.deliver(shapes.map(([n, html]) => [n, related(n, html)] as [string, Buffer]));
    for (const [n] of shapes) await w.asBefore(n);
    const stamps: number[] = [performance.now()];
    const r = await w.pass({ turn: async () => { stamps.push(performance.now()); } });
    expect(r).toMatchObject({ blank: 4, marked: true });
    for (let i = 1; i < stamps.length; i++) expect(stamps[i]! - stamps[i - 1]!).toBeLessThan(500);
    for (const [n] of shapes) {
      const text = (await w.row(n)).text;
      expect(text.length).toBeLessThanOrEqual(HTML_WORDS_MAX);
      expect(text).toBe((await normalizeMime(w.raws.get(n)!)).textBody);
    }
  }, 120_000);

  it("an expired clock stops the page after the row in flight", async () => {
    const w = await world();
    await w.deliver(shapes.slice(0, 2).map(([n, html]) => [n, related(n, html)] as [string, Buffer]));
    for (const [n] of shapes.slice(0, 2)) await w.asBefore(n);
    let turns = 0;
    expect(await w.pass({ until: () => turns >= 1, turn: async () => { turns += 1; } }))
      .toMatchObject({ scanned: 1, blank: 1, cut: true, marked: false });
  }, 120_000);
});

describe("a write it did not read", () => {
  it.each<[string, { withheldReason?: "storage_cap"; text?: string }]>([
    ["withheld meanwhile", { withheldReason: "storage_cap" }],
    ["given its own text meanwhile", { text: "Written by somebody else" }],
  ])("%s: nothing is written, no delta and no bytes", async (_case, change) => {
    const w = await world();
    await w.deliver([["raced", related("raced", SALE)]]);
    const id = await w.asBefore("raced");
    const bytes = await w.counter();
    const changes = (await w.deltas()).length;
    const r = await w.pass({ beforeWrite: async () => {
      await w.db.update(messageBodies).set(change).where(eq(messageBodies.messageId, id));
    } });
    expect(r).toMatchObject({ blank: 1, filled: 0, marked: true });
    expect((await w.row("raced")).text).toBe(change.text ?? "");
    expect((await w.deltas()).length).toBe(changes);
    expect(await w.counter()).toBe(bytes);
  }, 120_000);
});

describe("an erased account", () => {
  it("is not owed, and a pass the fence refuses writes nothing", async () => {
    const w = await world();
    await w.deliver([["erased", related("erased", SALE)]]);
    const id = await w.asBefore("erased");
    const changes = (await w.deltas()).length;
    await w.db.update(accounts).set({ erasedAt: new Date() }).where(eq(accounts.id, w.accountId));
    expect(await htmlWordsOwedAccounts(w.db, { limit: 10 })).not.toContain(w.accountId);
    await expect(w.pass()).rejects.toBeInstanceOf(AccountErasedError);
    expect((await w.row("erased")).text).toBe("");
    expect(await w.source(id)).toBe("html");
    expect(await w.settings()).toEqual({ at: null, cursor: null });
    expect((await w.deltas()).length).toBe(changes);
  }, 120_000);
});
