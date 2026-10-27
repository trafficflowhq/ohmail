import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { openLocalDb } from "../src/db.js";
import { wipeLocalMirror } from "../src/local-mirror.js";
import type { PowerVerdict } from "../src/host-power.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 2 });

/**
 * THE LOCAL STORE SEARCHES LIKE THE SERVER, AND ITS INDEX FILLS ITSELF IN.
 *
 * Real sidecars over real on-disk stores. `axa` is found inside "myAXA Portal" with the search
 * extensions loaded (the trigram indexes exist and the substring arm reads one) and, the same one
 * hit, through the ILIKE degrade on a store opened without them — slower, never narrower. Messages
 * stored before the search table existed are read the older way until the engine's own backfill,
 * on its idle schedule, has written every document; the progress door answers the store's counts.
 * Watched red: empty LOCAL_STORE_EXTENSIONS (the plan loses the index, the degrade case stays
 * green), drop the backfill's wiring (the door never reads built) or its upkeep (never analyzed).
 */
const ADDRESS = "owner@trafficflow.test";
const dirs: string[] = [];
const sidecars: Sidecar[] = [];

afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function standUp(
  opts: { withoutSearchExtensions?: true; backfill?: boolean; hostPower?: () => PowerVerdict } = {},
): Promise<Sidecar> {
  const dir = await freshDataDir("ohmail-local-search-", opts.withoutSearchExtensions ? { withoutSearchExtensions: true } : {});
  dirs.push(dir);
  const s = await createSidecar({
    dataDir: dir,
    address: ADDRESS,
    imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: ADDRESS, pass: "not-dialled-password-password" } },
    pollIntervalMs: 60 * 60 * 1000,
    vitalsIntervalMs: 60 * 60 * 1000,
    profileFlushIntervalMs: 60 * 60 * 1000,
    adapterFactory: () => ({ close: async () => undefined }) as unknown as MailboxAdapter,
    ...(opts.withoutSearchExtensions
      ? { store: (d: string, o: Parameters<typeof openLocalDb>[1]) => openLocalDb(d, { ...o, withoutSearchExtensions: true }) }
      : {}),
    // The backfill waits an hour unless a case asks for it, so no case races it.
    searchBackfillTiming: opts.backfill ? { waitMs: 20, tickMs: 10, quietMs: 0 } : { waitMs: 3_600_000 },
    ...(opts.hostPower ? { hostPower: opts.hostPower } : {}),
  });
  sidecars.push(s);
  return s;
}

/** A message stored the way a pre-0125 install stored it: a row, a body, no search document. */
async function store(s: Sidecar, subject: string, from: string, text: string): Promise<string> {
  const id = randomUUID();
  await s.db.execute(sql`insert into messages (id, account_id, mailbox_id, body_hash, dedup_key, subject, from_address, from_name, date, to_addresses, cc_addresses, native_locator)
    values (${id}, ${s.world.accountId}, ${s.world.mailboxId}, 'h', ${`fx:${id}`}, ${subject}, ${from}, 'Someone', now(), '[]'::jsonb, '[]'::jsonb, ${JSON.stringify({ folder: "INBOX", ref: `1:${id.slice(0, 4)}` })}::jsonb)`);
  await s.db.execute(sql`insert into message_bodies (message_id, text, html) values (${id}, ${text}, null)`);
  return id;
}

const get = async (s: Sidecar, path: string): Promise<{ status: number; body: any }> => {
  const res = await s.handle(new Request(`http://local${path}`, { headers: { authorization: `Bearer ${s.sessionToken}` } }));
  return { status: res.status, body: await res.json().catch(() => null) };
};
const rows = (r: unknown): any[] => (Array.isArray(r) ? r : ((r as { rows?: any[] }).rows ?? []));
const idsOf = (body: any): string[] => (body?.items ?? []).map((i: { id: string }) => i.id);
/** The plan for a substring match on the header corpus, with the table scan priced out. */
const substringPlan = (s: Sidecar): Promise<string> => s.db.transaction(async (tx) => {
  await tx.execute(sql`set local enable_seqscan = off`);
  return rows(await tx.execute(sql`explain select message_id from message_search where terms ilike '%axa%'`))
    .map((r) => String(Object.values(r)[0])).join("\n");
});

