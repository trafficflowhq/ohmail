import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  analyzeKnownSetIfNever, analyzeNeverAnalyzed, openLocalDb, OWED_COPY_RECLAIM_FLOOR_BYTES, reclaimBodyBloat, type OpenLocalDb,
} from "../src/db.js";
import { makeDrizzleRepo, KNOWN_LOCATOR_PAGE_ROWS } from "@trafficflow/core/adapters/drizzle-repo";
import { KnownSetCache, watchKnownSet } from "@trafficflow/worker/known-set";
import { armFirstPageGate, noteFirstPageServed, resetFirstPageGate } from "../src/first-page-gate.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import { freshDataDir } from "./_datadir.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 2 });

/**
 * THE STORE OPEN DOES NO MAINTENANCE THE FIRST PAGE DOES NOT NEED. On a 290 MB store the open
 * spent 1.6 to 22 s in an `ANALYZE message_bodies` whose answer the 1 GB floor then threw away,
 * and once 17.5 s counting four tables for the statistics look. The ANALYZE now runs only above
 * the floor, and the look waits for the reader's first page. Watched red: the ANALYZE moved back
 * in front of the size read, and the look moved back into the open.
 */
const dirs: string[] = [];
const opened: OpenLocalDb[] = [];
beforeEach(() => resetFirstPageGate());
afterEach(async () => {
  vi.restoreAllMocks();
  for (const o of opened.splice(0)) await o.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  resetFirstPageGate();
});
const rows = (r: unknown): any[] => (Array.isArray(r) ? r : ((r as { rows?: any[] }).rows ?? []));

/** Every statement text the client is handed, through `query` and `exec`, in order. */
function recordStatements(client: PGlite): string[] {
  const seen: string[] = [];
  for (const name of ["query", "exec"] as const) {
    const orig = (client as any)[name].bind(client);
    (client as any)[name] = (text: string, ...rest: unknown[]) => { seen.push(String(text)); return orig(text, ...rest); };
  }
  return seen;
}

/** A statement that reads a whole table: an ANALYZE, a VACUUM, or an unbounded count of a mail table. */
const FULL_TABLE = /\bANALYZE\b|\bVACUUM\b|count\(\*\)\s+FROM\s+public\.(messages|message_bodies|message_search|folder_state)\b/i;

async function bodiesStore(): Promise<PGlite> {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-launch-compact-"));
  dirs.push(dir);
  const client = new PGlite(join(dir, "pgdata"));
  await client.waitReady;
  await client.exec(`CREATE TABLE message_bodies (id int PRIMARY KEY, text text NOT NULL DEFAULT '', html text)`);
  await client.exec(`INSERT INTO message_bodies SELECT g, repeat('x', 1000), null FROM generate_series(1, 50) g`);
  return client;
}

describe("the bloat check at launch", () => {
  it("under the floor it is one size read and no ANALYZE", async () => {
    const client = await bodiesStore();
    const seen = recordStatements(client);
    const out = await reclaimBodyBloat(client);
    expect(out.ran).toBe(false);
    expect(seen.filter((s) => /\bANALYZE\b/i.test(s)), "an ANALYZE ran under the floor").toEqual([]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/pg_total_relation_size/);
    await client.close();
  });

  it("over the floor the ANALYZE runs before the estimate, as it always did", async () => {
    const client = await bodiesStore();
    const seen = recordStatements(client);
    const out = await reclaimBodyBloat(client, undefined, undefined, { minBytes: 1 });
    // A healthy table: measured, estimated, and left alone.
    expect(out.ran).toBe(false);
    const at = (re: RegExp): number => seen.findIndex((s) => re.test(s));
    expect(at(/^ANALYZE message_bodies$/), "no ANALYZE over the floor").toBeGreaterThan(-1);
    expect(at(/pg_total_relation_size/)).toBeLessThan(at(/^ANALYZE message_bodies$/));
    expect(at(/^ANALYZE message_bodies$/)).toBeLessThan(at(/TABLESAMPLE/));
    await client.close();
  });
});

