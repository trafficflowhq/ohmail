import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { messages } from "@trafficflow/db";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { createLogger } from "@trafficflow/core/mail";
import { makeDeps, seedSession, seedMailbox, seedMessage, seedBody, req, FIXED_NOW } from "./helpers.js";

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

    const res = await H(req("GET", "/search?q=invoice", { bearer: s.token }), deps);
    const body = await res.json();
    const gotIds = body.items.map((m: { id: string }) => m.id);
    expect(gotIds).toContain(mine.id);
    expect(gotIds).not.toContain(theirs.id);
  });

  it("requires a session (401 without a token)", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("GET", "/search?q=invoice"), deps);
    expect(res.status).toBe(401);
  });
});
