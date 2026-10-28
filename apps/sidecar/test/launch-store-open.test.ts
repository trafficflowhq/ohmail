import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { openLocalDb, OWED_COPY_RECLAIM_FLOOR_BYTES, reclaimBodyBloat, type OpenLocalDb } from "../src/db.js";
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
