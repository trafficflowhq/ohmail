import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { mailboxes, messageBodies } from "@trafficflow/db";
import { pgDialect } from "@trafficflow/db/dialect";
import { searchIndexBackfillPass } from "@trafficflow/core/mail";
import { SearchService, type SearchParts, type SearchResult } from "../src/index.js";
import { IMPORT_OPEN_MAX_MS, importOpen } from "../src/search-coverage.js";
import { makeCtx, otherAccount, seedMessage } from "./helpers.js";

/**
 * A SEARCH ANSWER STATES WHETHER THE STORE HOLDS THE WHOLE MAILBOX. The store below
 * is a first sync's: INBOX is in, the letter in Newsletters is not, and the backfill has written
 * its marker, so no index progress is sent. Every part answers `importing: true` until the
 * mailbox's first import is stamped, and exactly as before once it is. Both stores: this file runs
 * in the sqlite project too.
 */
const PARTS: readonly SearchParts[] = ["page", "estimate", "summary", "both"];
const STAMP = new Date("2026-07-28T11:00:00Z");

async function midImport() {
  const { db, ctx, accountId, mailboxId } = await makeCtx();
  for (let i = 0; i < 6; i++) {
    const id = await seedMessage(db, accountId, mailboxId, {
      subject: `invoice ${74600 + i}`, folder: "INBOX", date: new Date(Date.parse("2026-07-01T09:00:00Z") + i * 3_600_000),
    });
    await db.insert(messageBodies).values({ messageId: id, accountId, text: `the invoice for order ${74600 + i}` });
  }
  const r = await searchIndexBackfillPass({ db: db as never, accountId });
  expect(r.marked, "the backfill's marker is written, as on a first sync").toBe(true);
  return { db, ctx, accountId, mailboxId };
}

type Env = Awaited<ReturnType<typeof midImport>>;
const stamp = (e: Env, id: string) => e.db.update(mailboxes).set({ initialImportCompletedAt: STAMP }).where(eq(mailboxes.id, id));
const ask = (e: Env, q: string, parts: SearchParts): Promise<SearchResult> => new SearchService().search(e.ctx, { q, parts });
/** The answer without its clock, for the complete-store control. */
const shape = (r: SearchResult) => ({ ...r, ms: 0 });