describe("the store open before it serves", () => {
  /** A store holding mail nobody has analyzed, closed and opened again with every statement recorded. */
  async function reopenedWithMail(): Promise<{ o: OpenLocalDb; seen: string[] }> {
    const dir = await freshDataDir("ohmail-launch-open-");
    dirs.push(dir);
    const first = await openLocalDb(dir);
    const accountId = rows(await first.db.execute(sql`insert into accounts (name) values ('launch') returning id`))[0].id;
    const mailboxId = rows(await first.db.execute(sql`insert into mailboxes (account_id, provider, address) values (${accountId}, 'imap', 'launch@mail.example') returning id`))[0].id;
    await first.db.execute(sql`insert into messages (account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, to_addresses, cc_addresses, native_locator)
      select ${accountId}, ${mailboxId}, 'h', 'launch:' || g, 'subject ' || g, 'a@mail.example', now(), '[]'::jsonb, '[]'::jsonb, '{"folder":"INBOX","ref":"1:1"}'::jsonb
      from generate_series(1, 300) g`);
    await first.db.execute(sql`insert into message_bodies (message_id, text) select id, 'body' from messages`);
    await first.db.execute(sql`insert into folder_state (message_id, desired_folder, observed_folder, last_set_by) select id, 'INBOX', 'INBOX', 'us' from messages`);
    await first.close();
    const seen: string[] = [];
    for (const name of ["query", "exec"] as const) {
      const orig = PGlite.prototype[name];
      vi.spyOn(PGlite.prototype, name).mockImplementation(function (this: PGlite, text: unknown, ...rest: unknown[]) {
        seen.push(String(text));
        return (orig as any).call(this, text, ...rest);
      } as any);
    }
    const o = await openLocalDb(dir);
    opened.push(o);
    return { o, seen };
  }

  it("issues no full-table statement, and the statistics look runs after the first page", async () => {
    const { seen } = await reopenedWithMail();
    expect(seen.length, "the recorder saw nothing — it measures nothing").toBeGreaterThan(5);
    expect(seen.filter((s) => FULL_TABLE.test(s)), "a full-table statement ran before serving").toEqual([]);
    const atOpen = seen.length;
    noteFirstPageServed();
    await vi.waitFor(() => {
      expect(seen.slice(atOpen).some((s) => /^ANALYZE public\.messages$/.test(s)), "the look never ran").toBe(true);
    }, { timeout: 20_000 });
  });

  it("an armed gate nobody asks a page of runs the look when the grace ends", async () => {
    const { seen } = await reopenedWithMail();
    const atOpen = seen.length;
    armFirstPageGate(performance.now() - 10_000);
    await vi.waitFor(() => {
      expect(seen.slice(atOpen).some((s) => FULL_TABLE.test(s)), "the look never ran").toBe(true);
    }, { timeout: 20_000 });
  });

  it("an unarmed gate with no page runs no look at all", async () => {
    const { seen } = await reopenedWithMail();
    await new Promise((r) => setTimeout(r, 300));
    expect(seen.filter((s) => FULL_TABLE.test(s))).toEqual([]);
  });
});

describe("owed Sent copies deleted without a VACUUM", () => {
  it("leave no dead space after the next open", async () => {
    const dir = await freshDataDir("ohmail-launch-owed-");
    dirs.push(dir);
    const first = await openLocalDb(dir);
    const one = async (q: ReturnType<typeof sql>) => rows(await first.db.execute(q))[0];
    const accountId = (await one(sql`insert into accounts (name) values ('owed') returning id`)).id;
    const mailboxId = (await one(sql`insert into mailboxes (account_id, provider, address) values (${accountId}, 'imap', 'owed@mail.example') returning id`)).id;
    const sendId = (await one(sql`insert into outbound_sends (account_id, idempotency_key, minted_message_id) values (${accountId}, 'k', '<m@mail.example>') returning id`)).id;
    const b64 = randomBytes(3 * 1024 * 1024).toString("base64");
    await first.db.execute(sql`insert into outbound_sent_copies (send_id, account_id, mailbox_id, raw_b64) values (${sendId}, ${accountId}, ${mailboxId}, ${b64})`);
    // The mailbox removal's delete: no VACUUM follows it.
    await first.db.execute(sql`delete from outbound_sent_copies where mailbox_id = ${mailboxId}`);
    const size = async (o: OpenLocalDb) => Number(rows(await o.db.execute(
      sql`select pg_total_relation_size('outbound_sent_copies')::text as n`))[0].n);
    expect(await size(first), "the deleted copy's bytes are still on disk").toBeGreaterThan(OWED_COPY_RECLAIM_FLOOR_BYTES);
    await first.close();
    const again = await openLocalDb(dir);
    opened.push(again);
    expect(await size(again)).toBeLessThan(OWED_COPY_RECLAIM_FLOOR_BYTES);
  });
});