describe("the local store searches with the server's own indexes", () => {
  it("axa finds myAXA Portal, and the substring arm reads the trigram index", async () => {
    const s = await standUp();
    const hit = await store(s, "myAXA Portal: your documents", "notices@insure.example", "Your policy summary is ready.");
    await store(s, "Lunch on Friday", "friend@mail.example", "See you at noon.");
    const ext = rows(await s.db.execute(sql`select extname from pg_extension order by 1`)).map((r) => r.extname);
    expect(ext).toEqual(expect.arrayContaining(["pg_trgm", "btree_gin"]));
    const idx = rows(await s.db.execute(sql`select indexname from pg_indexes where schemaname = 'public'`)).map((r) => r.indexname);
    expect(idx).toEqual(expect.arrayContaining([
      "messages_subject_trgm_idx", "messages_from_address_trgm_idx", "message_search_terms_trgm_idx",
      "messages_account_msg_order_idx",
    ]));
    // The server's account-keyed word index is not the desktop's: its arms read the store bounded.
    expect(idx).not.toContain("message_search_words_idx");
    const before = await get(s, "/search?q=axa");
    expect(before.status).toBe(200);
    expect(idsOf(before.body)).toEqual([hit]);
    expect(await substringPlan(s)).toContain("Bitmap Index Scan on message_search_terms_trgm_idx");
  });

  it("the same one hit through the degrade on a store that refused the extensions", async () => {
    const s = await standUp({ withoutSearchExtensions: true });
    const hit = await store(s, "myAXA Portal: your documents", "notices@insure.example", "Your policy summary is ready.");
    await store(s, "Lunch on Friday", "friend@mail.example", "See you at noon.");
    const ext = rows(await s.db.execute(sql`select extname from pg_extension`)).map((r) => r.extname);
    expect(ext).not.toContain("pg_trgm");
    const res = await get(s, "/search?q=axa");
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toEqual([hit]);
    expect(await substringPlan(s)).toMatch(/Seq Scan on message_search/);
  });
});

