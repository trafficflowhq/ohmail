import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql, type SQL } from "drizzle-orm";
import { messageBodies, messages } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import { searchIndexBackfillPass } from "@trafficflow/core/mail";
import { SearchService, type SearchFilters } from "../src/index.js";
import { makeCtx, otherAccount, seedMessage } from "./helpers.js";

/**
 * THE ADDRESS ARM BY RECIPIENT, on whichever store the project runs: PGlite (the desktop's store,
 * the key each letter stores since mail 0208) and SQLite (the phone's, 0154's side table kept by triggers). `to`
 * is To and Cc, case-folded, each message once; `any` is that and the From half; the account
 * scopes both. `from` is the positive control: its answer does not move.
 */
type Addr = { name: string | null; address: string };

async function corpus() {
  const w = await makeCtx(new Date("2026-08-01T12:00:00Z"));
  const at = (d: number) => new Date(Date.UTC(2026, 6, d, 9));
  const seed = async (
    accountId: string, mailboxId: string, o: { from: string; to?: unknown[]; cc?: unknown[]; day: number },
  ): Promise<string> => {
    const id = await seedMessage(w.db, accountId, mailboxId, { from: o.from, folder: "INBOX", date: at(o.day) });
    await w.db.update(messages).set({
      toAddresses: (o.to ?? []) as Addr[], ccAddresses: (o.cc ?? []) as Addr[],
    }).where(eq(messages.id, id));
    return id;
  };
  const sent = await seed(w.accountId, w.mailboxId, { from: "info@acme.test", day: 10 });
  const toHer = await seed(w.accountId, w.mailboxId, {
    from: "bob@acme.test", to: [{ name: null, address: "Info@ACME.test" }], cc: [{ name: null, address: "info@acme.test" }], day: 12,
  });
  const ccHer = await seed(w.accountId, w.mailboxId, { from: "carol@acme.test", cc: [{ name: "Info", address: "INFO@acme.test" }], day: 8 });
  const near = await seed(w.accountId, w.mailboxId, { from: "dan@acme.test", to: [{ name: null, address: "info@acme.test.evil" }], day: 11 });
  const b = await otherAccount(w.db);
  const theirs = await seed(b.accountId, b.mailboxId, { from: "eve@acme.test", to: [{ name: null, address: "info@acme.test" }], day: 13 });
  return { ...w, b, sent, toHer, ccHer, near, theirs };
}

const ids = (r: { items: Array<{ id: string }> }) => r.items.map((m) => m.id);

/**
 * A bulk-seeded store with the statistics a desktop's own store keeps for its letters. Without them
 * PGlite plans a page that keeps nothing so that it takes 70 s on 20,004 letters (48 ms with them).
 */
async function settled(db: Parameters<typeof dialect>[0]): Promise<void> {
  const d = dialect(db);
  if (d.name === "pg") await d.exec(db, sql`analyze messages`);
}

