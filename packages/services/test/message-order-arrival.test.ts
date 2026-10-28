import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq, inArray, sql, type SQL } from "drizzle-orm";
import { messages } from "@trafficflow/db";
import { dialect, dialectOf } from "@trafficflow/db/dialect";
import { MessageService, SyncService, encodeNullableKeysetCursor } from "../src/index.js";
import { arrivalKeyOf } from "../src/arrival-key.js";
import { sortAtOf } from "../src/dto/materialize.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * THE STORE PAGES IN THE ORDER THE PERSON SEES (the server keyset fix and the cursor
 * bound). Every client sorts mail by `sortAt ?? date` newest first, id breaking
 * a tie (`selectors.ts` `tsOf`); the view lists, History, the month rail and the snapshot window
 * walked the sender-written header instead, so a stale-dated arrival sat pages away from where the
 * list showed it and a future-dated header led page one. One arrival key now orders all of them.
 * The PREMISE for the key carrying no truncation: `date` and `arrived_at` are bound only from JS
 * `Date`s, so the stored instants have milliseconds and nothing finer — asserted on the rows below.
 */

/** The client's comparator, `selectors.ts` `byDateDesc` over `tsOf`, spelled out as the contract. */
const clientKey = (m: { sortAt?: string; date?: string | null }): number => {
  const i = m.sortAt ?? m.date; return i ? Date.parse(i) : 0;
};
const clientOrder = <T extends { id: string; sortAt?: string; date?: string | null }>(xs: T[]): T[] =>
  [...xs].sort((a, b) => { const d = clientKey(b) - clientKey(a); return d !== 0 ? d : a.id < b.id ? 1 : a.id > b.id ? -1 : 0; });

const NOW = new Date("2026-09-29T08:00:00.123Z");
const h = (n: number) => new Date(NOW.getTime() - n * 3600e3);

async function sevenRows() {
  const w = await makeCtx(NOW);
  const named = new Map<string, string>();
  const seed = async (label: string, date: Date | null, arrivedAt: Date | null): Promise<string> => {
    const mid = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "INBOX", subject: label, date: date as Date });
    const set: Record<string, unknown> = { arrivedAt, ...(date === null ? { date: null } : {}) };
    await w.db.update(messages).set(set).where(eq(messages.id, mid));
    named.set(mid, label);
    return mid;
  };
  await seed("A", h(1), h(1));
  await seed("B-header-2025", new Date("2025-01-01T00:00:00Z"), h(2));
  await seed("C", h(3), h(3));
  // D and E share one instant: the page boundary of 2 falls between them, and id breaks the tie.
  await seed("D-tie", h(5), h(5));
  await seed("E-tie", h(5), h(5));
  await seed("F-header-2027", new Date("2027-01-01T00:00:00Z"), h(6));
  await seed("G-no-arrival", h(7), null);
  return { ...w, named };
}

async function walk<T extends { id: string }>(
  page: (cursor?: string) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const p = await page(cursor);
    out.push(...p.items);
    if (!p.nextCursor) return out;
    cursor = p.nextCursor;
  }
  throw new Error("the walk did not end");
}

