import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import { mailboxes, messages, messageBodies, folderState } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { SearchService, ServiceError } from "@trafficflow/services";
import type { ServiceContext } from "@trafficflow/services";
import { pgTestUrl } from "@trafficflow/db/testing";
import { brandDialect } from "@trafficflow/db/dialect";

/**
 * ═══ THE ADDRESS ARM ON REAL POSTGRES, ON A DATABASE THIS FILE OWNS ═══════════════════════
 *
 * ── WHY A PRIVATE DATABASE AND NOT THE SHARED `trafficflow_test` ──────────────────────────
 *
 * The shared database is a long-lived accumulator every lane and every previous run has written
 * to, and the assertions here are about ABSENCE: a substring matches NOTHING, another account's
 * mail is NOT returned, a blank From is NOT the empty-address answer. An absence assertion on a
 * shared table is only as strong as the guarantee that nobody else seeded a row that satisfies
 * it — and two `.pg.test.ts` twins poisoning each other through that table is a measured failure
 * in this repository, not a hypothetical. Scoping every read to a fresh account uuid would cover
 * the account cases and NOT the `total` counts, which are what a reader sees.
 *
 * So this file creates its own database, migrates it, and drops it. The EMPTY → MIGRATED
 * transition is asserted rather than assumed: `messages` must not exist before `runMigrations`
 * and must exist after, which is the one check that cannot pass against a database somebody
 * else already prepared. The journal row count is compared against this tree's own
 * `_journal.json`, so a database migrated by a different tree fails here instead of answering
 * a subtly different schema's questions.
 *
 * ── WHAT THIS FILE PROVES THAT PGlite CANNOT ──────────────────────────────────────────────
 *
 * The `from` predicate is `lower(m.from_address) = lower($1)` over `messages_account_from_addr_idx`;
 * `to` is To and Cc through mail 0154's account-keyed expression index (`messages_recipient_keys`),
 * and `any` is the union of the two. There is deliberately NO plan assertion here — the
 * planner sequential-scans a small table whatever indexes exist, so an `EXPLAIN` expectation in
 * a test would either be vacuous or would pin the planner's choice on a fixture size. The
 * measurement that established the index is served (a large table, `EXPLAIN ANALYZE BUFFERS`) is
 * recorded in `SearchService.searchByAddress`'s own header. What this file proves is the
 * SEMANTICS against a real server: the equality, the case folding, the account scope in every
 * direction, and that `from` never reaches the recipient columns.
 */
const BASE = pgTestUrl(import.meta.url);

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

/** This run's own database. The pid keeps two concurrent runs from colliding. */
const DB_NAME = `svc_search_address_${process.pid}`;
const OWN_DB_URL = withDatabase(BASE, DB_NAME);

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;
let db: ReturnType<typeof drizzle> | null = null;
const svc = new SearchService();

const NOW = new Date("2026-07-27T12:00:00.000Z");
const OLDER = new Date("2026-07-26T10:00:00.000Z");
const NEWER = new Date("2026-07-27T10:00:00.000Z");

const A = randomUUID();   // the account under test
const B = randomUUID();   // a second account — must never leak into A's results
const ids: Record<string, string> = {};

function ctx(accountId: string): ServiceContext {
  // `ServiceContext["db"]` is declared as a PGlite handle and this one is postgres-js. The cast
  // is the tree's own idiom rather than a weakening: `context.ts` says in its `DbRegistry`
  // header that the schema type parameter drives the RELATIONAL api (`db.query.<table>`), which
  // "nothing in this repository uses: every service goes through `db.select().from(table)`,
  // where the table object carries its own type" — and `runInTransaction` casts its own handle
  // the same way (`handle as ServiceContext["db"]`). Every pg test in this directory passes a
  // postgres-js handle; none of them compiled it, because these dirs are not typechecked.
  return {
    db: db! as unknown as ServiceContext["db"],
    accountId, userId: null, now: () => NOW, requestId: "search-address-test",
  };
}

/** How many migrations THIS TREE declares for the mail journal. */
function declaredMailMigrations(): number {
  const journal = JSON.parse(
    readFileSync(
      join(__dirname, "..", "..", "db-mail", "drizzle", "meta", "_journal.json"),
      "utf8",
    ),
  ) as { entries: unknown[] };
  return journal.entries.length;
}

