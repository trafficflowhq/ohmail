import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, PG_TEST_URL, realPgAvailable, throwawayDb,
} from "../src/testing.js";

/**
 * MAIL 0165 AND A LATER ALTER OF account_storage IN ONE PENDING SET, as the migrator replays a release
 * that carries both: one transaction, no lock timeout. An ingest reserve for an account with an erased
 * mailbox arrives while 0165 runs and has waited past deadlock_timeout when the later statement alters
 * the same table. The pass must commit and the ingest must land after it: a writer that holds a lock on
 * account_storage while it waits would make that ALTER a deadlock that aborts the whole pass. The ALTER
 * stands in for the next migration that alters the counter table (0166 adds its facts). 0165 replays
 * safely, so it runs here on a clone of the migrated schema.
 */
const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), "utf8");
const split = (text: string): string[] => text.split("--> statement-breakpoint")
  .map((s) => s.replace(/^\s*--[^\n]*$/gm, "").trim()).filter(Boolean);
const PASS_0165 = split(read("../../db-mail/drizzle/0165_account_storage_recount.sql"));
const LATER_ALTER = `ALTER TABLE "account_storage" ADD COLUMN IF NOT EXISTS "one_pass_probe" integer`;
const PG_UP = await realPgAvailable(PG_TEST_URL);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!PG_UP)("mail 0165 then an ALTER of account_storage in one pass, beside an ingest", () => {
  const db = throwawayDb("ohmail_m0165_pass");
  let setup: ReturnType<typeof postgres>;
  let mig: ReturnType<typeof postgres>;
  let ing: ReturnType<typeof postgres>;

  beforeAll(async () => {
    await db.createFromTemplate();
    setup = postgres(db.url, { max: 1, onnotice: () => {} });
    mig = postgres(db.url, { max: 1, onnotice: () => {}, connection: { lock_timeout: 0, statement_timeout: 0 } });
    ing = postgres(db.url, { max: 1, onnotice: () => {}, connection: { lock_timeout: 30_000 } });
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => {
    for (const c of [mig, ing, setup]) await c?.end({ timeout: 5 }).catch(() => {});
    await db.drop();
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  it("the pass commits and the waiting ingest lands after it", async () => {
    const a = randomUUID();
    await setup.unsafe(`insert into accounts (id, name) values ('${a}', 'm0165-pass')`);
    await setup.unsafe(`insert into mailboxes (id, account_id, provider, address, status, erased_at)
      values ('${randomUUID()}', '${a}', 'imap', 'g-${a}@example.test', 'disabled', now())`);
    await setup.unsafe(`insert into account_storage (account_id, bytes) values ('${a}', 1000)`);
    const [{ ms }] = await setup<Array<{ ms: number }>>`select extract(epoch from current_setting('deadlock_timeout')::interval) * 1000 as ms`;
    const [{ pid }] = await ing<Array<{ pid: number }>>`select pg_backend_pid() as pid`;

    let inZero!: () => void;
    const zeroRan = new Promise<void>((r) => { inZero = r; });
    let ingestWaited = false;
    const migration = mig.begin(async (tx) => {
      for (const s of PASS_0165) await tx.unsafe(s);
      inZero();
      // The ingest queues behind 0165 and outlasts its own deadlock check before the ALTER starts.
      for (let i = 0; i < 200; i++) {
        const [{ n }] = await setup<Array<{ n: number }>>`select count(*)::int as n from pg_locks where pid = ${pid} and not granted`;
        if (n > 0) { ingestWaited = true; break; }
        await sleep(25);
      }
      await sleep(Number(ms) + 500);
      await tx.unsafe(LATER_ALTER);
    }).then(() => "committed", (e: { code?: string; message?: string }) => `${e.code ?? ""} ${e.message ?? e}`);
    await zeroRan;
    // The ingest's reserve shape (`reserveBodyBytes`): make the row exist, then add under the cap.
    const ingest = ing.begin(async (tx) => {
      await tx.unsafe(`insert into account_storage (account_id, bytes) values ('${a}', 0) on conflict do nothing`);
      await tx.unsafe(`update account_storage set bytes = bytes + 10 where account_id = '${a}' and bytes < 2000000000`);
    }).then(() => "committed", (e: { code?: string; message?: string }) => `${e.code ?? ""} ${e.message ?? e}`);

    expect(await migration, "the migration pass").toBe("committed");
    expect(await ingest, "the ingest").toBe("committed");
    expect(ingestWaited, "the ingest never waited on the pass").toBe(true);
    // 0165 recounted the account (no bodies: 0) before the ingest's 10 bytes landed.
    const [row] = await setup<Array<{ bytes: string }>>`select bytes from account_storage where account_id = ${a}`;
    expect(Number(row!.bytes)).toBe(10);
  }, 60_000);
});