describe("every store order is the client's arrival order", () => {
  it("the view list, History and the snapshot window, paged by two across the tie", async () => {
    const { ctx, named } = await sevenRows();
    const svc = new MessageService();
    const labels = (xs: Array<{ id: string }>) => xs.map((m) => named.get(m.id));
    // The tie is broken by id desc on both sides; which of D and E wins is the ids' to say.
    const idOf = (l: string) => [...named].find(([, v]) => v === l)![0];
    const tie = idOf("D-tie") > idOf("E-tie") ? ["D-tie", "E-tie"] : ["E-tie", "D-tie"];
    const expected = ["A", "B-header-2025", "C", ...tie, "F-header-2027", "G-no-arrival"];
    const view = await walk((cursor) => svc.list(ctx, { view: "imbox", limit: 2, ...(cursor ? { cursor } : {}) }));
    expect(labels(clientOrder(view as never[])), "the client's own order over the rows").toEqual(expected);
    expect(labels(view), "the view pages walk the header, not the order the list shows").toEqual(expected);
    const all = await walk((cursor) => svc.list(ctx, { view: "all", limit: 2, ...(cursor ? { cursor } : {}) }));
    expect(labels(all), "History pages walk the header").toEqual(expected);
    const sync = new SyncService();
    const snap: Array<{ id: string }> = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const p = await sync.getSnapshot(ctx, { limit: 2, ...(cursor ? { cursor } : {}) });
      snap.push(...p.changes.filter((c) => c.type === "message").map((c) => ({ id: c.id })));
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    expect(labels(snap), "the snapshot window walks the header").toEqual(expected);
  });

  it("the History rail buckets by the arrival month, and its jump lands on the newest by that key", async () => {
    const { ctx, named } = await sevenRows();
    const svc = new MessageService();
    const t = await svc.timeline(ctx);
    expect(t.months.map((m) => [m.month, m.count]), "a stale or future header took its own month").toEqual([["2026-09", 7]]);
    expect(t.undated).toBe(0);
    expect(named.get(t.months[0]!.first.id)).toBe("A");
    const jump = await svc.list(ctx, { view: "all", at: t.months[0]!.first, limit: 3 });
    expect(jump.items.map((m) => named.get(m.id))).toEqual(["A", "B-header-2025", "C"]);
  });

  it("an undated row with no arrival sorts last, counts as undated, and an old `null` cursor reaches it", async () => {
    const w = await makeCtx(NOW);
    const svc = new MessageService();
    const dated = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "INBOX", date: h(1) });
    const undated = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "INBOX", date: h(1) });
    await w.db.update(messages).set({ date: null, arrivedAt: null }).where(eq(messages.id, undated));
    const onlyArrived = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "INBOX", date: h(1) });
    await w.db.update(messages).set({ date: null, arrivedAt: h(3) }).where(eq(messages.id, onlyArrived));
    const all = await walk((cursor) => svc.list(w.ctx, { view: "all", limit: 1, ...(cursor ? { cursor } : {}) }));
    expect(all.map((m) => m.id)).toEqual([dated, onlyArrived, undated]);
    const t = await svc.timeline(w.ctx);
    expect(t.undated, "an arrival with no header is dated by its arrival").toBe(1);
    // A cursor minted before the arrival key named the undated tail as `null`: it is the epoch now.
    const old = encodeNullableKeysetCursor(null, "ffffffff-ffff-ffff-ffff-ffffffffffff");
    const tail = await svc.list(w.ctx, { view: "all", cursor: old });
    expect(tail.items.map((m) => m.id)).toEqual([undated]);
  });

  it("a letter dated two days ahead sits at its arrival, below newer arrivals", async () => {
    const w = await makeCtx(NOW);
    const ahead = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "INBOX", date: new Date(h(3).getTime() + 47 * 3600e3) });
    await w.db.update(messages).set({ arrivedAt: h(3) }).where(eq(messages.id, ahead));
    const newer = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "INBOX", date: h(1) });
    await w.db.update(messages).set({ arrivedAt: h(1) }).where(eq(messages.id, newer));
    const all = await new MessageService().list(w.ctx, { view: "all" });
    expect(all.items.map((m) => m.id)).toEqual([newer, ahead]);
    expect(all.items[1]!.sortAt).toBe(h(3).toISOString());
  });

  it("a v1 snapshot cursor (a header-date position) is refused, so the client restarts the window", async () => {
    const { ctx } = await sevenRows();
    const v1 = Buffer.from(JSON.stringify({ v: 1, s: "0", n: 2, d: h(3).getTime(), i: randomUUID() }), "utf8").toString("base64url");
    await expect(new SyncService().getSnapshot(ctx, { limit: 2, cursor: v1 })).rejects.toMatchObject({ code: "cursor_expired" });
    // CONTROL: the cursor this build mints resumes.
    const first = await new SyncService().getSnapshot(ctx, { limit: 2 });
    expect(first.nextCursor).not.toBeNull();
    await expect(new SyncService().getSnapshot(ctx, { limit: 2, cursor: first.nextCursor! })).resolves.toBeDefined();
  });
});

