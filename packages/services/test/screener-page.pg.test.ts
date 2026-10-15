import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { sql } from "drizzle-orm";
import { accounts, mailboxes, messages, folderState } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { ScreenerService, ServiceError, type ServiceContext } from "@trafficflow/services";

/**
 * THE SCREENER'S PAGE, ON REAL POSTGRES.
 *
 * Two defects were reported. The first — representatives sorted by `messages.id`, a
 * `gen_random_uuid()` — was fixed earlier and is guarded in the unit suite; the
 * ordering test here is its keyset-level counterpart. The second was live until this file
 * existed: `list` read EVERY held row in the account (all of a live mailbox's, each
 * carrying `subject` and `snippet`) and did the dedup, the sort, the cursor and the slice in
 * JavaScript.
 *
 * ── WHY THIS IS A CORRECTNESS SUITE AND NOT A PERFORMANCE ONE ─────────────────────────────
 *
 * The Screener is a CONSENT BOUNDARY: it holds mail from people the user has never agreed to
 * hear from, and every row is a question the product owes them. A paging bug that drops a
 * sender is not a scrolling artefact — it is a first-contact stranger nobody is ever asked
 * about, whose mail then sits in `ohmail/Screener` unseen and unanswered. So the assertions
 * below are about EXACTLY-ONCE, not about speed.
 *
 * ── WHY REAL POSTGRES ─────────────────────────────────────────────────────────────────────
 *
 * The page is now decided by the database: `DISTINCT ON` picks the representative, a row-value
 * comparison applies the keyset, and `LIMIT` bounds the read. Every one of those is a claim
 * about Postgres' own ordering — `uuid` compared as 16 bytes rather than as a JS string,
 * `timestamptz` truncated to the millisecond the cursor can carry, and NULL dates coalesced to
 * the arrival instead of sorting FIRST as a bare `DESC` would put them. None of that is exercised
 * by asserting on a JavaScript array.
 *
 * ── SCOPING ───────────────────────────────────────────────────────────────────────────────
 *
 * Every write here is INSERT-only and carries a freshly generated `account_id`. There is no
 * UPDATE and no DELETE in this file, so nothing it does is visible to another test sharing this
 * database.
 */
const PG_UP = await realPgAvailable();

let client: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

/** Every statement the driver actually sent, captured for the boundedness assertion. */
let statements: string[] = [];

const ctx = (accountId: string): ServiceContext => ({
  db: db as unknown as ServiceContext["db"],
  accountId,
  userId: null,
  now: () => new Date(),
  requestId: `w3-pg-${randomUUID().slice(0, 8)}`,
});

const BASE = Date.parse("2026-06-01T12:00:00.000Z");
const DAY = 86_400_000;

interface Seeded {
  accountId: string;
  /** `lower(from_address)` → the date its REPRESENTATIVE (newest held message) carries. */
  expected: Map<string, number | null>;
}

/**
 * One account, `senders` held first-contact senders, and the awkward cases on purpose.
 *
 * `tieAt`/`tieCount` put a block of senders on the EXACT same `date`, positioned to straddle a
 * page boundary — the case a cursor without the `id` tiebreak loses silently, because every
 * remaining member of the block compares equal to the cursor's date and satisfies neither
 * `date < cursor` nor the page before it.
 */