describe("searchByAddress answers `to` and `any` on this store", () => {
  it("`to` is To and Cc, case-folded, once each, newest first, and never the sender half", async () => {
    const c = await corpus();
    const r = await new SearchService().searchByAddress(c.ctx, { address: "info@acme.test", direction: "to" });
    expect(ids(r)).toEqual([c.toHer, c.ccHer]);
    expect(r.total).toBe(2);
    expect(r.direction).toBe("to");
  });

  it("`any` is the union, each message once", async () => {
    const c = await corpus();
    const r = await new SearchService().searchByAddress(c.ctx, { address: "INFO@acme.TEST", direction: "any" });
    expect(ids(r)).toEqual([c.toHer, c.sent, c.ccHer]);
    expect(r.total).toBe(3);
    expect(r.direction).toBe("any");
  });

  it("the account scopes both directions: another account's mail to the same address stays its own", async () => {
    const c = await corpus();
    const svc = new SearchService();
    for (const direction of ["to", "any"] as const) {
      expect(ids(await svc.searchByAddress(c.ctx, { address: "info@acme.test", direction }))).not.toContain(c.theirs);
    }
    const theirs = { ...c.ctx, accountId: c.b.accountId };
    expect(ids(await svc.searchByAddress(theirs, { address: "info@acme.test", direction: "to" }))).toEqual([c.theirs]);
    expect(ids(await svc.searchByAddress(theirs, { address: "info@acme.test", direction: "any" }))).toEqual([c.theirs]);
  });

  it("an equality, a blank address answers empty, and `limit` leaves `total` alone", async () => {
    const c = await corpus();
    const svc = new SearchService();
    for (const q of ["info@acme.tes", "acme.test", "info", "%info@acme.test%"]) {
      expect((await svc.searchByAddress(c.ctx, { address: q, direction: "to" })).total).toBe(0);
    }
    expect(ids(await svc.searchByAddress(c.ctx, { address: "info@acme.test.evil", direction: "to" }))).toEqual([c.near]);
    expect(await svc.searchByAddress(c.ctx, { address: " ", direction: "any" })).toEqual({ items: [], total: 0, direction: "any" });
    const one = await svc.searchByAddress(c.ctx, { address: "info@acme.test", direction: "any", limit: 1 });
    expect(ids(one)).toEqual([c.toHer]);
    expect(one.total).toBe(3);
  });

  it("CONTROL: `from` answers what it answered before", async () => {
    const c = await corpus();
    const r = await new SearchService().searchByAddress(c.ctx, { address: "info@acme.test", direction: "from" });
    expect(ids(r)).toEqual([c.sent]);
    expect(r.total).toBe(1);
    expect(r.direction).toBe("from");
  });

  it("odd recipient entries store fine and match nothing; 254 characters is the bound", async () => {
    const c = await corpus();
    const long = (n: number) => `${"x".repeat(n - "@acme.test".length)}@acme.test`;
    const odd = await seedMessage(c.db, c.accountId, c.mailboxId, { from: "odd@acme.test", folder: "INBOX" });
    await c.db.update(messages).set({
      toAddresses: ["info@acme.test", { name: "no address" }, { name: null, address: long(300) }, { name: null, address: long(3000) }] as never,
      ccAddresses: [{ name: null, address: long(254) }],
    }).where(eq(messages.id, odd));
    const svc = new SearchService();
    expect(ids(await svc.searchByAddress(c.ctx, { address: "info@acme.test", direction: "to" }))).not.toContain(odd);
    expect((await svc.searchByAddress(c.ctx, { address: long(300), direction: "to" })).total).toBe(0);
    expect((await svc.searchByAddress(c.ctx, { address: long(3000), direction: "to" })).total).toBe(0);
    expect(ids(await svc.searchByAddress(c.ctx, { address: long(254), direction: "to" }))).toEqual([odd]);
  });
});

/**
 * THE PERSON FILTERS OF A TEXT SEARCH, on whichever store the project runs: `to` (To or Cc) and
 * `party` (From, To or Cc) narrow the words' matches, as `sender` (From) always has. Every answer
 * is checked against a plain reading of the seeded letters, never against another search.
 */
const PEOPLE = ["alice@a.test", "bob@b.test", "carol@c.test", "dan@d.test"] as const;
interface Letter { id: string; from: string; to: string[]; cc: string[]; word: string; unread: boolean; att: boolean; day: number; mine: boolean; gone: boolean }

async function people() {
  const w = await makeCtx(new Date("2026-08-01T12:00:00Z"));
  const b = await otherAccount(w.db);
  const letters: Letter[] = [];
  const seed = async (o: Omit<Letter, "id">): Promise<void> => {
    const accountId = o.mine ? w.accountId : b.accountId;
    const id = await seedMessage(w.db, accountId, o.mine ? w.mailboxId : b.mailboxId, {
      from: o.from, folder: "INBOX", unread: o.unread, subject: `note ${o.day}`, snippet: o.word,
      date: new Date(Date.UTC(2026, 6, 1, 9) - o.day * 3_600_000),
    });
    // An address is stored as it was written: the filters fold its case, never the store.
    const shout = (a: string, i: number) => ({ name: null, address: i % 3 === 0 ? a.toUpperCase() : a });
    await w.db.update(messages).set({
      toAddresses: o.to.map(shout), ccAddresses: o.cc.map(shout), hasAttachments: o.att,
      ...(o.gone ? { deletedAt: new Date("2026-07-30T00:00:00Z") } : {}),
    }).where(eq(messages.id, id));
    await w.db.insert(messageBodies).values({ messageId: id, accountId, text: `the ${o.word} for this week` });
    letters.push({ ...o, id });
  };
  for (let i = 0; i < 40; i++) {
    await seed({
      from: PEOPLE[i % 4]!, to: [PEOPLE[(i + 1) % 4]!], cc: i % 3 === 0 ? [PEOPLE[(i + 2) % 4]!] : [],
      word: Math.floor(i / 4) % 2 === 0 ? "budget" : "picnic", unread: i % 5 < 2, att: i % 7 === 0, day: i, mine: true, gone: false,
    });
  }
  // Each would match every case below but for its account or its deletion.
  await seed({ from: PEOPLE[0], to: [PEOPLE[1]], cc: [PEOPLE[2]], word: "budget", unread: true, att: true, day: 41, mine: false, gone: false });
  await seed({ from: PEOPLE[0], to: [PEOPLE[1]], cc: [PEOPLE[2]], word: "budget", unread: true, att: true, day: 42, mine: true, gone: true });
  for (const accountId of [w.accountId, b.accountId]) {
    expect((await searchIndexBackfillPass({ db: w.db as never, accountId })).marked).toBe(true);
  }
  const kept = letters.filter((l) => l.mine && !l.gone);
  const newest = (ls: Letter[]) => [...ls].sort((x, y) => x.day - y.day).map((l) => l.id);
  return { ...w, b, letters, kept, newest };
}