/**
 * A CLIENT FROM BEFORE THE ARRIVAL KEY PAGES WITH HEADER DATES. The
 * 0.25.4 History walker anchors each next page on the last row's `date` and its id. Read as an
 * arrival key, a stale-dated row's header sent the walk below a year of mail. The server takes the
 * position from the named row's OWN key while that row lives, so an old walker pages every row once.
 */
describe("an old client's header-date anchors still page every row once", () => {
  it("History (view=all), pages of two, anchors from the last row's header date and id", async () => {
    const w = await makeCtx(NOW);
    const seed = async (date: Date | null, arrivedAt: Date | null): Promise<string> => {
      const id = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "INBOX", date: (date ?? h(1)) as Date });
      await w.db.update(messages).set({ date, arrivedAt }).where(eq(messages.id, id));
      return id;
    };
    const ids = [
      await seed(h(1), h(1)),
      await seed(new Date("2025-01-01T00:00:00Z"), h(2)),   // stale header, arrived two hours ago
      ...await Promise.all([5, 20, 40, 70, 100, 130, 160, 190].map((d) => seed(h(24 * d), h(24 * d)))),
      await seed(new Date("2024-03-01T00:00:00Z"), new Date("2024-03-01T00:00:00Z")),
    ];
    const svc = new MessageService();
    const seen: string[] = [];
    let before: { date: string | null; id: string } | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await svc.list(w.ctx, { view: "all", limit: 2, ...(before ? { before } : {}) });
      seen.push(...page.items.map((m) => m.id));
      const last = page.items[page.items.length - 1] as { id: string; date?: string | null } | undefined;
      if (!page.nextCursor || !last) break;
      before = { date: last.date ?? null, id: last.id };
    }
    expect(new Set(seen).size, "a row was served twice").toBe(seen.length);
    expect(new Set(seen), "the old walker skipped rows").toEqual(new Set(ids));
  });

  it("CONTROL: a named row that is gone falls back to the date the client sent", async () => {
    const w = await makeCtx(NOW);
    const kept = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "INBOX", date: h(5) });
    await w.db.update(messages).set({ arrivedAt: h(5) }).where(eq(messages.id, kept));
    const page = await new MessageService().list(w.ctx, {
      view: "all", limit: 5, before: { date: h(1).toISOString(), id: randomUUID() },
    });
    expect(page.items.map((m) => m.id)).toEqual([kept]);
  });
});

describe("the SQL key is sortAtOf, row for row", () => {
  it("at equal, the 48 h edges both ways, past them, undated, no arrival and pre-1970", async () => {
    const w = await makeCtx(NOW);
    const TOL = 48 * 3600e3;
    const cases: Array<[string, Date | null, Date | null]> = [
      ["equal", h(1), h(1)],
      ["-48h exactly", new Date(NOW.getTime() - TOL), NOW],
      ["+48h exactly", new Date(NOW.getTime() + TOL), NOW],
      ["+1ms", new Date(NOW.getTime() + 1), NOW],
      ["-48h -1ms", new Date(NOW.getTime() - TOL - 1), NOW],
      ["+48h +1ms", new Date(NOW.getTime() + TOL + 1), NOW],
      ["no header", null, h(2)],
      ["no arrival", h(4), null],
      ["undated", null, null],
      ["pre-1970, no arrival", new Date("1965-06-01T12:00:00.456Z"), null],
    ];
    const ids: Record<string, string> = {};
    for (const [label, date, arrivedAt] of cases) {
      const id = await seedMessage(w.db, w.accountId, w.mailboxId, { folder: "INBOX", date: (date ?? h(9)) as Date });
      await w.db.update(messages).set({ date, arrivedAt }).where(eq(messages.id, id));
      ids[label] = id;
    }
    const rows = await w.db.select({ id: messages.id, key: arrivalKeyOf(w.db), date: messages.date, arrivedAt: messages.arrivedAt })
      .from(messages).where(inArray(messages.id, Object.values(ids)));
    for (const [label, date, arrivedAt] of cases) {
      const r = rows.find((x) => x.id === ids[label])!;
      // The premise: what went in as a JS Date comes back to the millisecond.
      expect(r.date?.getTime() ?? null, `${label}: the stored header is not ms-exact`).toBe(date?.getTime() ?? null);
      const want = sortAtOf(date, arrivedAt) ?? (date ? date.toISOString() : new Date(0).toISOString());
      expect(r.key.toISOString(), label).toBe(want);
    }
  });
});

