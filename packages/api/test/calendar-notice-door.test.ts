import { makeTestDb } from "@trafficflow/db/testing";
import type { Db } from "@trafficflow/services";
import { noticeDoorSuite, type DoorWorld } from "./_calendar-notice-door-suite.js";

/**
 * The door's cases on an in-process store, where no server is at hand. It has no roles and no
 * lock: what only the lock can show (a pull that named no account moves no row) is the Postgres
 * twin's, `calendar-notice-door.pg.test.ts`.
 */
noticeDoorSuite("on an in-process store", async (): Promise<DoorWorld> => {
  const db = await makeTestDb();
  const client = (db as unknown as { $client: { query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> } }).$client;
  return {
    api: db as unknown as Db,
    sql: async (text, params = []) => (await client.query(text, [...params])).rows,
    close: async () => {},
  };
});