const holds = (l: Letter, a: string) => l.to.includes(a) || l.cc.includes(a);
const sorted = (xs: readonly string[]) => [...xs].sort();

describe("the person filters narrow a text search", () => {
  it("words with `to`: the letters holding the word that went To or Cc the address", async () => {
    const c = await people();
    const r = await new SearchService().search(c.ctx, { q: "budget", filters: { to: "bob@b.test" } });
    const want = c.kept.filter((l) => l.word === "budget" && holds(l, "bob@b.test"));
    expect(want.some((l) => l.to.includes("bob@b.test")) && want.some((l) => l.cc.includes("bob@b.test"))).toBe(true);
    expect(sorted(ids(r))).toEqual(sorted(want.map((l) => l.id)));
    expect([r.total, r.totalExact]).toEqual([want.length, true]);
  });

  it("words with `party`: From, To or Cc, each letter once", async () => {
    const c = await people();
    const r = await new SearchService().search(c.ctx, { q: "picnic", filters: { party: "carol@c.test" } });
    const want = c.kept.filter((l) => l.word === "picnic" && (l.from === "carol@c.test" || holds(l, "carol@c.test")));
    expect(want.some((l) => l.from === "carol@c.test")).toBe(true);
    expect(want.some((l) => l.to.includes("carol@c.test"))).toBe(true);
    expect(want.some((l) => l.cc.includes("carol@c.test") && !l.to.includes("carol@c.test"))).toBe(true);
    expect(sorted(ids(r))).toEqual(sorted(want.map((l) => l.id)));
    expect(r.total).toBe(want.length);
  });

  it("`sender` with `to`: both hold", async () => {
    const c = await people();
    const r = await new SearchService().search(c.ctx, { q: "budget", filters: { sender: "alice@a.test", to: "carol@c.test" } });
    const want = c.kept.filter((l) => l.word === "budget" && l.from === "alice@a.test" && holds(l, "carol@c.test"));
    const fromAlone = c.kept.filter((l) => l.word === "budget" && l.from === "alice@a.test");
    expect(want.length).toBeGreaterThan(0);
    expect(want.length).toBeLessThan(fromAlone.length);
    expect(sorted(ids(r))).toEqual(sorted(want.map((l) => l.id)));
  });

  it("an address in any case is the same address; a part of one is none", async () => {
    const c = await people();
    const svc = new SearchService();
    const lower = await svc.search(c.ctx, { q: "budget", filters: { to: "bob@b.test", party: "alice@a.test" } });
    const upper = await svc.search(c.ctx, { q: "budget", filters: { to: "BOB@B.Test", party: "ALICE@a.TEST" } });
    expect(ids(lower).length).toBeGreaterThan(0);
    expect(sorted(ids(upper))).toEqual(sorted(ids(lower)));
    for (const part of ["bob@b.tes", "b.test", "bob", "%bob@b.test%"]) {
      for (const filters of [{ to: part }, { party: part }]) {
        const r = await svc.search(c.ctx, { q: "budget", filters });
        expect([part, r.items.length, r.total]).toEqual([part, 0, 0]);
      }
    }
  });

  it("never another account's letter nor a deleted one, in the rows, the total or the facets", async () => {
    const c = await people();
    const svc = new SearchService();
    const outside = c.letters.filter((l) => !l.mine || l.gone).map((l) => l.id);
    for (const filters of [{ to: "bob@b.test" }, { party: "carol@c.test" }, { party: "alice@a.test" }]) {
      const r = await svc.search(c.ctx, { q: "budget", filters });
      const want = c.kept.filter((l) => l.word === "budget" && (filters.to !== undefined ? holds(l, filters.to)
        : l.from === filters.party || holds(l, filters.party!)));
      expect(ids(r).filter((id) => outside.includes(id))).toEqual([]);
      expect(r.total).toBe(want.length);
      expect(Object.values(r.facets.folder).reduce((a, n) => a + n, 0)).toBe(want.length);
    }
    const theirs = await svc.search({ ...c.ctx, accountId: c.b.accountId }, { q: "budget", filters: { to: "bob@b.test" } });
    expect(ids(theirs)).toEqual(c.letters.filter((l) => !l.mine).map((l) => l.id));
  });

  it("on the device's store the To filter reads the recipients' index", async ({ skip }) => {
    const c = await people();
    const d = dialect(c.db);
    if (d.name !== "sqlite") skip();
    const plan = await d.exec(c.db, sql`explain query plan select m.id from messages m
      where m.account_id = ${c.accountId} and m.deleted_at is null and ${d.search.recipient({ accountId: c.accountId, address: "bob@b.test" })}`);
    expect(plan.map((r) => String(r[3])).join("\n")).toMatch(/message_recipients_account_address_idx/);
  });
});