describe("the index fills itself in while nobody is using the app", () => {
  it("the door reads the store's counts, the backfill writes every document, and search reads them", async () => {
    const s = await standUp({ backfill: true });
    const oldest = await store(s, "Welcome to the new mailbox", "hello@mail.example", "zzfirstwordoldest greetings");
    await store(s, "Invoice for September", "billing@shop.example", "Amount due");
    await store(s, "Invoice for October", "billing@shop.example", "Amount due");
    let door = await get(s, "/local/search-index");
    expect(door.status).toBe(200);
    for (let i = 0; i < 100 && door.body?.built !== true; i++) {
      await new Promise((r) => setTimeout(r, 100));
      door = await get(s, "/local/search-index");
    }
    expect(door.body).toEqual({ built: true, done: 0, total: 0 });
    const docs = rows(await s.db.execute(sql`select count(*)::int as n from message_search where account_id = ${s.world.accountId}`));
    expect(docs[0]?.n).toBe(3);
    // The schedule's own upkeep analyzed the table the rounds grew — PGlite has no autovacuum.
    const stats = rows(await s.db.execute(sql`select reltuples::float8 as rt from pg_class where relname = 'message_search'`));
    expect(Number(stats[0]?.rt), "the search table was never analyzed").toBe(3);
    const found = await get(s, "/search?q=zzfirstwordoldest");
    expect(idsOf(found.body)).toEqual([oldest]);
  });

  // The store's own door. `eleva` … `elevatio` found only the subject hit: the body's
  // lexeme is the stem `elev`, which neither a prefix of what was typed nor the header corpus holds.
  it("a part of a word finds what the whole word finds, through the store's own door", async () => {
    const s = await standUp({ backfill: true });
    const inBody = await store(s, "Site notes", "site@mail.example", "The elevation plan is attached for review.");
    const inSubject = await store(s, "Elevation survey", "survey@mail.example", "See the drawings.");
    await store(s, "Lunch on Friday", "friend@mail.example", "See you at noon.");
    let door = await get(s, "/local/search-index");
    for (let i = 0; i < 100 && door.body?.built !== true; i++) {
      await new Promise((r) => setTimeout(r, 100));
      door = await get(s, "/local/search-index");
    }
    expect(door.body?.built, "the backfill never finished").toBe(true);
    const both = new Set([inBody, inSubject]);
    expect(new Set(idsOf((await get(s, "/search?q=elevation")).body))).toEqual(both);
    for (const p of ["elev", "eleva", "elevat", "elevati", "elevatio"]) {
      expect(new Set(idsOf((await get(s, `/search?q=${p}`)).body)), p).toEqual(both);
    }
  });

  it("removing a mailbox after the backfill takes its search entries first, then its messages", async () => {
    const s = await standUp({ backfill: true });
    await store(s, "One", "a@mail.example", "first");
    await store(s, "Two", "b@mail.example", "second");
    let door = await get(s, "/local/search-index");
    for (let i = 0; i < 100 && door.body?.built !== true; i++) {
      await new Promise((r) => setTimeout(r, 100));
      door = await get(s, "/local/search-index");
    }
    const count = async (table: string): Promise<number> =>
      Number(rows(await s.db.execute(sql.raw(`select count(*)::int as n from ${table}`)))[0]?.n);
    expect(await count("message_search"), "the backfill wrote the entries this case removes").toBe(2);
    // The entry references its message without a cascade: a wipe out of that order is refused.
    await wipeLocalMirror(s.db, { accountId: s.world.accountId, mailboxId: s.world.mailboxId });
    expect(await count("message_search")).toBe(0);
    expect(await count("messages")).toBe(0);
  });

  // The cases above supply no reader and the index fills in; this one is the reader the entry injects.
  it("the pass asks the reader the engine was given: on battery no document is written", async () => {
    let asked = 0;
    const s = await standUp({ backfill: true, hostPower: () => { asked += 1; return { onPower: false, state: "battery" }; } });
    await store(s, "One", "a@mail.example", "first");
    for (let i = 0; i < 100 && asked < 3; i++) await new Promise((r) => setTimeout(r, 50));
    expect(asked, "the engine never asked the reader it was given").toBeGreaterThanOrEqual(3);
    const door = await get(s, "/local/search-index");
    expect(door.body).toEqual({ built: false, done: 0, total: 1 });
  });

  // the control: this composition fills its index, so its search says so while it fills
  // (the paired desktop's mirror, which nothing fills, says nothing: `cloud-paired-search.test.ts`).
  it("before the backfill runs, a search carries the store's index progress", async () => {
    const s = await standUp();
    await store(s, "One", "a@mail.example", "first");
    await store(s, "Two", "b@mail.example", "second");
    const res = await get(s, "/search?q=first&parts=estimate");
    expect(res.status).toBe(200);
    expect(res.body.indexed).toEqual({ done: 0, total: 2 });
  });

  it("before the backfill runs, the door answers the store's own counts", async () => {
    const s = await standUp();
    await store(s, "One", "a@mail.example", "first");
    await store(s, "Two", "b@mail.example", "second");
    const door = await get(s, "/local/search-index");
    expect(door.body).toEqual({ built: false, done: 0, total: 2 });
    const refused = await s.handle(new Request("http://local/local/search-index"));
    expect(refused.status).toBe(401);
  });
});