describe("a search answer says when the store has not taken in the whole mailbox", () => {
  it("mid-import: every part carries `importing`, an exact match and a closest-words answer alike", async () => {
    const e = await midImport();
    for (const parts of PARTS) {
      const hit = await ask(e, "invoice 74600", parts);
      expect(hit.tier, parts).toBe("exact");
      expect(hit.importing, parts).toBe(true);
      expect(hit.indexed, `${parts}: the backfill is done, so no index progress`).toBeUndefined();
      const miss = await ask(e, "delivery window 2059", parts);
      expect(miss.tier, parts).toBe("similar");
      expect(miss.importing, parts).toBe(true);
    }
  });

  it("the complete-store control: once the import is stamped, the answer is the one it always was", async () => {
    const e = await midImport();
    const before = await Promise.all(PARTS.map((p) => ask(e, "invoice 74600", p)));
    await stamp(e, e.mailboxId);
    for (const [i, parts] of PARTS.entries()) {
      const after = await ask(e, "invoice 74600", parts);
      expect("importing" in after, parts).toBe(false);
      const { importing, ...rest } = shape(before[i]!);
      expect(importing).toBe(true);
      expect(shape(after), parts).toEqual(rest);
    }
  });

  it("a mailbox added later reopens it; a removed, an erased or another account's mailbox does not", async () => {
    const e = await midImport();
    await stamp(e, e.mailboxId);
    const [added] = await e.db.insert(mailboxes).values({ accountId: e.accountId, provider: "imap", address: "second@lichtgrat.example" }).returning();
    expect((await ask(e, "invoice", "page")).importing).toBe(true);
    await e.db.update(mailboxes).set({ status: "disabled" }).where(eq(mailboxes.id, added!.id));
    expect("importing" in (await ask(e, "invoice", "page")), "a removed mailbox").toBe(false);
    await e.db.update(mailboxes).set({ status: "connected", erasedAt: STAMP }).where(eq(mailboxes.id, added!.id));
    expect("importing" in (await ask(e, "invoice", "page")), "an erased mailbox").toBe(false);
    await otherAccount(e.db);
    expect("importing" in (await ask(e, "invoice", "page")), "another account's first sync").toBe(false);
  });

  it("the warm session spells only a canonical uuid as a literal; any other id is bound", () => {
    const pg = pgDialect();
    const at = new Date("2026-07-28T12:00:00Z");
    const render = (id: string) => new PgDialect().sqlToQuery(importOpen(pg, id, at, { inline: true }));
    const id = "0f8fad5b-d9cb-469f-a165-70867728950e";
    expect(render(id).params).toEqual([]);
    expect(render(id).sql).toContain(`= '${id}'`);
    expect(render(id).sql, "the window's start, as a literal").toContain("'2026-07-27T12:00:00.000Z'");
    for (const hostile of ["x' or '1'='1", `${id}'`, `${id} `, "acct"]) {
      expect(render(hostile).params, hostile).toContain(hostile);
      expect(render(hostile).sql, hostile).not.toContain(hostile);
    }
    expect(new PgDialect().sqlToQuery(importOpen(pg, id, at)).params, "bound unless asked").toContain(id);
  });

  /* SEARCH-SCOPE-READS-AN-UNSTAMPED-IMPORT-AS-OPEN: the sync line reads an unwritten stamp as an import
     only within its window after the mailbox was connected; search reads the same stamp by the same window. */
  it("an unwritten stamp past the window is not an import in flight, on every path; inside it, it is", async () => {
    const e = await midImport();
    const now = e.ctx.now().getTime();
    const connected = (ms: number) => e.db.update(mailboxes).set({ createdAt: new Date(now - ms) }).where(eq(mailboxes.id, e.mailboxId));
    await connected(IMPORT_OPEN_MAX_MS + 3_600_000);
    // Twice: the first search reads the marker (the cold statement), the second rides the warm one.
    for (const pass of ["cold", "warm"]) {
      for (const parts of PARTS) expect("importing" in (await ask(e, "invoice 74600", parts)), `${pass} ${parts}`).toBe(false);
    }
    expect("importing" in (await new SearchService().searchByAddress(e.ctx, { address: "stranger@example.com", direction: "from" })), "address").toBe(false);
    await connected(IMPORT_OPEN_MAX_MS - 60_000);
    for (const parts of PARTS) expect((await ask(e, "invoice 74600", parts)).importing, parts).toBe(true);
  });

  /* SEARCH-FIRST-IMPORT-PAST-A-DAY-READS-AS-WHOLE: the day runs from the later of the connect and the
     import's last progress (`sync_progress_at`, moved by every cycle that ends with a backlog). */
  it("past the day, an import whose cycles still owe mail is open; no progress, or progress a day old, is not", async () => {
    const e = await midImport();
    const now = e.ctx.now().getTime();
    const set = (v: Partial<typeof mailboxes.$inferInsert>) => e.db.update(mailboxes).set(v).where(eq(mailboxes.id, e.mailboxId));
    const from = { address: "stranger@example.com", direction: "from" } as const;
    await set({ createdAt: new Date(now - IMPORT_OPEN_MAX_MS - 3_600_000), syncProgressAt: new Date(now - 60_000) });
    for (const pass of ["cold", "warm"]) {
      for (const parts of PARTS) expect((await ask(e, "invoice 74600", parts)).importing, `${pass} ${parts}`).toBe(true);
    }
    expect((await new SearchService().searchByAddress(e.ctx, from)).importing, "address").toBe(true);
    await set({ syncProgressAt: null });
    for (const parts of PARTS) expect("importing" in (await ask(e, "invoice 74600", parts)), `no progress, ${parts}`).toBe(false);
    await set({ syncProgressAt: new Date(now - IMPORT_OPEN_MAX_MS - 60_000) });
    for (const parts of PARTS) expect("importing" in (await ask(e, "invoice 74600", parts)), `progress a day old, ${parts}`).toBe(false);
  });

  /* ADDRESS-VIEW-WHOLE-MAILBOX-DURING-FIRST-SYNC: the address arm's count is of the mail synced so far. */
  it("the address arm carries the same fact: `importing` mid-import, absent once stamped", async () => {
    const e = await midImport();
    const from = { address: "STRANGER@example.com", direction: "from" } as const;
    const mid = await new SearchService().searchByAddress(e.ctx, from);
    expect(mid.total, "the seeded sender's mail").toBe(6);
    expect(mid.importing).toBe(true);
    await stamp(e, e.mailboxId);
    const done = await new SearchService().searchByAddress(e.ctx, from);
    expect("importing" in done).toBe(false);
    expect({ ...done, items: done.items.map((m) => m.id) }).toEqual({ ...mid, items: mid.items.map((m) => m.id), importing: undefined });
  });
});