async function seedMsg(o: {
  key: string; accountId: string; mailboxId: string; subject: string; from: string;
  to?: Array<{ name: string | null; address: string }>;
  cc?: Array<{ name: string | null; address: string }>;
  date: Date;
}): Promise<void> {
  const [m] = await db!.insert(messages).values({
    accountId: o.accountId, mailboxId: o.mailboxId, bodyHash: "h",
    dedupKey: `addr:${randomUUID()}`, subject: o.subject, fromAddress: o.from,
    date: o.date, unread: false,
    ...(o.to !== undefined ? { toAddresses: o.to } : {}),
    ...(o.cc !== undefined ? { ccAddresses: o.cc } : {}),
    nativeLocator: { folder: "INBOX", ref: "1:1" },
  }).returning();
  await db!.insert(messageBodies).values({ messageId: m!.id, text: o.subject });
  await db!.insert(folderState).values({
    messageId: m!.id, desiredFolder: "INBOX", observedFolder: "INBOX", lastSetBy: "us",
  });
  ids[o.key] = m!.id;
}

describe("GET /search?address= on real Postgres, on a private database", () => {
  beforeAll(async () => {
    admin = postgres(withDatabase(BASE, "postgres"), { connection: { statement_timeout: 0, lock_timeout: 0 }, max: 1, onnotice: () => { /* quiet */ } });

    // An INVALID database (`datconnlimit = -2`) is what a statement timeout during a
    // `DROP DATABASE` leaves behind, and it fails every later run's `beforeAll` with a message
    // that reads as the box being down. Counted here so this file's own teardown can be shown
    // not to have created one.
    const before = await admin`select count(*)::int n from pg_database where datconnlimit = -2`;
    expect(before[0]!.n).toBeGreaterThanOrEqual(0);

    const existing = await admin`select 1 from pg_database where datname = ${DB_NAME}`;
    if (existing.length > 0) await admin.unsafe(`DROP DATABASE "${DB_NAME}" WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE "${DB_NAME}"`);

    // ── THE EMPTY → MIGRATED TRANSITION ──────────────────────────────────────────────────
    //
    // The one assertion that cannot pass against a database somebody else prepared, which is
    // the whole point of making it: if this file were pointed at the shared `trafficflow_test`
    // by a changed environment variable, it would fail HERE rather than quietly measuring a
    // table full of other lanes' rows.
    const probe = postgres(OWN_DB_URL, { max: 1, onnotice: () => { /* quiet */ } });
    const empty = await probe`select to_regclass('public.messages') is not null as present`;
    expect(empty[0]!.present).toBe(false);
    await probe.end({ timeout: 5 });

    await runMigrations(OWN_DB_URL);

    client = postgres(OWN_DB_URL, { max: 5 });
    db = brandDialect(drizzle(client, { schema }), "pg");
    const migrated = await db.execute(sql`select to_regclass('public.messages') is not null as present`);
    expect((migrated as unknown as Array<{ present: boolean }>)[0]!.present).toBe(true);
    // …and it is THIS TREE's schema, not one an older tree left behind.
    const journal = await db.execute(sql`select count(*)::int as n from drizzle_mail.__drizzle_migrations`);
    expect((journal as unknown as Array<{ n: number }>)[0]!.n).toBe(declaredMailMigrations());

    const [mbA] = await db.insert(mailboxes)
      .values({ accountId: A, provider: "imap", address: "a@tf.test" }).returning();
    const [mbB] = await db.insert(mailboxes)
      .values({ accountId: B, provider: "imap", address: "b@tf.test" }).returning();

    // Two from Info, one older — the order is a claim this file checks.
    await seedMsg({ key: "annaOlder", accountId: A, mailboxId: mbA!.id, subject: "First", from: "info@acme.test", date: OLDER });
    await seedMsg({ key: "annaNewer", accountId: A, mailboxId: mbA!.id, subject: "Second", from: "Info@ACME.test", date: NEWER });
    // From somebody else, WITH Info among the recipients. This row is what makes the
    // "recipients are not reached" assertion below mean something.
    await seedMsg({
      key: "toAnna", accountId: A, mailboxId: mbA!.id, subject: "Third", from: "bob@acme.test",
      to: [{ name: null, address: "info@acme.test" }],
      cc: [{ name: null, address: "Info@ACME.test" }],
      date: NEWER,
    });
    // A blank From — a real row, and not the empty-address answer.
    await seedMsg({ key: "headerless", accountId: A, mailboxId: mbA!.id, subject: "Fourth", from: "", date: NEWER });
    // The same address in ANOTHER account.
    await seedMsg({ key: "otherAccount", accountId: B, mailboxId: mbB!.id, subject: "Theirs", from: "info@acme.test", date: NEWER });
    // Info only in Cc, older; and ANOTHER account's mail addressed TO Info (the private-address control).
    await seedMsg({
      key: "ccAnna", accountId: A, mailboxId: mbA!.id, subject: "Fifth", from: "carol@acme.test",
      cc: [{ name: "Info", address: "INFO@acme.test" }], date: OLDER,
    });
    await seedMsg({
      key: "otherAccountTo", accountId: B, mailboxId: mbB!.id, subject: "Theirs to", from: "eve@acme.test",
      to: [{ name: null, address: "info@acme.test" }], date: NEWER,
    });
  }, 120_000);

  afterAll(async () => {
    if (client) await client.end({ timeout: 5 });
    if (admin) {
      // FORCE, because a connection may still be letting go; a drop that waits would leave the
      // database behind and the next run would find a stale schema.
      await admin.unsafe(`DROP DATABASE IF EXISTS "${DB_NAME}" WITH (FORCE)`);
      const gone = await admin`select 1 from pg_database where datname = ${DB_NAME}`;
      expect(gone.length).toBe(0);
      const invalid = await admin`select count(*)::int n from pg_database where datconnlimit = -2 and datname = ${DB_NAME}`;
      expect(invalid[0]!.n).toBe(0);
      await admin.end({ timeout: 5 });
    }
  }, 120_000);

  it("returns every message from the address, newest first, case-folded on both sides", async () => {
    const res = await svc.searchByAddress(ctx(A), { address: "info@acme.test", direction: "from" });
    // The stored spelling of the newer row is `Info@ACME.test`; the asked one is lowercase.
    expect(res.items.map((m) => m.id)).toEqual([ids.annaNewer, ids.annaOlder]);
    expect(res.total).toBe(2);
    expect(res.direction).toBe("from");

    // …and the other way round: an asked spelling with capitals against a stored lowercase one.
    const asked = await svc.searchByAddress(ctx(A), { address: "INFO@ACME.TEST", direction: "from" });
    expect(asked.items.map((m) => m.id)).toEqual([ids.annaNewer, ids.annaOlder]);
  });

  /**
   * THE ROW SHAPE THIS PAGE IS READ IN, pinned because the two stores answer only one of them.
   *
   * `d.exec` answers `unknown[][]` — positional — on the server and on the device alike, which is
   * what let this door leave `db.execute` behind. A `.id` read off a positional row yields
   * `undefined`, `byId.get("undefined")` misses, and the page comes back EMPTY while `total` still
   * counts the same rows. That divergence is the failure mode, so it is asserted as the PAIR:
   * a total above zero with an items list that matches it, and every id a real one.
   */
  it("reads the page positionally, the one shape both stores answer", async () => {
    const res = await svc.searchByAddress(ctx(A), { address: "info@acme.test", direction: "from" });
    expect(res.total).toBeGreaterThan(0);
    expect(res.items).toHaveLength(res.total);
    expect(res.items.every((m) => typeof m.id === "string" && m.id.length > 0)).toBe(true);
    expect(res.items.map((m) => m.id)).toEqual([ids.annaNewer, ids.annaOlder]);
  });

  it("does NOT reach the recipients — a to/cc match is not a from match", async () => {
    // `toAnna` has the address in `to_addresses` AND in `cc_addresses`. This door queries
    // `from_address` alone, and it must not accidentally answer the recipient question
    // partially: an arm that returned this row would be claiming to search recipients while
    // covering only the ones that happen to sit beside an indexed column.
    const res = await svc.searchByAddress(ctx(A), { address: "info@acme.test", direction: "from" });
    expect(res.items.map((m) => m.id)).not.toContain(ids.toAnna);
    expect(res.total).toBe(2);
  });

  it("is an EQUALITY on real Postgres — no substring, prefix or suffix matches", async () => {
    for (const near of [
      "info@acme.tes", "nfo@acme.test", "info", "acme.test",
      "info@acme.test.evil", "%info@acme.test%", "info@acme.te_t",
    ]) {
      const res = await svc.searchByAddress(ctx(A), { address: near, direction: "from" });
      expect(res.items).toHaveLength(0);
      expect(res.total).toBe(0);
    }
  });

  it("is account-scoped — the SAME address in another account is not returned", async () => {
    const mine = await svc.searchByAddress(ctx(A), { address: "info@acme.test", direction: "from" });
    expect(mine.items.map((m) => m.id)).not.toContain(ids.otherAccount);
    expect(mine.total).toBe(2);

    // The positive control from the other side: B's own read finds B's own row and only it.
    const theirs = await svc.searchByAddress(ctx(B), { address: "info@acme.test", direction: "from" });
    expect(theirs.items.map((m) => m.id)).toEqual([ids.otherAccount]);
    expect(theirs.total).toBe(1);
  });

  it("`to` answers To and Cc, case-folded, each message once, never the from-only rows", async () => {
    const res = await svc.searchByAddress(ctx(A), { address: "info@acme.test", direction: "to" });
    // `toAnna` has Info in To AND in Cc: one row. `ccAnna` has Info in Cc only.
    expect(res.items.map((m) => m.id)).toEqual([ids.toAnna, ids.ccAnna]);
    expect(res.total).toBe(2);
    expect(res.direction).toBe("to");
    expect(res.items.map((m) => m.id)).not.toContain(ids.annaNewer);
  });

  it("`any` is the union of the two halves, each message once", async () => {
    const res = await svc.searchByAddress(ctx(A), { address: "INFO@acme.test", direction: "any" });
    const got = res.items.map((m) => m.id);
    expect(new Set(got)).toEqual(new Set([ids.annaNewer, ids.toAnna, ids.annaOlder, ids.ccAnna]));
    expect(got).toHaveLength(4);
    expect(res.total).toBe(4);
    expect(res.direction).toBe("any");
  });

  it("`to` and `any` are account-scoped — another account's mail to the same address never leaks", async () => {
    for (const direction of ["to", "any"] as const) {
      const mine = await svc.searchByAddress(ctx(A), { address: "info@acme.test", direction });
      expect(mine.items.map((m) => m.id)).not.toContain(ids.otherAccountTo);
      expect(mine.items.map((m) => m.id)).not.toContain(ids.otherAccount);
    }
    const theirs = await svc.searchByAddress(ctx(B), { address: "info@acme.test", direction: "to" });
    expect(theirs.items.map((m) => m.id)).toEqual([ids.otherAccountTo]);
    expect(theirs.total).toBe(1);
    const theirsAny = await svc.searchByAddress(ctx(B), { address: "info@acme.test", direction: "any" });
    expect(theirsAny.total).toBe(2);
  });

  it("`to` is an EQUALITY too, and `limit` leaves its total alone", async () => {
    for (const near of ["info@acme.tes", "nfo@acme.test", "acme.test", "%info@acme.test%", "info@acme.te_t"]) {
      const res = await svc.searchByAddress(ctx(A), { address: near, direction: "to" });
      expect(res.items).toHaveLength(0);
      expect(res.total).toBe(0);
    }
    const one = await svc.searchByAddress(ctx(A), { address: "info@acme.test", direction: "to", limit: 1 });
    expect(one.items.map((m) => m.id)).toEqual([ids.toAnna]);
    expect(one.total).toBe(2);
  });

  it("odd recipient entries are stored and matched by nothing; a 254-character address is the bound", async () => {
    const [mb] = await db!.insert(mailboxes).values({ accountId: A, provider: "imap", address: "odd@tf.test" }).returning();
    const long = (n: number) => `${"x".repeat(n - "@acme.test".length)}@acme.test`;
    // A string element, an entry without `address`, and two addresses past the bound: the insert
    // succeeds (no index key is built for them) and no search finds the row by them.
    await seedMsg({
      key: "odd", accountId: A, mailboxId: mb!.id, subject: "Odd", from: "odd@acme.test",
      to: ["info@acme.test", { name: "no address" }, { name: null, address: long(300) }, { name: null, address: long(3000) }] as never,
      cc: [{ name: null, address: long(254) }], date: OLDER,
    });
    expect((await svc.searchByAddress(ctx(A), { address: "info@acme.test", direction: "to" })).items.map((m) => m.id)).not.toContain(ids.odd);
    expect((await svc.searchByAddress(ctx(A), { address: long(300), direction: "to" })).total).toBe(0);
    expect((await svc.searchByAddress(ctx(A), { address: long(3000), direction: "to" })).total).toBe(0);
    const bound = await svc.searchByAddress(ctx(A), { address: long(254).toUpperCase(), direction: "to" });
    expect(bound.items.map((m) => m.id)).toEqual([ids.odd]);
  });

  it("an empty or blank address answers empty — never the blank-From rows", async () => {
    for (const blank of ["", "   ", "\t"]) {
      for (const direction of ["from", "to", "any"] as const) {
        const res = await svc.searchByAddress(ctx(A), { address: blank, direction });
        expect(res.items).toHaveLength(0);
        expect(res.total).toBe(0);
      }
    }
    // The blank-From row exists and is reachable by its own subject through the text search, so
    // the assertion above is about the ADDRESS arm declining it rather than about a missing row.
    const bySubject = await svc.search(ctx(A), { q: "Fourth" });
    expect(bySubject.items.map((m) => m.id)).toContain(ids.headerless);
  });

  it("honours `limit` without changing `total`", async () => {
    const res = await svc.searchByAddress(ctx(A), { address: "info@acme.test", direction: "from", limit: 1 });
    // One row on the page — the newest — and the count still describes the whole archive.
    expect(res.items.map((m) => m.id)).toEqual([ids.annaNewer]);
    expect(res.total).toBe(2);
  });
});
