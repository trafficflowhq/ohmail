import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { mailboxFolders, messages } from "@trafficflow/db";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { createLogger, reindexMessageSearch } from "@trafficflow/core/mail";
import { makeDeps, seedSession, seedMailbox, seedMessage, seedBody, seedSearchDocuments, req, FIXED_NOW } from "./helpers.js";

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

/**
 * §5.7 endpoint wiring. On PGlite the tsvector (lexical) arm is live (core
 * Postgres, replayed by makeTestDb) while the pg_trgm fuzzy arm degrades to
 * ILIKE — the golden fuzzy relevance is proven in search.pg.test.ts. Here we
 * assert the HTTP surface: a lexical query returns items+facets+total, blank/
 * unknown q is handled, and results are account-scoped.
 */
describe("GET /search — hybrid search endpoint", () => {
  it("lists every searchable folder path with exact counts for the session's account", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW });
    const other = await seedSession(db, { now: FIXED_NOW });
    const first = await seedMailbox(db, { accountId: owner.accountId });
    const second = await seedMailbox(db, { accountId: owner.accountId });
    const unrelated = await seedMailbox(db, { accountId: other.accountId });
    const folder = "Archive/Reports";
    const filed = await seedMessage(db, {
      accountId: owner.accountId, mailboxId: first, folder, observedFolder: "INBOX",
    });
    const native = await seedMessage(db, {
      accountId: owner.accountId, mailboxId: second, nativeLocator: { folder, ref: "1:1" },
    });
    const deleted = await seedMessage(db, { accountId: owner.accountId, mailboxId: first, folder });
    await db.update(messages).set({ deletedAt: FIXED_NOW }).where(eq(messages.id, deleted.id));
    await seedMessage(db, { accountId: other.accountId, mailboxId: unrelated, folder });
    await db.insert(mailboxFolders).values([
      { accountId: owner.accountId, mailboxId: second, folder: "Archive/Empty" },
      { accountId: other.accountId, mailboxId: unrelated, folder: "Elsewhere" },
    ]);

    const places = await H(req("GET", `/search?places=1&accountId=${other.accountId}&mailboxId=${unrelated}`, {
      bearer: owner.token,
    }), deps);
    expect(places.status).toBe(200);
    expect(await places.json()).toEqual({
      places: [{ folder, count: 2 }, { folder: "Archive/Empty", count: 0 }],
    });

    const filtered = await H(req("GET", `/search?folder=${encodeURIComponent(folder)}&parts=page`, {
      bearer: owner.token,
    }), deps);
    expect(filtered.status).toBe(200);
    expect((await filtered.json()).items.map((m: { id: string }) => m.id).sort()).toEqual([filed.id, native.id].sort());
  });

  it("refuses an account with too many folders instead of returning a partial inventory", async () => {
    const { db, deps } = await makeDeps();
    const owner = await seedSession(db, { now: FIXED_NOW });
    const mailboxId = await seedMailbox(db, { accountId: owner.accountId });
    const folders = Array.from({ length: 1_001 }, (_, i) => ({
      accountId: owner.accountId, mailboxId, folder: `Archive/Folder-${i}`,
    }));
    await db.insert(mailboxFolders).values(folders.slice(0, 1_000));
    const read = () => H(req("GET", "/search?places=1&limit=1", { bearer: owner.token }), deps);
    const atLimit = await read();
    expect(atLimit.status).toBe(200);
    expect((await atLimit.json()).places).toHaveLength(1_000);

    await db.insert(mailboxFolders).values(folders[1_000]!);
    const overflow = await read();
    expect(overflow.status).toBe(422);
    expect(await overflow.json()).toMatchObject({
      error: { code: "search_too_many_folders", message: expect.stringMatching(/too many folders/i) },
    });
  });

  it("returns items + facets + total for a lexical query", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });

    const inv = await seedMessage(db, {
      accountId: s.accountId, mailboxId: mb, folder: "INBOX",
      subject: "Invoice from Anna", fromAddress: "anna@acme-com.example", unread: true, date: FIXED_NOW,
    });
    await seedBody(db, { messageId: inv.id, text: "Please pay the invoice." });
    const other = await seedMessage(db, {
      accountId: s.accountId, mailboxId: mb, folder: "ohmail/News",
      subject: "Weekly newsletter", fromAddress: "news@shop.example", unread: false, date: FIXED_NOW,
    });
    await seedBody(db, { messageId: other.id, text: "Deals this week." });

    await seedSearchDocuments(db, s.accountId);
    const res = await H(req("GET", "/search?q=invoice", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((m: { id: string }) => m.id)).toContain(inv.id);
    expect(body.items.map((m: { id: string }) => m.id)).not.toContain(other.id);
    expect(body.total).toBeGreaterThanOrEqual(1);
    // Facet envelope is present and well-formed.
    expect(body.facets.folder.INBOX).toBe(1);
    expect(body.facets).toHaveProperty("sender");
    expect(body.facets.unread).toEqual({ true: 1, false: 0 });
  });

  it("every answer says where its time went in Server-Timing and one log line, never what was asked", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    const inv = await seedMessage(db, {
      accountId: s.accountId, mailboxId: mb, folder: "INBOX",
      subject: "Invoice from Anna", fromAddress: "anna@acme-com.example", unread: true, date: FIXED_NOW,
    });
    await seedBody(db, { messageId: inv.id, text: "Please pay the invoice." });
    await seedSearchDocuments(db, s.accountId);
    const lines: string[] = [];
    const logged = { ...deps, logger: createLogger({ service: "api", level: "debug", sink: (l: string) => { lines.push(l); } }) };
    for (const [path, part] of [["/search?q=invoice&parts=page", "page"], ["/search?q=invoice&parts=summary", "summary"],
      ["/search?address=anna%40acme-com.example&direction=from", "address"]] as const) {
      lines.length = 0;
      const res = await H(req("GET", path, { bearer: s.token }), logged);
      expect(res.status).toBe(200);
      const header = res.headers.get("server-timing") ?? "";
      // Each entry a phase with its duration, or a closed fact.
      for (const entry of header.split(", ")) {
        expect(entry, header).toMatch(/^(session|acquire|flight|dto|total);dur=\d+(\.\d)?$|^(part;desc=(page|summary|estimate|both|address)|tier;desc=(exact|similar)|cut;desc=[01]|items;desc=\d+|statements;desc=\d+)$/);
      }
      expect(header).toContain(`part;desc=${part}`);
      expect(header).toMatch(/total;dur=/);
      const line = lines.find((l) => l.includes("search_timing"));
      expect(line, lines.join("\n")).toBeDefined();
      expect(JSON.parse(line!)).toMatchObject({ searchPart: part, searchItems: part === "summary" ? 0 : 1 });
      expect(JSON.parse(line!).totalMs).toEqual(expect.any(Number));
      // The mailbox's size in one closed word on the text parts; never a count.
      expect(JSON.parse(line!).searchSize, part).toEqual(part === "address" ? undefined : expect.stringMatching(/^(small|large)$/));
      for (const told of [header, line!]) {
        for (const secret of ["invoice", "anna", "acme", inv.id, s.accountId]) expect(told.toLowerCase()).not.toContain(secret.toLowerCase());
      }
    }
  });

  it("parts=estimate answers the candidates' count and facets with no rows; an unknown part is refused", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    const inv = await seedMessage(db, {
      accountId: s.accountId, mailboxId: mb, folder: "INBOX",
      subject: "Invoice from Anna", fromAddress: "anna@acme-com.example", unread: true, date: FIXED_NOW,
    });
    await seedBody(db, { messageId: inv.id, text: "Please pay the invoice." });

    await seedSearchDocuments(db, s.accountId);
    const res = await H(req("GET", "/search?q=invoice&parts=estimate", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(1);
    expect(body.totalExact).toBe(true);
    expect(body.facets.folder).toEqual({ INBOX: 1 });
    expect(body.facets.unread).toEqual({ true: 1, false: 0 });

    const bad = await H(req("GET", "/search?q=invoice&parts=guess", { bearer: s.token }), deps);
    expect(bad.status).toBe(400);
  });

  it("a folder filter narrows the result set", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    const a = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX", subject: "Report Q1", date: FIXED_NOW });
    await seedBody(db, { messageId: a.id, text: "quarterly report" });
    const b = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "ohmail/News", subject: "Report Q2", date: FIXED_NOW });
    await seedBody(db, { messageId: b.id, text: "quarterly report" });

    await seedSearchDocuments(db, s.accountId);
    const res = await H(req("GET", "/search?q=report&folder=INBOX", { bearer: s.token }), deps);
    const body = await res.json();
    expect(body.items.map((m: { id: string }) => m.id)).toEqual([a.id]);
    expect(body.total).toBe(1);
  });

  it("the unread and attachment filters narrow the result set on either store", async () => {
    // Both filters are booleans compared in a raw fragment. Bound as JavaScript booleans, the
    // device store's driver refused the statement; as literals both stores answer alike.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    const a = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX", subject: "Report A", unread: true, date: FIXED_NOW });
    await db.update(messages).set({ hasAttachments: true }).where(eq(messages.id, a.id));
    await seedBody(db, { messageId: a.id, text: "quarterly report" });
    const b = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX", subject: "Report B", unread: false, date: FIXED_NOW });
    await seedBody(db, { messageId: b.id, text: "quarterly report" });

    await seedSearchDocuments(db, s.accountId);
    const ids = async (query: string): Promise<string[]> => {
      const res = await H(req("GET", `/search?q=report&${query}`, { bearer: s.token }), deps);
      expect(res.status, query).toBe(200);
      return (await res.json()).items.map((m: { id: string }) => m.id);
    };
    expect(await ids("unread=true")).toEqual([a.id]);
    expect(await ids("unread=false")).toEqual([b.id]);
    expect(await ids("hasAttachments=true")).toEqual([a.id]);
    expect(await ids("hasAttachments=false")).toEqual([b.id]);
  });

  it("a blank q returns an empty result (no error)", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("GET", "/search?q=", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);

    // A missing q param behaves the same.
    const res2 = await H(req("GET", "/search", { bearer: s.token }), deps);
    expect(res2.status).toBe(200);
    expect((await res2.json()).total).toBe(0);
  });

  it("is account-scoped — another account's message never appears", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const mb = await seedMailbox(db, { accountId: s.accountId });
    const mine = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX", subject: "Invoice mine", date: FIXED_NOW });
    await seedBody(db, { messageId: mine.id, text: "invoice body" });

    // A different account's decoy that also matches "invoice".
    const otherAcct = randomUUID();
    const theirs = await seedMessage(db, { accountId: otherAcct, folder: "INBOX", subject: "Invoice theirs", date: FIXED_NOW });
    await seedBody(db, { messageId: theirs.id, text: "invoice body" });
    await seedSearchDocuments(db, s.accountId);
    await seedSearchDocuments(db, otherAcct);

    const res = await H(req("GET", "/search?q=invoice", { bearer: s.token }), deps);
    const body = await res.json();
    const gotIds = body.items.map((m: { id: string }) => m.id);
    expect(gotIds).toContain(mine.id);
    expect(gotIds).not.toContain(theirs.id);
    // Nor is it counted: the total and the facets are this account's alone.
    expect({ total: body.total, inbox: body.facets.folder.INBOX }).toEqual({ total: 1, inbox: 1 });

    // The same under each person filter: both letters are from and to the same people, and a third
    // of this account's, from and to others, is narrowed away.
    const elsewhere = await seedMessage(db, { accountId: s.accountId, mailboxId: mb, folder: "INBOX", subject: "Invoice elsewhere", date: FIXED_NOW });
    await seedBody(db, { messageId: elsewhere.id, text: "invoice body" });
    await reindexMessageSearch(db as never, s.accountId, elsewhere.id);
    for (const id of [mine.id, theirs.id]) {
      await db.update(messages).set({ fromAddress: "ann@shared.test", toAddresses: [{ name: null, address: "ben@shared.test" }] })
        .where(eq(messages.id, id));
    }
    const filters = ["sender=ann@shared.test", "to=ben@shared.test", "party=ann@shared.test", "party=ben@shared.test"];
    // With words, and with none: the filters alone list what they keep.
    for (const filter of [...filters.map((f) => `q=invoice&${f}`), ...filters.map((f) => `q=&${f}`)]) {
      const r = await (await H(req("GET", `/search?${filter}`, { bearer: s.token }), deps)).json();
      expect({ filter, ids: r.items.map((m: { id: string }) => m.id), total: r.total, inbox: r.facets.folder.INBOX })
        .toEqual({ filter, ids: [mine.id], total: 1, inbox: 1 });
    }
  });

  it("requires a session (401 without a token)", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("GET", "/search?q=invoice"), deps);
    expect(res.status).toBe(401);
  });
});