describe("a search with no words lists what its filters keep, newest first", () => {
  const ALONE: ReadonlyArray<readonly [string, SearchFilters, (l: Letter) => boolean]> = [
    ["unread", { unread: true }, (l) => l.unread],
    ["read", { unread: false }, (l) => !l.unread],
    ["with files", { hasAttachments: true }, (l) => l.att],
    ["folder", { folder: "INBOX" }, () => true],
    ["dates", { dateFrom: "2026-06-30T00:00:00Z", dateTo: "2026-06-30T23:59:59Z" }, (l) => l.day >= 10 && l.day <= 33],
    ["sender", { sender: "ALICE@a.test" }, (l) => l.from === "alice@a.test"],
    ["to", { to: "bob@b.test" }, (l) => holds(l, "bob@b.test")],
    ["party", { party: "carol@c.test" }, (l) => l.from === "carol@c.test" || holds(l, "carol@c.test")],
    ["sender and unread", { sender: "bob@b.test", unread: true }, (l) => l.from === "bob@b.test" && l.unread],
    ["to and files", { to: "carol@c.test", hasAttachments: true }, (l) => holds(l, "carol@c.test") && l.att],
    ["sender and to", { sender: "alice@a.test", to: "carol@c.test" }, (l) => l.from === "alice@a.test" && holds(l, "carol@c.test")],
  ];

  it("each filter alone, and together: the rows, the total and the facets of a plain reading", async () => {
    const c = await people();
    const svc = new SearchService();
    for (const [name, filters, keeps] of ALONE) {
      const want = c.kept.filter(keeps);
      expect([name, want.length > 0]).toEqual([name, true]);
      const r = await svc.search(c.ctx, { q: "", filters });
      expect({ name, ids: ids(r), total: r.total, exact: r.totalExact, tier: r.tier })
        .toEqual({ name, ids: c.newest(want), total: want.length, exact: true, tier: "exact" });
      expect({ name, unread: r.facets.unread, files: r.facets.hasAttachments }).toEqual({
        name,
        unread: { true: want.filter((l) => l.unread).length, false: want.filter((l) => !l.unread).length },
        files: { true: want.filter((l) => l.att).length, false: want.filter((l) => !l.att).length },
      });
      const senders = Object.fromEntries(r.facets.sender.map((s) => [s.address, s.count]));
      for (const who of PEOPLE) {
        expect([name, who, senders[who] ?? 0]).toEqual([name, who, want.filter((l) => l.from === who).length]);
      }
      const estimate = await svc.search(c.ctx, { q: " ", filters, parts: "estimate" });
      expect({ name, total: estimate.total, exact: estimate.totalExact }).toEqual({ name, total: want.length, exact: true });
    }
  });

  it("pages of two walk the whole list once, in order, by an ordered cursor", async () => {
    const c = await people();
    const svc = new SearchService();
    for (const [name, filters, keeps] of [ALONE[0]!, ALONE[6]!, ALONE[8]!]) {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 40; i++) {
        const r = await svc.search(c.ctx, { q: "", filters, limit: 2, parts: "page", ...(cursor ? { cursor } : {}) });
        expect(r.items.length).toBeLessThanOrEqual(2);
        seen.push(...ids(r));
        if (r.nextCursor === null) break;
        cursor = r.nextCursor;
      }
      expect({ name, seen }).toEqual({ name, seen: c.newest(c.kept.filter(keeps)) });
    }
  });

  it("words that only exclude stay empty beside a filter; no words and no filter stay empty", async () => {
    const c = await people();
    const svc = new SearchService();
    const r = await svc.search(c.ctx, { q: "-budget", filters: { to: "bob@b.test" } });
    expect([ids(r), r.total]).toEqual([[], 0]);
    const blank = await svc.search(c.ctx, { q: "  ", filters: {} });
    expect([ids(blank), blank.total]).toEqual([[], 0]);
  });

  it("orders other than newest first are refused, and so is a relevance cursor", async () => {
    const c = await people();
    const svc = new SearchService();
    for (const sort of ["date_asc", "mailbox", "sender"] as const) {
      await expect(svc.search(c.ctx, { q: "", filters: { unread: true }, sort })).rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
    }
    const newest = await svc.search(c.ctx, { q: "", filters: { unread: true }, sort: "date_desc", parts: "page", limit: 3 });
    expect(ids(newest)).toEqual(c.newest(c.kept.filter((l) => l.unread)).slice(0, 3));
    const words = await svc.search(c.ctx, { q: "budget", parts: "page", limit: 1 });
    await expect(svc.search(c.ctx, { q: "", filters: { unread: true }, cursor: words.nextCursor! }))
      .rejects.toMatchObject({ code: "validation_failed", httpStatus: 400 });
  });
});

