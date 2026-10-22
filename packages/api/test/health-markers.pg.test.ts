import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { carryDialect } from "@trafficflow/db/dialect";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { probeDatabase, type HealthProbe } from "../src/routes/health.js";
import {
  CLOUD_TIER_MARKERS, CHECK_DEFINITION_MARKERS, CLOUD_INDEX_MARKERS, FUNCTION_DEFINITION_MARKERS,
  CLOUD_FK_MARKERS, EXPECTED_MARKERS,
} from "../src/routes/health-cloud.js";

/**
 * The marker census on REAL Postgres. `health.test.ts` proves it on PGlite; the index needles and
 * the type probe read what the server renders, so the hosted census must also come out whole
 * here. The two red arms run inside a transaction that is always rolled back: DDL is
 * transactional, so the lane database never sees the wrong index or the narrowed column.
 */
const PG_UP = await realPgAvailable();
class Rollback extends Error {}

describe.skipIf(!PG_UP)("the /health marker census on real Postgres", () => {
  let owned: OwnedDb;
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
  }, 180_000);
  afterAll(async () => { await owned?.close().catch(() => {}); });

  const hosted = (db: OwnedDb["db"]): Promise<HealthProbe> => probeDatabase(db, {
    markers: CLOUD_TIER_MARKERS, checkDefinitions: CHECK_DEFINITION_MARKERS,
    indexMarkers: CLOUD_INDEX_MARKERS, functionDefinitions: FUNCTION_DEFINITION_MARKERS,
    foreignKeys: CLOUD_FK_MARKERS,
  });
  const found = (p: HealthProbe) => (p.kind === "probed" ? p.markersFound : -1);

  /** `body` on a transaction handle, rolled back whatever it did; returns what it returned. */
  async function rolledBack<T>(body: (db: OwnedDb["db"]) => Promise<T>): Promise<T> {
    let out: T | undefined;
    await owned.db.transaction(async (tx) => {
      out = await body(carryDialect(owned.db, tx) as unknown as OwnedDb["db"]);
      throw new Rollback();
    }).catch((e: unknown) => { if (!(e instanceof Rollback)) throw e; });
    return out as T;
  }

  it("a migrated database satisfies every marker — each needle renders on this server", async () => {
    const probe = await hosted(owned.db);
    expect(probe.kind).toBe("probed");
    expect(found(probe)).toBe(EXPECTED_MARKERS);
    expect(probe.kind === "probed" && probe.schemaOk).toBe(true);
  });

  it("a SAME-NAMED index over other columns is one short — mail 0080's IF NOT EXISTS", async () => {
    const healthy = found(await hosted(owned.db));
    const wrong = await rolledBack(async (db) => {
      await db.execute(sql.raw(`alter index "sessions_access_token_hash_idx" rename to "sessions_token_hash_away"`));
      await db.execute(sql.raw(`create index "sessions_access_token_hash_idx" on "sessions" ("id")`));
      return hosted(db);
    });
    expect(found(wrong)).toBe(healthy - 1);
    expect(wrong.kind === "probed" && wrong.schemaOk).toBe(false);
  });

  it("a database without mail 0157's sender-date index is one short", async () => {
    const healthy = found(await hosted(owned.db));
    const missing = await rolledBack(async (db) => {
      await db.execute(sql.raw(`drop index "messages_account_sender_date_idx"`));
      return hosted(db);
    });
    expect(found(missing)).toBe(healthy - 1);
    expect(missing.kind === "probed" && missing.schemaOk).toBe(false);
  });

  it("a database where mail 0160 never ran (only the prebuild did) is short its trigger function", async () => {
    const healthy = found(await hosted(owned.db));
    const prebuiltOnly = await rolledBack(async (db) => {
      await db.execute(sql.raw(`drop trigger "folder_state_outstanding_account_tg" on "folder_state"`));
      await db.execute(sql.raw(`drop function "folder_state_outstanding_account"()`));
      return hosted(db);
    });
    expect(found(prebuiltOnly)).toBe(healthy - 1);
    expect(prebuiltOnly.kind === "probed" && prebuiltOnly.schemaOk).toBe(false);
    const noIndexes = await rolledBack(async (db) => {
      await db.execute(sql.raw(`drop index "folder_state_outstanding_idx"`));
      await db.execute(sql.raw(`drop index "mailboxes_account_idx"`));
      return hosted(db);
    });
    expect(found(noIndexes)).toBe(healthy - 2);
  });

  it("an int4 uid column is one short — the type probe on this server", async () => {
    const healthy = found(await hosted(owned.db));
    const narrowed = await rolledBack(async (db) => {
      // Rows other suites stored above 2^31 would refuse the narrowing; gone only inside this tx.
      await db.execute(sql.raw(`delete from "junk_rescues" where "uid" > 2147483647`));
      await db.execute(sql.raw(`alter table "junk_rescues" alter column "uid" type integer`));
      return hosted(db);
    });
    expect(found(narrowed)).toBe(healthy - 1);
    expect(narrowed.kind === "probed" && narrowed.schemaOk).toBe(false);
  });
});