describe("the deferred statistics look", () => {
  it("asks one table per statement, and the loop turns between them", async () => {
    const dir = await freshDataDir("ohmail-launch-look-");
    dirs.push(dir);
    const seen: string[] = [];
    let turns = 0;
    // On the prototype BEFORE the open: the store's wrappers bind the methods they find there.
    for (const name of ["query", "exec"] as const) {
      const orig = PGlite.prototype[name];
      vi.spyOn(PGlite.prototype, name).mockImplementation(function (this: PGlite, text: unknown, ...rest: unknown[]) {
        seen.push(`${turns}|${String(text)}`);
        return (orig as any).call(this, text, ...rest);
      } as any);
    }
    const o = await openLocalDb(dir);
    opened.push(o);
    // One count per turn of the loop's check phase: a statement that took no turn reads the same.
    let spinning = true;
    const spin = (): void => { turns += 1; if (spinning) setImmediate(spin); };
    setImmediate(spin);
    try {
      await o.analyzeSearchIfStale();
    } finally {
      spinning = false;
    }
    const counts = seen.filter((s) => /count\(\*\) FROM public\./.test(s));
    expect(counts, "the four counts are not four statements").toHaveLength(4);
    for (const s of counts) expect(s.match(/count\(\*\)/g), `one statement counted two tables: ${s}`).toHaveLength(1);
    const at = counts.map((s) => Number(s.split("|")[0]));
    expect(new Set(at).size, "the loop never turned between two counts").toBe(4);
  });
});

/* ── THE FIRST KNOWN-SET READ ─────────────────────────────────────────────────────────────── */

/**
 * Two mailboxes holding the same locator keys. A's are the measured 74,003: two epochs of Archive
 * (the first page ends exactly at the epoch edge; the second reuses its UIDs one along, so a cursor
 * without the epoch ends a page between two rows of one UID) and INBOX, plus INBOX copies of a
 * Sent row the known set leaves out. Few messages: instances are what is read.
 */
async function locatorStore(archive: number, inbox: number): Promise<{ o: OpenLocalDb; c: PGlite; a: string; b: string }> {
  const dir = await freshDataDir("ohmail-known-pages-");
  dirs.push(dir);
  const o = await openLocalDb(dir);
  opened.push(o);
  const c = (o.db as unknown as { $client: PGlite }).$client;
  const one = async (q: string): Promise<string> => (await c.query<{ id: string }>(q)).rows[0]!.id;
  const acc = await one(`insert into accounts (name) values ('pages') returning id`);
  const mb = async (n: string): Promise<string> => one(`insert into mailboxes (account_id, provider, address) values ('${acc}', 'imap', '${n}@mail.example') returning id`);
  const a = await mb("a"), b = await mb("b");
  const msg = async (box: string, key: string, folder: string): Promise<string> => one(`insert into messages
    (account_id, mailbox_id, body_hash, dedup_key, subject, from_address, date, to_addresses, cc_addresses, native_locator, message_id_header)
    values ('${acc}', '${box}', 'h', '${key}', 's', 'x@mail.example', now(), '[]'::jsonb, '[]'::jsonb, '{"folder":"${folder}","ref":"1:1"}'::jsonb, '<${key}@x>') returning id`);
  const put = async (box: string, m: string, folder: string, uv: string, n: number, from = 1): Promise<void> => {
    await c.exec(`insert into message_instances (account_id, mailbox_id, message_id, folder, uidvalidity, uid, is_primary)
      select '${acc}', '${box}', '${m}', '${folder}', ${uv}, g, false from generate_series(${from}, ${from + n - 1}) g`);
  };
  for (const [box, tag] of [[a, "a"], [b, "b"]] as const) {
    const m = await msg(box, tag, "INBOX");
    await put(box, m, "Archive", "3000000000", archive);
    await put(box, m, "Archive", "3000000001", archive, 2);
    await put(box, m, "INBOX", "1", inbox);
    await put(box, await msg(box, `${tag}-sent`, "Sent"), "INBOX", "2", 3);
  }
  return { o, c, a, b };
}

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
const nodesOf = (p: PlanNode, out: PlanNode[] = []): PlanNode[] => { out.push(p); for (const k of p.Plans ?? []) nodesOf(k, out); return out; };

