/* @postpush: alone — it makes two databases of its own, one from empty and one along the 1.0 road,
 * and compares their catalogs; nothing it does reaches the lane database. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runMigrations } from "../src/migrate.js";
import {
  MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, realPgAvailable, throwawayDb,
} from "../src/testing.js";
import { MAP_2_0, sealedOpener, tablesOf, type TransitionEvent } from "../src/transition/index.js";
import { makeStoreAtOldHeads } from "./_store-at-old-heads.js";
import { fingerprintOf, plant1011, testRing, type Planted } from "./_plant-1-0-11.js";

/**
 * A STORE MADE FROM EMPTY AT 2.0 AND A 1.0.11 STORE MOVED BY THE TRANSITION ARE THE SAME STORE.
 * There is one road: a new store walks the old journals and then 2.0's entries by the ordinary
 * migrator, and never runs the transition. So an entry edited for one of the two (a guard that
 * holds only on an empty store, a statement the transition's own path skips) would give two
 * shapes of 2.0, and nothing else would notice. Compared here line for line: every column with
 * its position, every constraint with its definition and whether it is validated, every index,
 * trigger, function and statistics object. The server the suite runs on decides the version; the
 * nightly runs this file on the test stack's major and on the hosted database's.
 */
const PG_UP = await realPgAvailable();
const fresh = throwawayDb("transition_fresh");
const moved = throwawayDb("transition_moved");
const ring = testRing();
const quiet = { max: 2, onnotice: () => { /* quiet */ } };

describe.skipIf(!PG_UP)("a store from empty and a store moved", () => {
  let a: ReturnType<typeof postgres>;
  let b: ReturnType<typeof postgres>;
  let planted: Planted;
  let before: Awaited<ReturnType<typeof fingerprintOf>>;
  const events: TransitionEvent[] = [];

  beforeAll(async () => {
    await fresh.create((url) => runMigrations(url));
    await moved.create(async (url) => {
      await makeStoreAtOldHeads(url);
      const plant = postgres(url, { max: 1, onnotice: () => { /* quiet */ } });
      try {
        planted = await plant1011(plant, { cloud: true, ring });
        before = await fingerprintOf(plant);
      } finally { await plant.end({ timeout: 5 }); }
      await runMigrations(url, { transition: { kind: "cloud", openSealed: sealedOpener(ring), log: (e) => { events.push(e); } } });
    });
    a = postgres(fresh.url, quiet);
    b = postgres(moved.url, quiet);
  }, MIGRATED_DB_SETUP_BUDGET_MS);

  afterAll(async () => {
    await a?.end({ timeout: 5 });
    await b?.end({ timeout: 5 });
    await fresh.drop();
    await moved.drop();
  }, MIGRATED_DB_TEARDOWN_BUDGET_MS);

  it("hold the same catalog, line for line", async () => {
    const [made, wasMoved] = [await fingerprintOf(a), await fingerprintOf(b)];
    expect(wasMoved.catalog.split("\n").length).toBeGreaterThan(1500);
    // By line, so a difference is named: what one has and the other lacks.
    const lines = (text: string): Set<string> => new Set(text.split("\n"));
    const [left, right] = [lines(made.catalog), lines(wasMoved.catalog)];
    expect({ onlyFromEmpty: [...left].filter((l) => !right.has(l)), onlyMoved: [...right].filter((l) => !left.has(l)) })
      .toEqual({ onlyFromEmpty: [], onlyMoved: [] });
    expect(Object.keys(wasMoved.counts).sort()).toEqual(Object.keys(made.counts).sort());
    expect(Object.keys(made.counts).sort()).toEqual(tablesOf("cloud"));
  });

  it("record the same journal entries, hash for hash", async () => {
    const [made, wasMoved] = [await fingerprintOf(a), await fingerprintOf(b)];
    expect(wasMoved.ledgers).toBe(made.ledgers);
  });

  it("the moved store holds, table by table, the count the map's formula gave of the store before", async () => {
    const after = await fingerprintOf(b);
    for (const table of tablesOf("cloud")) {
      const rows = MAP_2_0[table]!.rows;
      if (rows === "same") expect(after.counts[table], table).toBe(before.counts[table]);
      if (rows === "empty") expect(after.counts[table], table).toBe(0);
    }
    expect(after.counts.pass_progress).toBe(planted.passRows.length);
    expect(after.counts.account_counters).toBe(planted.countersMoved.length);
    expect(after.counts.auth_throttle).toBe(planted.countersStayed.length);
    expect(events.filter((e) => e.type === "check")).toEqual([]);
    expect(events.at(-1)?.type).toBe("committed");
  });
});