describe("a search with no words past the walk's bound", () => {
  /** Past the walk's bound by a few: the filters keep only letters past it. */
  const LETTERS = 20_004;
  it("a page may be short, even empty, and still carry the cursor to the letters past the walk", async () => {
    const c = await makeCtx(new Date("2026-08-01T12:00:00Z"));
    const d = dialect(c.db);
    const pg = d.name === "pg";
    // One statement each store can run, letter `i` a minute older than letter `i - 1`; the last two carry no date.
    const date = pg ? sql`timestamptz '2026-07-01T00:00:00Z' - make_interval(mins => g.i)` : sql`${Date.UTC(2026, 6, 1)} - g.i * 60000`;
    const locator = pg ? sql`jsonb_build_object('folder', 'INBOX', 'ref', '1:' || g.i)` : sql`json_object('folder', 'INBOX', 'ref', '1:' || g.i)`;
    const flag = (cond: SQL) => (pg ? cond : sql`case when ${cond} then 1 else 0 end`);
    await d.exec(c.db, sql`with recursive g(i) as (select 0 union all select i + 1 from g where i < ${LETTERS + 1})
      insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, native_locator, unread)
      select ${c.accountId}, ${c.mailboxId}, 'h', 'bulk:' || g.i, 'bulk', case when g.i in (3, ${LETTERS - 1}) then 'few@x.test' else 'many@x.test' end,
        case when g.i < ${LETTERS} then ${date} end, ${locator}, ${flag(sql`g.i in (${LETTERS - 3}, ${LETTERS - 1}, ${LETTERS + 1})`)} from g`);
    const idOf = new Map((await d.exec(c.db, sql`select dedup_key, id from messages where account_id = ${c.accountId}`))
      .map((r) => [Number(String(r[0]).slice(5)), String(r[1])]));
    expect(idOf.size).toBe(LETTERS + 2);
    await settled(c.db);
    const svc = new SearchService();
    // The undated letter lies after every dated one: behind a dated cursor the walk still reaches it, last.
    const cases: ReadonlyArray<readonly [SearchFilters, number[]]> = [
      [{ unread: true }, [LETTERS - 3, LETTERS - 1, LETTERS + 1]],
      // A person with many letters: the walk asks the person of each.
      [{ sender: "many@x.test", unread: true }, [LETTERS - 3, LETTERS + 1]],
    ];
    for (const [filters, places] of cases) {
      const want = places.map((i) => idOf.get(i)!);
      const first = await svc.search(c.ctx, { q: "", filters, parts: "page" });
      expect(ids(first)).toEqual([]);
      expect(first.nextCursor).not.toBeNull();
      const second = await svc.search(c.ctx, { q: "", filters, parts: "page", cursor: first.nextCursor! });
      expect([ids(second), second.nextCursor]).toEqual([want, null]);
      const counted = await svc.search(c.ctx, { q: "", filters, parts: "summary" });
      expect(counted.totalExact).toBe(false);
    }
    // A person with few letters is read off their own index: no walk, so no short page.
    const few = await svc.search(c.ctx, { q: "", filters: { sender: "few@x.test" } });
    expect([ids(few), few.nextCursor, few.total, few.totalExact]).toEqual([[idOf.get(3), idOf.get(LETTERS - 1)], null, 2, true]);
  }, 120_000);
});

