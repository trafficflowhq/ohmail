import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  makeTestDb, MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, realPgAvailable, throwawayDb,
} from "../src/testing.js";

/**
 * CLOUD 0056 ON BOTH STORES, against the pre-0056 shape (the column dropped): a browser row that names
 * neither a device nor a family goes, a phone row bound to its device stays, and a second application
 * changes nothing, a row bound to a family included.
 */
const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const STATEMENTS = read("../drizzle-cloud/0056_push_subscription_session_family.sql").split("--> statement-breakpoint")
  .map((s) => s.replace(/^\s*--[^\n]*$/gm, "").trim()).filter(Boolean);

type Row = Record<string, unknown>;
interface Store { run(q: string): Promise<Row[]>; pass(): Promise<void> }

async function scenario(store: Store): Promise<void> {
  await store.run(`alter table push_subscriptions drop column if exists session_family_id`);
  const a = randomUUID(); const u = randomUUID(); const d = randomUUID();
  await store.run(`insert into accounts (id, name) values ('${a}', 'c0056')`);
  await store.run(`insert into users (id, account_id, email) values ('${u}', '${a}', 'c0056-${a}@example.test')`);
  await store.run(`insert into devices (id, account_id, user_id, kind) values ('${d}', '${a}', '${u}', 'mobile-android')`);
  const wake = async (device: string | null, family = ""): Promise<string> => {
    const id = randomUUID();
    await store.run(`insert into push_subscriptions (id, account_id, transport, endpoint, device_id${family ? ", session_family_id" : ""})
      values ('${id}', '${a}', 'webpush', 'https://push.test/${id}', ${device ? `'${device}'` : "null"}${family ? `, '${family}'` : ""})`);
    return id;
  };
  const left = async () => (await store.run(`select id::text as id from push_subscriptions where account_id = '${a}' order by id`))
    .map((r) => String(r.id));
  const unbound = await wake(null);
  const phone = await wake(d);
  expect(await left()).toEqual([unbound, phone].sort());

  await store.pass();
  expect(await left(), "the unbound browser row stayed, or the phone row went").toEqual([phone]);
  const index = await store.run(`select indexdef from pg_indexes where indexname = 'push_subscriptions_session_family_idx'`);
  expect(String(index[0]?.indexdef ?? "")).toContain("(session_family_id)");

  const bound = await wake(null, randomUUID());
  await store.pass();
  expect(await left(), "a second application changed something").toEqual([phone, bound].sort());
}

const rowsOf = (r: unknown): Row[] => (Array.isArray(r) ? r : ((r as { rows?: Row[] }).rows ?? [])) as Row[];

describe("cloud 0056 on PGlite", () => {
  it("deletes only the rows with neither binding, and replays", async () => {
    const db = await makeTestDb();
    await scenario({
      run: async (q) => rowsOf(await db.execute(sql.raw(q))),
      pass: () => db.transaction(async (tx) => { for (const s of STATEMENTS) await tx.execute(sql.raw(s)); }),
    });
  }, 60_000);
});

const PG_UP = await realPgAvailable();

describe.skipIf(!PG_UP)("cloud 0056 on Postgres", () => {
  const db = throwawayDb("ohmail_c0056");
  let client: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await db.createFromTemplate();
    client = postgres(db.url, { max: 1, onnotice: () => {} });
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => {
    await client?.end({ timeout: 5 }).catch(() => {});
    await db.drop();
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  it("deletes only the rows with neither binding, and replays", async () => {
    await scenario({
      run: async (q) => [...(await client.unsafe(q))] as Row[],
      // One transaction, as the migrator replays a pending set.
      pass: async () => { await client.begin(async (tx) => { for (const s of STATEMENTS) await tx.unsafe(s); }); },
    });
  }, 60_000);
});
