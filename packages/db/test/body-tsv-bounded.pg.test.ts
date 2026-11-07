import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { inArray } from "drizzle-orm";
import { MAIL_MIGRATIONS_DIR } from "@ohmail/db-mail";
import { BodyVectorLockTimeout, retireBodyVector, runMigrations } from "../src/admin.js";
import {
  MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, PG_TEST_URL, realPgAvailable, throwawayDb,
} from "../src/testing.js";
import { brandDialect } from "../src/dialect/index.js";
import { accounts, accountSettings, mailboxes, messages, messageBodies } from "../src/schema-mail.js";

/**
 * THE BODY VECTOR IS BOUNDED AND THE BODY IS NOT (mail 0140), on real Postgres. A body is found by
 * its first stretch of characters and stored whole past them; the densest vector the bound admits is
 * printed against the 1 MiB tsvector ceiling; a withheld body's vector empties; DROP EXPRESSION
 * keeps the table's storage; and the migration's statements repeat.
 */
const PG_UP = await realPgAvailable();
const BOUND = 65_536;
const TSVECTOR_MAX = 1_048_575;
const client = postgres(PG_TEST_URL, { max: 3, onnotice: () => {} });
const db = brandDialect(drizzle(client), "pg");
const created: string[] = [];

beforeAll(async () => { if (PG_UP) await runMigrations(PG_TEST_URL); }, 180_000);
afterAll(async () => {
  if (PG_UP && created.length > 0) {
    const msgs = db.select({ id: messages.id }).from(messages).where(inArray(messages.accountId, created));
    await db.delete(messageBodies).where(inArray(messageBodies.messageId, msgs));
    await db.delete(messages).where(inArray(messages.accountId, created));
    await db.delete(mailboxes).where(inArray(mailboxes.accountId, created));
    await db.delete(accounts).where(inArray(accounts.id, created));
  }
  await client.end({ timeout: 5 });
});

