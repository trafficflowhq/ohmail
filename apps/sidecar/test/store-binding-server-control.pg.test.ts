import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { assertBinding, bindingOf, BindingRefusedError, onServerPool } from "@trafficflow/db";
import { makeOwnedDb, type OwnedDb } from "@trafficflow/db/cloud";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { openLocalDb, type OpenLocalDb } from "../src/db.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE CONTROL FOR A DEVICE'S OWN HANDLE, on a real server.
 *
 * A device's organizer writes on its store's own handle, which carries no binding, and the rule
 * its writers are held to takes that handle (`store-binding.test.ts`). This asks the same rule of
 * the same kind of handle where a role and its policies stand behind every statement: a server
 * pool's own, as the product's factory makes it. There it is refused. So what lets the device's
 * handle through is the store it stands on, and no handle with no binding passes anywhere else.
 */
const PG_UP = await realPgAvailable();

const pools: OwnedDb[] = [];
const stores: OpenLocalDb[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const p of pools.splice(0)) await p.close();
  for (const s of stores.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe.skipIf(!PG_UP)("the rule a device's writers are held to, asked of a server pool", () => {
  it("refuses the pool's own handle and takes a device store's, for the same account", async () => {
    const account = randomUUID();
    const pool = makeOwnedDb(PG_TEST_URL);
    pools.push(pool);
    // A live server pool, and its own handle: no binding, as the device's has none.
    expect((await pool.db.execute(sql`select 1 as one`)).length).toBe(1);
    expect(bindingOf(pool.db)).toBeUndefined();
    expect(onServerPool(pool.db)).toBe(true);
    let refused: unknown = null;
    try {
      assertBinding(pool.db, account, "device");
    } catch (err) {
      refused = err;
    }
    expect(refused).toBeInstanceOf(BindingRefusedError);
    expect((refused as BindingRefusedError).reason).toBe("a transaction was asked on a handle that names no binding");

    // The same question of a desktop's store on disk.
    const dir = await freshDataDir("ohmail-store-binding-control-");
    dirs.push(dir);
    const store = await openLocalDb(dir);
    stores.push(store);
    expect(bindingOf(store.db)).toBeUndefined();
    expect(onServerPool(store.db)).toBe(false);
    expect(() => assertBinding(store.db, account, "device")).not.toThrow();
  }, 60_000);
});
