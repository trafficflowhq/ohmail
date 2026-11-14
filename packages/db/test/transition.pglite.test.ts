import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type postgres from "postgres";
import { journalThrough } from "../src/testing-journal.js";
import { OLD_HEADS } from "../src/journal-heads.js";
import { MAIL_JOURNAL } from "../src/journal-specs.js";
import {
  NOTHING_OPENS, TransitionFailed, TransitionRefused, describeEvent, readWindow, runTransition, sealedOpener, tablesOf,
  transitionState, type TransitionEvent,
} from "../src/transition/index.js";
import { plant1011, testRing } from "./_plant-1-0-11.js";

/**
 * THE TRANSITION ON A DESKTOP'S OWN STORE: the same function, on the in-process Postgres a desktop
 * engine runs, with the kind its runner names. A desktop holds the mail journal alone, so there is
 * no Cloud entry, no Cloud ledger and no hosted table; the engine's own table is expected there.
 */
const ring = testRing();

/** A store walked along the mail journal to 1.0.11's head, with the engine's own table, then planted. */
async function desktopStore() {
  const client = new PGlite();
  const cut = journalThrough(MAIL_JOURNAL, OLD_HEADS.mail.when);
  try {
    await migrate(drizzle(client), { migrationsFolder: cut.spec.dir, migrationsSchema: cut.spec.migrationsSchema });
  } finally { cut.dispose(); }
  await client.exec(`create table local_store_flush (id integer primary key, flushed_at timestamptz not null default now())`);
  await client.exec(`insert into local_store_flush (id) values (1)`);
  // The planter speaks the server driver's tagged template; here it is the same statement with numbered parameters.
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) =>
    client.query(strings.reduce((q, s, i) => q + s + (i < values.length ? `$${i + 1}` : ""), ""), values).then((r) => r.rows);
  const planted = await plant1011(tag as unknown as ReturnType<typeof postgres>, { cloud: false, ring });
  const count = async (table: string): Promise<number> => Number((await client.query<{ n: number }>(`select count(*)::int as n from "${table}"`)).rows[0]!.n);
  const tables = async (): Promise<string[]> => (await client.query<{ name: string }>(
    `select c.relname::text as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1`)).rows.map((r) => r.name);
  const run = async (over: Partial<Parameters<typeof runTransition>[0]> = {}) => {
    const events: TransitionEvent[] = [];
    try {
      return { report: await runTransition({ kind: "desktop", db: drizzle(client), openSealed: sealedOpener(ring), log: (e) => { events.push(e); }, ...over }), events };
    } catch (error) { return { error, events }; }
  };
  return { client, planted, count, tables, run };
}

describe("a desktop's own store in 1.0.11's shape", () => {
  it("moves in one transaction: the mail journal's six entries, the engine's own table kept, no Cloud ledger", async () => {
    const s = await desktopStore();
    expect(await transitionState(drizzle(s.client), { cloud: false })).toBe("at-old-head");
    const before = Object.fromEntries(await Promise.all((await s.tables()).map(async (t) => [t, await s.count(t)] as const)));
    const { report, error, events } = await s.run();
    expect(error).toBeUndefined();
    expect(report!.verdicts.filter((v) => !v.ok)).toEqual([]);
    expect(report!.entries.map((e) => `${e.journal} ${e.tag}`)).toEqual(readWindow("mail").map((e) => `mail ${e.tag}`));
    expect(await s.tables()).toEqual(tablesOf("desktop"));
    for (const table of tablesOf("desktop")) {
      if (before[table] !== undefined && table !== "pass_progress") expect(await s.count(table), table).toBe(before[table]);
    }
    expect(await s.count("local_store_flush")).toBe(1);
    expect(await s.count("pass_progress")).toBe(s.planted.passRows.length);
    expect(await s.count("message_bodies")).toBe(s.planted.letters);
    expect((await s.client.query<{ t: string | null }>(`select to_regclass('drizzle_cloud.__drizzle_migrations')::text as t`)).rows[0]!.t).toBeNull();
    expect(report!.heads).toEqual({ mail: readWindow("mail").at(-1)!.when });
    expect(report!.sealed.find((x) => x.site === "mailbox_credentials.secret_enc")).toMatchObject({ rows: 2, opened: 2, failed: 0 });
    expect(events.map(describeEvent).at(-1)).toMatch(/^transition: committed; the heads read mail \d+$/);
    expect(await transitionState(drizzle(s.client), { cloud: false })).toBe("moved");
    // A second run finds a store that is no longer at the old head and applies nothing.
    expect((await s.run()).error).toBeInstanceOf(TransitionRefused);
  }, 120_000);

  it("is not moved when a hosted table stands in it, or when its runner calls it a server", async () => {
    const s = await desktopStore();
    await s.client.exec(`create table login_tokens (id uuid primary key)`);
    const hosted = await s.run();
    expect(hosted.error).toBeInstanceOf(TransitionRefused);
    expect((hosted.error as TransitionRefused).lines).toContainEqual({ what: "a table the map does not name for this store: another kind of store's own table", n: 1 });
    await s.client.exec(`drop table login_tokens`);
    const misnamed = await s.run({ kind: "server" });
    expect(misnamed.error).toBeInstanceOf(TransitionRefused);
    expect(await transitionState(drizzle(s.client), { cloud: false })).toBe("at-old-head");
    expect(await s.count("message_bodies")).toBe(s.planted.letters);
  }, 120_000);

  it("is left as it was when its sealed values do not open: an engine without its key ring moves nothing", async () => {
    const s = await desktopStore();
    const run = await s.run({ openSealed: NOTHING_OPENS });
    expect(run.error).toBeInstanceOf(TransitionFailed);
    expect((run.error as TransitionFailed).at.stage).toBe("sealed");
    expect(await transitionState(drizzle(s.client), { cloud: false })).toBe("at-old-head");
    expect((await s.tables()).includes("pass_progress")).toBe(false);
    // With the ring the same store moves.
    expect((await s.run()).error).toBeUndefined();
  }, 120_000);
});