/** One message whose stored body is `text`; returns its id. */
async function stored(text: string): Promise<string> {
  const accountId = randomUUID();
  created.push(accountId);
  await db.insert(accounts).values({ id: accountId, name: `tsv-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `${accountId.slice(0, 8)}@x.test`,
  }).returning();
  const [m] = await db.insert(messages).values({
    accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `${accountId}:0`, subject: "s", date: new Date(),
  }).returning();
  await db.insert(messageBodies).values({ messageId: m!.id, text, html: null, headers: {} });
  return m!.id;
}

/** `bytes` is the vector UNCOMPRESSED (a concatenation rebuilds it): the ceiling's own measure. */
type Vector = { chars: number; lexemes: number; bytes: number };
const vectorOf = async (id: string): Promise<Vector> => {
  const [r] = await client<{ chars: number; lexemes: number; bytes: number }[]>`
    select char_length(text) as chars, length(body_tsv) as lexemes,
           pg_column_size(body_tsv || ''::tsvector) as bytes
      from message_bodies where message_id = ${id}`;
  return { chars: Number(r!.chars), lexemes: Number(r!.lexemes), bytes: Number(r!.bytes) };
};
const finds = async (id: string, word: string): Promise<boolean> => {
  const [r] = await client<{ hit: boolean }[]>`
    select body_tsv @@ plainto_tsquery('english', ${word}) as hit from message_bodies where message_id = ${id}`;
  return r!.hit;
};

/** `n` distinct ideographs from `first`, one code point each (extension B: all assigned, 4 bytes). */
function ideographs(n: number, first: number): string[] {
  return Array.from({ length: n }, (_, i) => String.fromCodePoint(first + i));
}

/** `prefix0x prefix1x …` to at least `chars` characters, distinct words. */
function distinctWords(prefix: string, chars: number): string {
  const words: string[] = []; let len = 0;
  for (let n = 0; len < chars; n++) { const w = `${prefix}${n.toString(36)}x`; words.push(w); len += w.length + 1; }
  return words.join(" ");
}

describe.skipIf(!PG_UP)("message_bodies.body_tsv is kept over the first 65,536 characters", () => {
  it("finds a word inside the bound, not one past it, and stores the text whole", async () => {
    const text = `${"x ".repeat(30_000)}insideword ${"x ".repeat(5_000)}pastword`;
    const id = await stored(text);
    expect((await vectorOf(id)).chars).toBe(text.length);
    expect([await finds(id, "insideword"), await finds(id, "pastword")]).toEqual([true, false]);
  });

  it("stores a 2 MiB body of distinct words whole — the shape that overflowed the vector", async () => {
    const text = distinctWords("b", 2 * 1024 * 1024);
    const id = await stored(text);
    const v = await vectorOf(id);
    expect(v.chars).toBe(text.length);
    expect(v.bytes).toBeLessThan(TSVECTOR_MAX);
  });

  // One lexeme per two characters, and the densest measured: a hyphenated pair is three lexemes
  // (the pair and both halves) per four characters, at four bytes a character.
  it.each([
    ["single ideographs", () => ideographs(BOUND / 2, 0x20000).join(" "), BOUND / 2],
    ["hyphenated pairs of 4-byte ideographs", () => {
      const cs = ideographs(BOUND / 2, 0x20000);
      const pairs: string[] = [];
      for (let i = 0; i + 1 < cs.length; i += 2) pairs.push(`${cs[i]}-${cs[i + 1]}`);
      return pairs.join(" ");
    }, (BOUND / 4) * 3],
  ] as const)("keeps the densest vector the bound admits under the ceiling: %s", async (shape, build, lexemes) => {
    const text = build();
    expect([...text].length).toBeLessThanOrEqual(BOUND);
    const v = await vectorOf(await stored(text));
    console.log(`WORST ${shape}: ${v.lexemes} lexemes, ${v.bytes} bytes, ceiling/size ${(TSVECTOR_MAX / v.bytes).toFixed(2)}`);
    expect(v.lexemes).toBe(lexemes);
    expect(v.bytes).toBeLessThan(TSVECTOR_MAX);
  });

  it("empties the vector when the text is withheld, as the generated column did", async () => {
    const id = await stored("a body about lighthouses");
    expect(await finds(id, "lighthouses")).toBe(true);
    await client`update message_bodies set text = '' where message_id = ${id}`;
    expect((await vectorOf(id)).lexemes).toBe(0);
  });

  it("keeps the table's storage across DROP EXPRESSION, the shape 0140 runs on", async () => {
    // A temporary twin of the pre-0140 column: the statement is catalog-only, so the relation's
    // file does not change and every stored vector stays where it was.
    await client.begin(async (tx) => {
      await tx`create temp table tsv_twin (text text not null default '',
        body_tsv tsvector generated always as (to_tsvector('english', coalesce(text, ''))) stored) on commit drop`;
      await tx`create index on tsv_twin using gin (body_tsv)`;
      await tx`insert into tsv_twin (text) select 'word' || g || ' other' || g from generate_series(1, 2000) g`;
      const [before] = await tx<{ f: number }[]>`select pg_relation_filenode('tsv_twin') as f`;
      await tx`alter table tsv_twin alter column body_tsv drop expression if exists`;
      await tx`alter table tsv_twin alter column body_tsv drop expression if exists`;
      const [after] = await tx<{ f: number }[]>`select pg_relation_filenode('tsv_twin') as f`;
      const [kept] = await tx<{ n: number }[]>`select count(*)::int as n from tsv_twin where body_tsv @@ 'word7'::tsquery`;
      expect([after!.f, kept!.n]).toEqual([before!.f, 1]);
    });
  });

  it("runs 0140's statements a second time without error and leaves the same objects", async () => {
    const file = readFileSync(join(MAIL_MIGRATIONS_DIR, "0140_body_tsv_bounded.sql"), "utf8");
    const statements = file.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    expect(statements).toHaveLength(6);
    await client.begin(async (tx) => { for (const s of statements) await tx.unsafe(s); });
    const [t] = await client<{ n: number }[]>`select count(*)::int as n from pg_trigger
      where tgname = 'message_bodies_body_tsv_tg' and tgrelid = 'message_bodies'::regclass`;
    const [c] = await client<{ d: string }[]>`select pg_get_constraintdef(oid) as d from pg_constraint
      where conname = 'message_failures_code_closed'`;
    expect([t!.n, c!.d.includes("data_too_large")]).toEqual([1, true]);
  });
});

/**
 * THE SERVER RETIRES THE BODY VECTOR (`retireBodyVector`, run by the server's setup only). On a
 * database of its own: the step re-points a trigger every other file's seeding relies on.
 */
const ownDb = throwawayDb("trafficflow_body_vector");
const own = postgres(ownDb.url, { max: 3, onnotice: () => {} });
const ownOrm = brandDialect(drizzle(own), "pg");
/* The step runs on one session, as the setup's: it sets and resets lock_timeout on it. */
const step = postgres(ownDb.url, { max: 1, onnotice: () => {} });
const stepDb = brandDialect(drizzle(step), "pg");

describe.skipIf(!PG_UP)("the server's setup retires the old body vector", () => {
  beforeAll(async () => { await ownDb.createFromTemplate(); }, MIGRATED_DB_SETUP_BUDGET_MS);
  afterAll(async () => {
    await Promise.all([own.end({ timeout: 5 }), step.end({ timeout: 5 })]);
    await ownDb.drop();
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  /** An account with one living letter whose body is `text`; `built` writes its search marker. */
  async function letter(text: string, built: boolean): Promise<{ accountId: string; id: string }> {
    const accountId = randomUUID();
    await ownOrm.insert(accounts).values({ id: accountId, name: `bv-${accountId.slice(0, 8)}` });
    const [mb] = await ownOrm.insert(mailboxes).values({ accountId, provider: "imap", address: `${accountId.slice(0, 8)}@x.test` }).returning();
    const [m] = await ownOrm.insert(messages).values({
      accountId, mailboxId: mb!.id, bodyHash: "h", dedupKey: `${accountId}:0`, subject: "s", date: new Date(),
    }).returning();
    await ownOrm.insert(messageBodies).values({ messageId: m!.id, text, html: null, headers: {} });
    if (built) await mark(accountId);
    return { accountId, id: m!.id };
  }
  const mark = (accountId: string) => ownOrm.insert(accountSettings).values({ accountId, searchIndexBuiltAt: new Date() })
    .onConflictDoUpdate({ target: accountSettings.accountId, set: { searchIndexBuiltAt: new Date() } });
  const vector = async (id: string): Promise<string | null> =>
    (await own<{ v: string | null }[]>`select body_tsv::text as v from message_bodies where message_id = ${id}`)[0]!.v;
  const runs = async (): Promise<string | null> => (await own<{ f: string }[]>`select p.proname as f from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid where t.tgname = 'message_bodies_body_tsv_tg' and t.tgrelid = 'message_bodies'::regclass`)[0]?.f ?? null;
  const index = async (): Promise<boolean | null> =>
    (await own<{ valid: boolean }[]>`select indisvalid as valid from pg_index where indexrelid = to_regclass('public.message_bodies_body_tsv_idx')`)[0]?.valid ?? null;
  /** 0140's state again: the bounded trigger and a valid index. */
  const bounded = async () => {
    await own`create or replace trigger message_bodies_body_tsv_tg before insert or update of "text" on message_bodies
      for each row execute function message_bodies_body_tsv_bounded()`;
    await own`create index if not exists message_bodies_body_tsv_idx on message_bodies using gin (body_tsv)`;
  };
  const retire = (o: Parameters<typeof retireBodyVector>[1] = {}) => retireBodyVector(stepDb, { concurrently: false, ...o });

  it("keeps the index while one account is owed, drops it once that account is built, and clears new and changed bodies", async () => {
    const old = await letter("an old letter about lighthouses", true);
    const owed = await letter("an owed letter about harbours", false);
    expect(await vector(old.id)).toContain("lighthous");

    expect(await retire()).toEqual({ trigger: "cleared", gin: "kept", owedAccounts: 1 });
    expect([await runs(), await index()]).toEqual(["message_bodies_body_tsv_cleared", true]);
    const fresh = await letter("a new letter about lighthouses", true);
    expect(await vector(fresh.id)).toBeNull();
    expect(await vector(old.id), "an old row keeps its vector until its text changes").toContain("lighthous");
    const [hit] = await own<{ n: number }[]>`select count(*)::int as n from message_bodies where body_tsv @@ plainto_tsquery('english', 'harbours')`;
    expect(hit!.n, "the owed account still finds its old body by the vector").toBe(1);

    await own`update message_bodies set text = 'a changed letter' where message_id = ${old.id}`;
    expect(await vector(old.id)).toBeNull();

    await mark(owed.accountId);
    expect(await retire()).toEqual({ trigger: "cleared", gin: "dropped", owedAccounts: 0 });
    expect(await index()).toBeNull();
  });

  it("leaves no words behind on a letter emptied as gone from the server", async () => {
    await bounded();
    const gone = await letter("a letter about secret meetings", true);
    expect(await vector(gone.id)).toContain("secret");
    await retire();
    await own`update message_bodies set text = '', html = null, withheld_reason = 'expunged' where message_id = ${gone.id}`;
    expect(await vector(gone.id)).toBeNull();
  });

  it("a second run takes no lock and runs no DDL", async () => {
    await bounded();
    await retire();
    const ran: string[] = [];
    const recorded = { execute: (q: Parameters<typeof stepDb.execute>[0]) => {
      ran.push(JSON.stringify((q as { queryChunks?: unknown }).queryChunks ?? q, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v)));
      return stepDb.execute(q);
    } };
    expect(await retireBodyVector(recorded, { concurrently: false })).toEqual({ trigger: "cleared", gin: "absent", owedAccounts: 0 });
    expect(ran.filter((s) => /advisory_lock|create |drop |lock_timeout/i.test(s))).toEqual([]);
  });

  it("gives up with a named error when body writers hold the table, and leaves the bounded trigger", async () => {
    await bounded();
    const { accountId } = await letter("held", true);
    const writer = await own.reserve();
    try {
      await writer`begin`;
      const [m] = await writer<{ id: string }[]>`select id from messages where account_id = ${accountId}`;
      await writer`insert into message_bodies (message_id, text) values (${m!.id}, 'uncommitted') on conflict do nothing`;
      const err = await retire({ lockTimeoutMs: 100, attempts: 2, pauseMs: 0 }).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(BodyVectorLockTimeout);
    } finally {
      await writer`rollback`;
      writer.release();
    }
    expect([await runs(), await index()]).toEqual(["message_bodies_body_tsv_bounded", true]);
    const [lt] = await step<{ v: string }[]>`select current_setting('lock_timeout') as v`;
    expect(lt!.v, "the session's lock_timeout is put back").toBe("0");
  });

  it("drops an INVALID leftover of the index, the state a cut-short concurrent drop leaves", async () => {
    await own`drop index if exists message_bodies_body_tsv_idx`;
    await letter("one", true); await letter("two", true);
    const failed = await own`create unique index concurrently message_bodies_body_tsv_idx on message_bodies ((text is not null))`.then(() => null, (e: unknown) => e);
    expect((failed as { code?: string } | null)?.code).toBe("23505");
    expect(await index()).toBe(false);
    expect((await retire()).gin).toBe("dropped");
    expect(await index()).toBeNull();
  });
});