describe("a search with no words in a large mailbox: each person is read off their own index while few", () => {
  /**
   * 60,000 letters, letter `g` a minute older than `g - 1`. The own address is To of every letter and
   * From of every second; a colleague wrote the odd letters among the oldest 6,000 (3,000, none
   * recent); an old contact is To of the oldest 10,500 only (none among the newest 49,500); a third
   * is To of every third letter; a rare one is To of one letter in 2,000, each from the own address;
   * one in 500 is unread.
   */
  const N = 60_000;
  const OLD_FROM = N - 10_500;
  const keeps = {
    old: (g: number) => g >= OLD_FROM,
    few: (g: number) => g % 2000 === 10,
    mine: (g: number) => g % 2 === 0,
    colleague: (g: number) => g % 2 === 1 && g >= N - 6_000,
    third: (g: number) => g % 3 === 0,
    unread: (g: number) => g % 500 === 3,
  };
  async function mailbox() {
    const c = await makeCtx(new Date("2026-08-01T12:00:00Z"));
    const d = dialect(c.db);
    const pg = d.name === "pg";
    const date = pg ? sql`timestamptz '2026-07-01T00:00:00Z' - make_interval(mins => g.i)` : sql`${Date.UTC(2026, 6, 1)} - g.i * 60000`;
    const locator = pg ? sql`jsonb_build_object('folder', 'INBOX', 'ref', '1:' || g.i)` : sql`json_object('folder', 'INBOX', 'ref', '1:' || g.i)`;
    const flag = (cond: SQL) => (pg ? cond : sql`case when ${cond} then 1 else 0 end`);
    const one = (a: string) => (pg ? sql`jsonb_build_array(jsonb_build_object('name', null, 'address', ${a}::text))` : sql`json_array(json_object('name', null, 'address', ${a}))`);
    const none = pg ? sql`'[]'::jsonb` : sql`json_array()`;
    const when = (cond: SQL, a: string) => sql`case when ${cond} then ${one(a)} else ${none} end`;
    // The recipients' lists, one after the other: jsonb's `||`, and on the device's store its JSON functions.
    const cat = (...xs: SQL[]): SQL => (pg ? sql.join(xs, sql` || `)
      : sql`(select json_group_array(json(j.value)) from (${sql.join(xs.map((x) => sql`select value from json_each(${x})`), sql` union all `)}) j)`);
    await d.exec(c.db, sql`with recursive g(i) as (select 0 union all select i + 1 from g where i < ${N - 1})
      insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, native_locator, unread, to_addresses)
      select ${c.accountId}, ${c.mailboxId}, 'h', 'big:' || g.i, 'bulk',
        case when g.i % 2 = 0 then 'me@own.test' when g.i >= ${N - 6_000} then 'colleague@x.test' else 'sender' || (g.i % 500) || '@x.test' end,
        ${date}, ${locator}, ${flag(sql`g.i % 500 = 3`)},
        ${cat(one("me@own.test"), when(sql`g.i >= ${OLD_FROM}`, "old@x.test"), when(sql`g.i % 3 = 0`, "third@x.test"), when(sql`g.i % 2000 = 10`, "few@x.test"))}
      from g`);
    const place = new Map((await d.exec(c.db, sql`select id, dedup_key from messages where account_id = ${c.accountId}`))
      .map((r) => [String(r[0]), Number(String(r[1]).slice(4))]));
    expect(place.size).toBe(N);
    await settled(c.db);
    const plain = (keep: (g: number) => boolean) => Array.from({ length: N }, (_, g) => g).filter(keep);
    return { ...c, place, plain, svc: new SearchService() };
  }
  let big: Awaited<ReturnType<typeof mailbox>>;
  beforeAll(async () => { big = await mailbox(); }, 300_000);
  const placesOf = (r: { items: Array<{ id: string }> }) => r.items.map((m) => big.place.get(m.id)!);
  /** Every page of a wordless search, in order, through its cursor. */
  async function walkAll(filters: SearchFilters, most = 10) {
    const pages: number[][] = [];
    let cursor: string | undefined;
    for (let i = 0; i < most; i++) {
      const r = await big.svc.search(big.ctx, { q: "", filters, parts: "page", ...(cursor ? { cursor } : {}) });
      pages.push(placesOf(r));
      if (r.nextCursor === null) return pages;
      cursor = r.nextCursor;
    }
    throw new Error(`more than ${most} pages`);
  }

  it("an address past ten thousand letters with none recent: its newest letters on the first page", async () => {
    const want = big.plain(keeps.old);
    const first = await big.svc.search(big.ctx, { q: "", filters: { to: "old@x.test" }, parts: "page" });
    expect(placesOf(first)).toEqual(want.slice(0, 50));
    const second = await big.svc.search(big.ctx, { q: "", filters: { to: "old@x.test" }, parts: "page", cursor: first.nextCursor! });
    expect(placesOf(second)).toEqual(want.slice(50, 100));
    const counted = await big.svc.search(big.ctx, { q: "", filters: { to: "old@x.test" }, parts: "summary" });
    expect([counted.total, counted.totalExact]).toEqual([2_001, false]);
  }, 120_000);

  it("From one with many letters and To one with few: the few are read, one page, counted exactly", async () => {
    const want = big.plain((g) => keeps.mine(g) && keeps.few(g));
    expect(want.length).toBe(30);
    expect(await walkAll({ sender: "me@own.test", to: "few@x.test" })).toEqual([want]);
    const counted = await big.svc.search(big.ctx, { q: "", filters: { sender: "me@own.test", to: "few@x.test" }, parts: "summary" });
    expect([counted.total, counted.totalExact]).toEqual([30, true]);
  }, 120_000);

  it("several people: the first that is few is read, the others asked of its letters", async () => {
    for (const [filters, keep] of [
      [{ sender: "me@own.test", to: "old@x.test" }, (g: number) => keeps.mine(g) && keeps.old(g)],
      [{ to: "few@x.test", party: "old@x.test" }, (g: number) => keeps.few(g) && keeps.old(g)],
      [{ party: "few@x.test", sender: "me@own.test", unread: false }, (g: number) => keeps.few(g) && !keeps.unread(g)],
    ] as const) {
      const want = big.plain(keep);
      const first = await big.svc.search(big.ctx, { q: "", filters, parts: "page" });
      expect({ filters, rows: placesOf(first) }).toEqual({ filters, rows: want.slice(0, 50) });
      expect(first.nextCursor === null).toBe(want.length <= 50);
    }
  }, 120_000);

  it("a person within 20,000 letters beside a recipient filter is read whole, newest first: the first page answers", async () => {
    for (const [filters, keep] of [
      // 3,000 old letters, none among the newest 54,000: the mailbox's walk would meet none on its first two pages.
      [{ sender: "colleague@x.test", to: "me@own.test" }, keeps.colleague],
      [{ party: "colleague@x.test", to: "third@x.test" }, (g: number) => keeps.colleague(g) && keeps.third(g)],
    ] as const) {
      const want = big.plain(keep);
      const first = await big.svc.search(big.ctx, { q: "", filters, parts: "page" });
      expect({ filters, rows: placesOf(first) }).toEqual({ filters, rows: want.slice(0, 50) });
      const second = await big.svc.search(big.ctx, { q: "", filters, parts: "page", cursor: first.nextCursor! });
      expect({ filters, rows: placesOf(second) }).toEqual({ filters, rows: want.slice(50, 100) });
    }
  }, 120_000);

  it("either side of the own address, alone and beside each person: the rows of a plain reading", async () => {
    for (const [filters, keep] of [
      [{ party: "me@own.test" }, () => true],
      [{ to: "me@own.test", party: "me@own.test" }, () => true],
      [{ sender: "me@own.test", party: "me@own.test" }, keeps.mine],
      [{ sender: "colleague@x.test", party: "me@own.test" }, keeps.colleague],
    ] as const) {
      const want = big.plain(keep);
      const first = await big.svc.search(big.ctx, { q: "", filters, parts: "page" });
      expect({ filters, rows: placesOf(first) }).toEqual({ filters, rows: want.slice(0, 50) });
    }
  }, 120_000);

  it("a date range beside a person: the rows of a plain reading, in order through the cursor, and a total never over it", async () => {
    const at = (g: number) => new Date(Date.UTC(2026, 6, 1) - g * 60_000).toISOString();
    const newest = (k: number) => (g: number) => g < k;
    // 3,001 old letters, none among the newest 52,000.
    const old = { dateFrom: at(N - 5_000), dateTo: at(N - 8_000) };
    const inOld = (g: number) => g >= N - 8_000 && g <= N - 5_000;
    for (const [filters, keep] of [
      [{ to: "me@own.test", dateFrom: at(999) }, newest(1_000)],
      [{ to: "me@own.test", dateFrom: at(14_999) }, newest(15_000)],
      [{ to: "me@own.test", dateFrom: at(29_999) }, newest(30_000)],
      [{ to: "me@own.test", ...old }, inOld],
      [{ party: "me@own.test", dateFrom: at(999) }, newest(1_000)],
      [{ sender: "me@own.test", dateFrom: at(999) }, (g: number) => keeps.mine(g) && g < 1_000],
      [{ sender: "me@own.test", to: "me@own.test", dateFrom: at(999) }, (g: number) => keeps.mine(g) && g < 1_000],
      [{ to: "third@x.test", dateFrom: at(29_999) }, (g: number) => keeps.third(g) && g < 30_000],
      [{ to: "me@own.test", unread: true, dateFrom: at(4_999) }, (g: number) => keeps.unread(g) && g < 5_000],
      [{ to: "old@x.test", ...old }, (g: number) => keeps.old(g) && inOld(g)],
      [{ sender: "colleague@x.test", to: "me@own.test", ...old }, (g: number) => keeps.colleague(g) && inOld(g)],
    ] as const) {
      const want = big.plain(keep);
      // Through the cursor to 300 rows, or to its end.
      const got: number[] = [];
      let cursor: string | undefined;
      for (let i = 0; ; i++) {
        if (i === 40) throw new Error(`${JSON.stringify(filters)}: more than 40 pages for ${got.length} rows`);
        const r = await big.svc.search(big.ctx, { q: "", filters, parts: "page", ...(cursor ? { cursor } : {}) });
        got.push(...placesOf(r));
        if (r.nextCursor === null || got.length >= 300) break;
        cursor = r.nextCursor;
      }
      expect({ filters, rows: got }).toEqual({ filters, rows: want.slice(0, Math.max(got.length, Math.min(want.length, 300))) });
      const counted = await big.svc.search(big.ctx, { q: "", filters, parts: "summary" });
      expect({ filters, over: counted.total > want.length, exactButOff: counted.totalExact && counted.total !== want.length })
        .toEqual({ filters, over: false, exactButOff: false });
    }
  }, 300_000);

  it("a walk that asks every letter its recipients asks 20,000 letters a page, as every walk does, and the next page reads on", async () => {
    // One letter in 500 is unread: a page from 20,000 letters holds forty.
    const filters = { to: "me@own.test", unread: true };
    const unreadFrom = (g: number) => Array.from({ length: 40 }, (_, i) => g + 3 + 500 * i);
    const first = await big.svc.search(big.ctx, { q: "", filters, parts: "page" });
    expect(placesOf(first)).toEqual(unreadFrom(0));
    const second = await big.svc.search(big.ctx, { q: "", filters, parts: "page", cursor: first.nextCursor! });
    expect(placesOf(second)).toEqual(unreadFrom(20_000));
    expect(second.nextCursor).not.toBeNull();
  }, 120_000);

  it("every store pages a walk alike: 20,000 letters a page, its cursor through to the end", async () => {
    // To the own address beside a flag, one letter in 500, each page read through the cursor: the
    // device's store walks as many letters a page as the server's, so the pages and cursors are one.
    const unread = big.plain(keeps.unread);
    expect(unread).toHaveLength(120);
    expect(await walkAll({ to: "me@own.test", unread: true })).toEqual([unread.slice(0, 40), unread.slice(40, 80), unread.slice(80, 120), []]);
  }, 120_000);
});