async function seed(opts: {
  senders: number;
  tieAt: number;
  tieCount: number;
  /** A sender with several held messages — proves the page returns ONE row for them. */
  multiMessageSender?: boolean;
  /** A sender whose mail carries no `Date:` header at all. */
  undatedSender?: boolean;
  /** When that undated mail ARRIVED — its sort position. Default: older than every dated sender. */
  undatedArrival?: number;
}): Promise<Seeded> {
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `w3-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `w3-${accountId.slice(0, 8)}@example.test`,
  }).returning();

  let n = 0;
  const held = async (from: string, date: Date | null, desired = "ohmail/Screener", arrived?: Date) => {
    const i = n++;
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: `h${i}`, dedupKey: `w3:${randomUUID()}`,
      subject: `Note ${i}`, snippet: `snippet ${i}`, fromAddress: from, date,
      ...(arrived ? { createdAt: arrived } : {}),
      nativeLocator: { folder: desired, ref: `1:${i}` },
    }).returning();
    await db.insert(folderState).values({
      messageId: m!.id, desiredFolder: desired, observedFolder: "ohmail/Screener",
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    });
    return m!.id;
  };

  const expected = new Map<string, number | null>();
  for (let s = 0; s < opts.senders; s += 1) {
    // Strictly descending by index, EXCEPT inside the tie block, where every sender shares one
    // instant. Mixed capitalisation because the queue is keyed on `lower(from_address)`.
    const inTie = s >= opts.tieAt && s < opts.tieAt + opts.tieCount;
    const t = BASE - (inTie ? opts.tieAt : s) * DAY;
    const from = s % 4 === 0 ? `S${s}@Ex.test` : `s${s}@ex.test`;
    await held(from, new Date(t));
    expected.set(from.toLowerCase(), t);
  }

  if (opts.multiMessageSender) {
    // Three held messages, seeded OLDEST first so "the newest represents" cannot pass by
    // accident on insertion order. Its date sits between two ordinary senders.
    const from = "chatty@ex.test";
    const newest = BASE - 3 * DAY - 3_600_000;
    await held(from, new Date(newest - 2 * DAY));
    await held(from, new Date(newest - DAY));
    await held(from, new Date(newest));
    expected.set(from, newest);
  }

  if (opts.undatedSender) {
    // No `Date:` header — a field the SENDER controls. It sorts at its ARRIVAL, which nobody
    // outside can set (never at the top by omission, never at 1970), and it must still page.
    const arrival = opts.undatedArrival ?? BASE - 40 * DAY;
    await held("undated@ex.test", null, "ohmail/Screener", new Date(arrival));
    expected.set("undated@ex.test", null);
  }

  // ── CONTROLS, none of which may ever appear on a page ──────────────────────────────────
  // Already let through: desired folder is not the Screener.
  await held("known@ex.test", new Date(BASE), "INBOX");
  // Already screened out.
  await held("rejected@ex.test", new Date(BASE), "ohmail/Screened");

  return { accountId, expected };
}

/** Walk the cursor to exhaustion. Returns every page, in order. */
async function walk(svc: ScreenerService, c: ServiceContext, limit: number) {
  const pages: Array<{ senders: string[]; messageIds: string[]; dates: Array<string | null> }> = [];
  let cursor: string | null = null;
  // A hard stop, so a cursor that fails to advance fails the test instead of hanging CI.
  for (let guard = 0; guard < 200; guard += 1) {
    const page: Awaited<ReturnType<ScreenerService["list"]>> =
      await svc.list(c, cursor ? { limit, cursor } : { limit });
    pages.push({
      senders: page.items.map((i) => i.sender.address.toLowerCase()),
      messageIds: page.items.map((i) => i.messageId),
      dates: page.items.map((i) => i.receivedAt),
    });
    if (!page.nextCursor) return pages;
    cursor = page.nextCursor;
  }
  throw new Error("cursor never terminated");
}

/** The senders genuinely held for this account, asked of the database directly. */
async function heldSendersInDb(accountId: string): Promise<string[]> {
  const rows = await db.execute<{ sender: string }>(sql`
    select distinct lower(m.from_address) as sender
    from ${messages} m
    join ${folderState} fs on fs.message_id = m.id
    where m.account_id = ${accountId} and fs.desired_folder = 'ohmail/Screener'
  `);
  return [...rows].map((r) => r.sender).sort();
}

describe.skipIf(!PG_UP)("the Screener pages exactly once, on real Postgres", () => {
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    client = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(client, {
      schema,
      logger: { logQuery: (q) => { statements.push(q); } },
    }), "pg");
  }, 120_000);
  afterAll(async () => { await client?.end({ timeout: 5 }); });

  /**
   * ── THE ONE THAT MATTERS: EVERY HELD SENDER IS ASKED ABOUT, EXACTLY ONCE ────────────────
   *
   * 24 senders, of which EIGHT share one instant, placed at index 4 so the block straddles the
   * page boundaries at 5 and 10 with a page size of 5. Plus a sender with three held messages
   * and a sender with no date at all.
   *
   * MUTATION THIS CATCHES: delete the `id` half of the keyset in `heldSenderPage` — leaving
   * `sort_key < $cursorTime` — and the walk loses THREE of the eight tied senders. They are not
   * reordered; they are never returned at all, which on this surface means three strangers the
   * user is never asked about.
   *
   * Three and not eight, because the loss is only as large as the part of the block that falls
   * BELOW a cursor that landed inside it. Measured, and re-derivable from the fixture: the order
   * is s0..s3, then `chatty` (its date sits between s3 and s4), then the eight tied senders. So
   * page 1 ends on `chatty`, whose date is unique and therefore harmless; page 2 is the first
   * five of the block and ends ON the shared instant; and a date-only `<` then excludes every
   * remaining member of that block — the last three. The number is stated because a mutation
   * whose documented damage is larger than its real damage invites the next reader to weaken the
   * fixture and still believe the guard is working.
   */
  it("walks the whole queue exactly once, across a page boundary buried in a date tie", async () => {
    const w = await seed({ senders: 24, tieAt: 4, tieCount: 8, multiMessageSender: true, undatedSender: true });
    const svc = new ScreenerService({});
    const pages = await walk(svc, ctx(w.accountId), 5);

    const seen = pages.flatMap((p) => p.senders);

    // NO REPEATS — a sender asked about twice is a duplicated consent question.
    expect(new Set(seen).size).toBe(seen.length);
    // NO SKIPS — and the reference set is the DATABASE's, not this test's bookkeeping, so a
    // seeding mistake cannot make the assertion agree with a broken page.
    expect([...seen].sort()).toEqual(await heldSendersInDb(w.accountId));
    // …which is every sender the fixture intended, and neither control.
    expect(new Set(seen)).toEqual(new Set(w.expected.keys()));
    expect(seen).not.toContain("known@ex.test");
    expect(seen).not.toContain("rejected@ex.test");

    // ONE row per sender even though `chatty@ex.test` holds three messages.
    expect(seen).toHaveLength(26);
    expect(seen.filter((s) => s === "chatty@ex.test")).toHaveLength(1);

    // Every page is full except the last: a keyset that returns short pages early is skipping.
    for (const p of pages.slice(0, -1)) expect(p.senders).toHaveLength(5);
  });

  /**
   * ── THE ORDER IS THE DATE, NOT THE UUID ─────────────────────────────────────────────────
   *
   * The original defect: representatives were sorted by `messages.id`, which is random, so the
   * queue jumped between years — "the screener shows some mails, and then after some messages
   * directly goes to 2025". The dates here are strictly descending by index and the ids are
   * random, so an id ordering disagrees with this assertion with probability 1 − 1/24!.
   *
   * MUTATION THIS CATCHES: order the `DISTINCT ON` sub-select's outer query by `id DESC` alone
   * and this fails on the very first page.
   */
  it("orders by date descending — and puts UNDATED mail at its arrival, never first or last", async () => {
    // Arrived between s5 and s6: the header's absence neither lifts it nor sinks it.
    const w = await seed({ senders: 24, tieAt: 99, tieCount: 0, undatedSender: true, undatedArrival: BASE - 5.5 * DAY });
    const svc = new ScreenerService({});
    const pages = await walk(svc, ctx(w.accountId), 7);
    const senders = pages.flatMap((p) => p.senders);
    const dates = pages.flatMap((p) => p.dates);

    // Every row, undated included, in the order the queue presented it, strictly descending:
    // `receivedAt` is the instant the row sorted by — the header, else the arrival.
    const times = dates.map((d) => Date.parse(d!));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    expect(new Set(times).size).toBe(times.length);   // no tie block — a total order

    // `date DESC` in Postgres is NULLS FIRST, which would hand the top of the queue to anyone who
    // drops a header; the epoch would sink a sender the cutline admits. It sits at its arrival.
    expect(senders[0]).toBe("s0@ex.test");
    expect(senders.indexOf("undated@ex.test")).toBe(senders.indexOf("s5@ex.test") + 1);
    expect(senders[senders.length - 1]).not.toBe("undated@ex.test");
  });

  /**
   * ── THE REPRESENTATIVE IS THE SENDER'S NEWEST HELD MESSAGE ──────────────────────────────
   *
   * The point the slice must not change: moving the dedup from JavaScript into `DISTINCT ON`
   * changes HOW MANY rows are fetched, never WHICH sender is represented or BY WHICH message.
   * Both halves are checked against the database's own answer.
   */
  it("represents each sender by their newest held message — the same set, computed independently", async () => {
    const w = await seed({ senders: 12, tieAt: 3, tieCount: 4, multiMessageSender: true, undatedSender: true });
    const svc = new ScreenerService({});
    const pages = await walk(svc, ctx(w.accountId), 4);

    const byId = new Map<string, string>();
    for (const p of pages) p.senders.forEach((s, i) => byId.set(s, p.messageIds[i]!));

    const truth = await db.execute<{ sender: string; message_id: string }>(sql`
      select distinct on (lower(m.from_address))
             lower(m.from_address) as sender, m.id as message_id
      from ${messages} m
      join ${folderState} fs on fs.message_id = m.id
      where m.account_id = ${w.accountId} and fs.desired_folder = 'ohmail/Screener'
      order by lower(m.from_address),
               date_trunc('milliseconds', coalesce(m.date, m.created_at)) desc, m.id desc
    `);

    expect(byId.size).toBe([...truth].length);
    for (const row of truth) expect(byId.get(row.sender)).toBe(row.message_id);
  });

  /**
   * ── THE READ IS BOUNDED ─────────────────────────────────────────────────────────────────
   *
   * The defect this slice exists for: `list` issued a `select … from messages join folder_state
   * where desired_folder = 'ohmail/Screener'` with NO limit, so asking for 5 senders fetched
   * every held row in the account — `subject` and `snippet` included — over the wire.
   *
   * The assertion is on the SQL the driver actually sent, because that is where the defect
   * lives: a JavaScript `.slice(0, limit)` returns exactly the right answer while doing exactly
   * the wrong thing, so no assertion on the RESULT can see it.
   *
   * MUTATION THIS CATCHES: restore `const rows = await this.heldRows(ctx)` in `list` and the
   * held-row statement it issues carries no `limit` at all.
   */
  it("fetches a bounded page, not the whole held set", async () => {
    const w = await seed({ senders: 40, tieAt: 10, tieCount: 6, multiMessageSender: true });
    const svc = new ScreenerService({});

    statements = [];
    const page = await svc.list(ctx(w.accountId), { limit: 5 });
    expect(page.items).toHaveLength(5);

    // Every statement that reads held mail is bounded. `from_address` identifies the queue read
    // and excludes the `routing_decisions` lookup for stored suggestions, which is bounded by
    // the page's own id list. The first page's `total` rides the page itself, a window over the
    // filtered queue computed before the LIMIT: no second statement re-reads the held set.
    const isCount = (q: string) => /^select count\(\*\) from \(/i.test(q.trim());
    const held = statements.filter((q) => /from_address/i.test(q) && /desired_folder/i.test(q));
    expect(held.filter(isCount), "the first page states its total without a second read").toHaveLength(0);
    expect(held.filter((q) => /\bover \(\)/i.test(q)), "the total is the page's own window").toHaveLength(1);
    const heldReads = held.filter((q) => !isCount(q));
    expect(heldReads.length).toBeGreaterThan(0);
    for (const q of heldReads) expect(q.toLowerCase()).toMatch(/\blimit\b/);

    // And the bound is the page, not some larger constant: `limit + 1`, the extra row being how
    // `nextCursor` is decided without a second query.
    expect(heldReads.some((q) => /limit\s+\$?\d+/i.test(q))).toBe(true);
  });

  /**
   * ── THE PURCHASE'S READ IS BOUNDED TOO ──────────────────────────────────────────────────
   *
   * `list` was bounded in the slice above; `suggest` was not. It read the whole held bag for the
   * senders it was given, every row carrying its `subject` and `snippet`, and folded it to one
   * per sender in JavaScript — so a sender with a long history at the gate cost a row each to buy
   * advice about one. Seeded ABOVE one page, and asserted on the SQL the driver sent: a fold
   * returns exactly the right answer while doing exactly the wrong thing, so no assertion on the
   * RESULT can see it. MUTATION: drop `.where(eq(reps.rank, 1))` from `suggest`'s read.
   */
  it("buys one row per named sender, not that sender's whole held bag", async () => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `w3-bound-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `w3-bound-${accountId.slice(0, 8)}@example.test`,
    }).returning();

    const FROM = "flood@ex.test";
    const HELD = 40;
    const ids: string[] = [];
    for (let k = 0; k < HELD; k += 1) {
      const [m] = await db.insert(messages).values({
        accountId, mailboxId: mb!.id, bodyHash: `bh${k}`, dedupKey: `w3bound:${randomUUID()}`,
        subject: `Note ${k}`, snippet: `snippet ${k}`, fromAddress: FROM,
        date: new Date(BASE - k * DAY),
        nativeLocator: { folder: "ohmail/Screener", ref: `1:${k}` },
      }).returning();
      await db.insert(folderState).values({
        messageId: m!.id, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
        lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
      });
      ids.push(m!.id);
    }

    const asked: string[] = [];
    const svc = new ScreenerService({
      classifier: {
        classify: async (input) => {
          asked.push(input.subject);
          return { destination: "INBOX" as const, confidence: 0.9, rationale: "ok", spam: false };
        },
      },
    });

    statements = [];
    const bought = await svc.suggest(ctx(accountId), { senders: [FROM] });

    // THE READ ITSELF. The statement that reads held mail is the windowed one, and the window is
    // what bounds it: `rank = 1` returns one row per sender whatever the bag holds.
    const heldReads = statements.filter(
      (q) => /from_address/i.test(q) && /desired_folder/i.test(q),
    );
    expect(heldReads.length, "no held read was captured — the assertion would be vacuous")
      .toBeGreaterThan(0);
    for (const q of heldReads) {
      const lower = q.toLowerCase();
      // The window CHOOSES the representative…
      expect(lower, "a held read with no per-sender window").toMatch(/row_number\(\)\s*over/);
      expect(lower).toMatch(/partition by/);
      // …and the rank predicate is what BOUNDS it. Both, because either alone passes under the
      // other's mutation: the window survives a dropped filter, and a filter is meaningless
      // without it.
      expect(lower, "the window is read without its rank filter").toMatch(/"rank"\s*=/);
    }
    // One sender named, one suggestion bought, one model call — never one per held message.
    expect(bought.suggestions).toHaveLength(1);
    expect(asked).toHaveLength(1);
    // …about the NEWEST held message, which is the one the page prices.
    expect(bought.suggestions[0]!.messageId).toBe(ids[0]);

    // And the fixture really is bigger than one page, or the bound is proving nothing.
    expect(HELD).toBeGreaterThan(10);
    const [{ n }] = await db.execute<{ n: number }>(sql`
      select count(*)::int as n from ${messages} m
      join ${folderState} fs on fs.message_id = m.id
      where m.account_id = ${accountId} and fs.desired_folder = 'ohmail/Screener'
    `);
    expect(n).toBe(HELD);
  });

  /**
   * The account leads the key (the "Account isolation is absolute, and it binds staff too" invariant). Another account's held mail is not filtered out of a
   * cross-account result — it is never in one.
   */
  it("never reaches another account's queue", async () => {
    const mine = await seed({ senders: 6, tieAt: 2, tieCount: 3 });
    const theirs = await seed({ senders: 6, tieAt: 2, tieCount: 3 });
    const svc = new ScreenerService({});

    const seen = (await walk(svc, ctx(mine.accountId), 4)).flatMap((p) => p.senders);
    expect([...seen].sort()).toEqual(await heldSendersInDb(mine.accountId));
    for (const s of theirs.expected.keys()) {
      if (!mine.expected.has(s)) expect(seen).not.toContain(s);
    }
  });

  /**
   * ── THE PAGE PRICES THE MESSAGE THE PURCHASE BUYS ───────────────────────────────────────
   *
   * This is the path that SPENDS: if the page and the purchase name different messages, a person
   * is charged for advice about a message that is not the one on screen. THE COLLISION IS SEEDED,
   * NOT HOPED FOR — four senders, SIX held messages each, every one on the EXACT same
   * `timestamptz`. Without a tie there is nothing to test: a total order agrees with itself
   * however it is computed. MUTATION: `${messages.id} desc` to `asc` in `heldSenderReps`.
   */
  it("buys the same representative the page priced, at a date shared by every message", async () => {
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: `w3-rep-${accountId.slice(0, 8)}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `w3-rep-${accountId.slice(0, 8)}@example.test`,
    }).returning();

    const SENDERS = ["batch-a@ex.test", "batch-b@ex.test", "batch-c@ex.test", "batch-d@ex.test"];
    let n = 0;
    for (const [s, from] of SENDERS.entries()) {
      // One instant per sender, shared by all six of that sender's messages. Distinct BETWEEN
      // senders so the page order itself is total and the test is about the tie WITHIN a sender.
      const at = new Date(BASE - s * DAY);
      for (let k = 0; k < 6; k += 1) {
        const i = n++;
        const [m] = await db.insert(messages).values({
          accountId, mailboxId: mb!.id, bodyHash: `rh${i}`, dedupKey: `w3rep:${randomUUID()}`,
          subject: `Note ${k}`, snippet: `snippet ${k}`, fromAddress: from, date: at,
          nativeLocator: { folder: "ohmail/Screener", ref: `1:${i}` },
        }).returning();
        await db.insert(folderState).values({
          messageId: m!.id, desiredFolder: "ohmail/Screener", observedFolder: "ohmail/Screener",
          lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
        });
      }
    }

    // A classifier that spends nothing and decides nothing interesting. The verdict is
    // irrelevant to this test; WHICH MESSAGE it was asked about is the whole of it.
    const asked: string[] = [];
    const svc = new ScreenerService({
      classifier: {
        classify: async (input) => {
          asked.push(input.subject);
          return { destination: "INBOX" as const, confidence: 0.9, rationale: "ok", spam: false };
        },
      },
    });
    const c = ctx(accountId);

    // 1. What the PAGE presents, and therefore what its `suggestable` quote is about.
    const page = await svc.list(c, { limit: 10 });
    const priced = new Map(page.items.map((i) => [i.sender.address.toLowerCase(), i.messageId]));
    expect([...priced.keys()].sort()).toEqual([...SENDERS].sort());
    expect(page.suggestable.senders.sort()).toEqual([...SENDERS].sort());

    // 2. What the PURCHASE actually bought.
    const bought = await svc.suggest(c, { senders: SENDERS });
    expect(bought.suggestions).toHaveLength(SENDERS.length);
    expect(bought.skipped).toEqual([]);

    // 3. They are the same message — asserted per sender so a failure names which one.
    for (const s of bought.suggestions) {
      expect(s.messageId, `sender ${s.sender}: bought a message the page did not price`)
        .toBe(priced.get(s.sender));
    }

    // 4. …and BOTH agree with the database's own answer, so a shared bug in the two code paths
    //    cannot make this test pass by having them agree with each other and with nothing else.
    const truth = await db.execute<{ sender: string; message_id: string }>(sql`
      select distinct on (lower(m.from_address))
             lower(m.from_address) as sender, m.id as message_id
      from ${messages} m
      join ${folderState} fs on fs.message_id = m.id
      where m.account_id = ${accountId} and fs.desired_folder = 'ohmail/Screener'
      order by lower(m.from_address),
               date_trunc('milliseconds', coalesce(m.date, m.created_at)) desc, m.id desc
    `);
    const truthById = new Map([...truth].map((r) => [r.sender, r.message_id]));
    expect(truthById.size).toBe(SENDERS.length);
    for (const [sender, id] of truthById) expect(priced.get(sender)).toBe(id);

    // The model was asked once per sender and never once per held message: six-for-one here
    // would be five unnecessary third-party disclosures and five unnecessary charges.
    expect(asked).toHaveLength(SENDERS.length);
  });

  /**
   * A corrupt cursor is a 400, not a 500.
   *
   * While the keyset was applied in JavaScript this could not fail: a non-numeric time compared
   * false and any string compared as a string. The predicate now binds `::timestamptz` and
   * `::uuid`, where the same input is a Postgres cast error — a 500 caused by a value the caller
   * controls. Named here because the fix that introduced the exposure is the fix in this slice.
   */
  it("refuses a malformed cursor with a 400 rather than failing the query", async () => {
    const w = await seed({ senders: 3, tieAt: 9, tieCount: 0 });
    const svc = new ScreenerService({});
    const c = ctx(w.accountId);

    for (const bad of ["not-base64-at-all", Buffer.from("abc:def").toString("base64url"),
      Buffer.from(`${Date.now()}:not-a-uuid`).toString("base64url")]) {
      // `httpStatus`, asserted on the caught error rather than via `toMatchObject`, which
      // compares only `message` on an Error subclass and would pass on any thrown error.
      const err = await svc.list(c, { limit: 2, cursor: bad }).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(ServiceError);
      expect((err as ServiceError).httpStatus).toBe(400);
      expect((err as ServiceError).code).toBe("validation_failed");
    }
  });
});
