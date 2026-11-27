import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { readJournals, setupProdDatabase } from "../src/setup-prod.js";
import { runMigrations } from "../src/migrate.js";
import { realPgAvailable, throwawayDb } from "../src/testing.js";

const up = await realPgAvailable();
const ground = throwawayDb("migration_lock_budget");
const mail = readJournals().find(({ spec }) => spec.name === "mail")!;
const pending = mail.entries.at(-1)!;

describe.skipIf(!up)("setup stops waiting on a contested relation", () => {
  beforeAll(() => ground.create(runMigrations), 150_000);
  afterAll(() => ground.drop(), 30_000);

  it("lets queued reads through while the original reader keeps its lock, then retries the pending migration", async () => {
    const reader = postgres(ground.url, { max: 1, onnotice: () => {} });
    const probe = postgres(ground.url, { max: 1, onnotice: () => {} });
    const opts = { ddlLockTimeoutMs: 1000 };
    try {
      await probe`delete from drizzle_mail.__drizzle_migrations where created_at = ${String(pending.when)}`;
      await reader.begin(async (tx) => {
        await tx`select id from accounts limit 1`;
        const setup = setupProdDatabase(ground.url, opts).then(() => null, (err: unknown) => err);
        const end = Date.now() + 5_000;
        let waiting = false;
        while (!waiting && Date.now() < end) {
          const [r] = await probe`select exists (
            select 1 from pg_locks where database = (select oid from pg_database where datname = current_database())
              and relation = 'public.accounts'::regclass and mode = 'AccessExclusiveLock' and not granted
          ) as waiting`;
          waiting = r!.waiting === true;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(true);
        await probe`set statement_timeout = '3s'`;
        await expect(probe`select id from accounts limit 1`).resolves.toEqual([]);
        const outcome = await setup;
        expect(outcome).toBeInstanceOf(Error);
        const [marker] = await probe`select count(*)::int as n from drizzle_mail.__drizzle_migrations where created_at = ${String(pending.when)}`;
        expect(marker?.n).toBe(0);
      });
      await setupProdDatabase(ground.url, opts);
      const [marker] = await probe`select count(*)::int as n from drizzle_mail.__drizzle_migrations where created_at = ${String(pending.when)}`;
      expect(marker?.n).toBe(1);
    } finally {
      await reader.end({ timeout: 5 });
      await probe.end({ timeout: 5 });
    }
  }, 150_000);
});