/**
 * THE DEVICE STORE TAKES THE SAME INDEX (`pnpm test:sqlite`; on PGlite in the default project). The
 * History page statement is the one `MessageService.list` built — captured from its own builder and
 * planned with its own parameters — and the plan names mail 0171's index with no sort above it.
 * The server's range-and-no-filter reading is the lane-db pin in `message-order-arrival.pg.test.ts`.
 */
describe("the store a phone carries walks the arrival index too", () => {
  it("a deep History page is planned on messages_account_arrival_key_idx, with no sort", async () => {
    const w = await makeCtx(NOW);
    const rows = Array.from({ length: 3000 }, (_, g) => ({
      accountId: w.accountId, mailboxId: w.mailboxId, messageIdHeader: `mid:${g}`, bodyHash: `h${g}`,
      dedupKey: `arrival:${g}:${randomUUID()}`, subject: "s", fromAddress: "x@example.test",
      date: g % 97 === 0 ? null : new Date(NOW.getTime() - g * 60_000 - (g % 13 === 0 ? 400 * 864e5 : 0)),
      arrivedAt: g % 3 === 0 ? null : new Date(NOW.getTime() - g * 60_000),
      nativeLocator: { folder: "INBOX", ref: `1:${g}` }, snippet: "hi", unread: true,
    }));
    for (let i = 0; i < rows.length; i += 200) await w.db.insert(messages).values(rows.slice(i, i + 200));
    const d = dialect(w.db);
    await d.exec(w.db, sql`analyze`);
    const svc = new MessageService();
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) cursor = (await svc.list(w.ctx, { view: "all", limit: 100, ...(cursor ? { cursor } : {}) })).nextCursor!;
    // THE BUILDER ITSELF: every select the next page makes is kept, and the keyset one is planned.
    const built: Array<{ toSQL(): { sql: string; params: unknown[] } }> = [];
    const select = w.db.select.bind(w.db);
    const spy = (w.db as unknown as { select: (...a: unknown[]) => unknown });
    const was = spy.select;
    spy.select = (...a: unknown[]) => {
      const b = (select as (...x: unknown[]) => { from: (...f: unknown[]) => unknown })(...a);
      const from = b.from.bind(b);
      // `from` makes the query; `where`/`orderBy`/`limit` then build it in place.
      b.from = (...f: unknown[]) => { const q = from(...f); built.push(q as never); return q; };
      return b;
    };
    try { await svc.list(w.ctx, { view: "all", limit: 100, cursor }); } finally { spy.select = was; }
    const page = built.map((b) => b.toSQL()).filter((q) => /order by \(case when "messages"\."arrived_at"/i.test(q.sql));
    expect(page, "the page issued no arrival-ordered select").toHaveLength(1);
    const plan = (await d.exec(w.db, sql`explain ${sql.raw(dialectOf(w.db) === "sqlite" ? "query plan " : "")}${bound(page[0]!)}`)).flat().join("\n");
    expect(plan, plan).toContain("messages_account_arrival_key_idx");
    expect(plan, "the page sorted the account instead of walking the index").not.toMatch(/TEMP B-TREE FOR ORDER BY|Sort Key/);
  });
});

/** A built statement back as a fragment, its parameters bound where the builder put them. */
function bound(q: { sql: string; params: unknown[] }): SQL {
  const parts = q.sql.split(/\$\d+|\?/);
  const chunks: SQL[] = [];
  parts.forEach((p, i) => { chunks.push(sql.raw(p)); if (i < q.params.length) chunks.push(sql`${q.params[i]}`); });
  return sql.join(chunks, sql``);
}
