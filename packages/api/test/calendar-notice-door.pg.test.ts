import { afterAll, describe, expect, it } from "vitest";
import { makeOwnedDb, readLock, type OwnedDb } from "@trafficflow/db/cloud";
import { MIGRATOR_ROLE, PG_MAJORS, ownServersAvailable, startLockGround, type LockGround } from "@trafficflow/db/testing";
import type { Db } from "@trafficflow/services";
import { noticeDoorSuite, type DoorWorld } from "./_calendar-notice-door-suite.js";

/**
 * THE DOOR A CALENDAR'S PROVIDER RINGS, ON A REAL POSTGRES WITH THE LOCK FORCED, AS THE API'S OWN
 * LOGIN. The server is this file's own, with the roles the Cloud has, made the way the Cloud makes
 * them; the lock is the setup's; every request runs as `ohmail_api`, and everything planted or read
 * back goes through the migrator, which the lock does not hold.
 *
 * What only this ground shows: the channel's row is found by its id as the transaction's key and by
 * nothing else, and the pull moves a row only on a handle bound to the row's own account. A pull
 * that named no account would move no row here and raise nothing, and the first case counts rows.
 */
const FILE = "packages/api/test/calendar-notice-door.pg.test.ts";
const OWN = ownServersAvailable(FILE);

const grounds: Array<{ g: LockGround; api: OwnedDb; mig: ReturnType<LockGround["connectAs"]> }> = [];
afterAll(async () => {
  for (const { g, api, mig } of grounds) {
    await api.close();
    await mig.end({ timeout: 5 });
    g.stop();
  }
});

for (const major of PG_MAJORS) {
  describe.skipIf(!OWN)(`as ohmail_api under the forced lock, on Postgres ${major}`, () => {
    let world: DoorWorld | undefined;
    const open = async (): Promise<DoorWorld> => {
      if (world !== undefined) return world;
      const g = await startLockGround(major, `notices_${major}`, "ground");
      await g.setup("ground");
      await g.makeRoles("ground");
      await g.setup("ground", MIGRATOR_ROLE, { lock: "apply" });
      const mig = g.connectAs("ground", MIGRATOR_ROLE);
      const api = makeOwnedDb(g.urlAs("ground", "ohmail_api"), { role: "api" });
      grounds.push({ g, api, mig });
      world = {
        api: api.db as unknown as Db,
        sql: async (text, params = []) => [...await mig.unsafe(text, params as never[])] as Record<string, unknown>[],
        close: async () => {},
      };
      return world;
    };

    noticeDoorSuite(`as ohmail_api under the forced lock, on Postgres ${major}`, open);

    it("stands on a lock that is on and forced for the login the requests run as", async () => {
      const w = await open();
      const { g } = grounds[grounds.length - 1]!;
      // The cases above planted their channels: the store holds them, and the migrator reads them.
      expect(Number((await w.sql("select count(*)::int as n from cal_push_channels"))[0]!.n)).toBeGreaterThan(10);
      const login = g.connectAs("ground", "ohmail_api");
      try {
        const lock = await readLock(login, { role: "ohmail_api" });
        expect({ verdict: lock.verdict, why: lock.why, bypass: lock.role.bypass, policies: lock.role.policies })
          .toEqual({ verdict: "locked", why: [], bypass: false, policies: "equal" });
        expect(lock.forced).toBe(lock.listed);
        // With no key and no account named, the login reads no channel at all: the door's key is what finds one.
        expect([...await login.unsafe("select count(*)::int as n from cal_push_channels")]).toEqual([{ n: 0 }]);
      } finally {
        await login.end({ timeout: 5 });
      }
    }, 300_000);
  });
}