describe("the first known-set read after launch", () => {
  it("reads 74,003 locators in keyset pages, a turn of the loop each, and the memo equals the whole set", async () => {
    const pages: Array<{ turn: number; text: string; params: unknown[]; rows: number }> = [];
    let turns = 0;
    // On the prototype BEFORE the open: the store's wrappers bind the methods they find there.
    const orig = PGlite.prototype.query;
    vi.spyOn(PGlite.prototype, "query").mockImplementation(async function (this: PGlite, text: unknown, params?: unknown[], ...rest: unknown[]) {
      const at = turns;
      const r = await (orig as any).call(this, text, params, ...rest);
      if (/^select "message_instances"\."folder"/.test(String(text))) pages.push({ turn: at, text: String(text), params: [...(params ?? [])], rows: r.rows.length });
      return r;
    } as any);
    const { o, c, a } = await locatorStore(5_000, 64_003);
    expect(await o.analyzeKnownSetIfNever()).toBe("analyzed");
    const watched = watchKnownSet(makeDrizzleRepo(o.db as never), new KnownSetCache(a));
    let spinning = true;
    const spin = (): void => { turns += 1; if (spinning) setImmediate(spin); };
    setImmediate(spin);
    let first;
    try { first = await watched.listKnownLocators(a); } finally { spinning = false; }

    const keys = first.map((k) => `${k.folder}|${k.uidValidity}|${k.uid}`);
    const want = new Set<string>();
    for (let u = 1; u <= 5_000; u += 1) want.add(`Archive|3000000000|${u}`).add(`Archive|3000000001|${u + 1}`);
    for (let u = 1; u <= 64_003; u += 1) want.add(`INBOX|1|${u}`);
    const got = new Set(keys);
    expect({
      rows: keys.length, duplicates: keys.length - got.size,
      missing: [...want].filter((k) => !got.has(k)).length, extra: [...got].filter((k) => !want.has(k)).slice(0, 5),
      foreign: first.filter((k) => k.messageId !== "<a@x>").length,
    }).toEqual({ rows: 74_003, duplicates: 0, missing: 0, extra: [], foreign: 0 });

    expect(pages.map((p) => p.rows)).toEqual([...Array(14).fill(KNOWN_LOCATOR_PAGE_ROWS), 4_003]);
    expect(new Set(pages.map((p) => p.turn)).size, "two pages were read on one turn of the loop").toBe(pages.length);

    const again = await watched.listKnownLocators(a);
    expect(pages, "the second read went to the store").toHaveLength(15);
    expect(again).toEqual(first);

    for (const p of [pages[0]!, pages[1]!]) {
      const raw = Object.values((await c.query(`explain (format json) ${p.text}`, p.params)).rows[0] as object)[0];
      const nodes = nodesOf(((typeof raw === "string" ? JSON.parse(raw) : raw) as { Plan: PlanNode }[])[0]!.Plan);
      expect(nodes.filter((n) => /Sort/.test(String(n["Node Type"]))), "a page sorts the mailbox").toEqual([]);
      expect(nodes.some((n) => /Index/.test(String(n["Node Type"])) && n["Index Name"] === "message_instances_locator_uq")).toBe(true);
    }
  }, 240_000);

  it("analyzes the locator table that a rewrite left with a row count and no statistics, once", async () => {
    const { o, c } = await locatorStore(10, 10);
    await c.exec("BEGIN; DELETE FROM public.message_instances");
    expect(await analyzeKnownSetIfNever(c), "an empty table answered for good").toBe("pending");
    await c.exec("ROLLBACK");
    await c.exec("VACUUM public.message_instances");
    expect(await analyzeNeverAnalyzed(c, ["message_instances"])).toEqual(["message_instances"]);
    expect(await analyzeNeverAnalyzed(c, ["message_instances"])).toEqual([]);
    expect(await o.analyzeKnownSetIfNever()).toBe("already");
  }, 120_000);
});
