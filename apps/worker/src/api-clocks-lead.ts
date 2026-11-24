import { sql } from "drizzle-orm";
import type { OwnedDb } from "@trafficflow/db/cloud";
import { API_CLOCKS_LEADER_KEY } from "./api-cron.js";

/**
 * Whether a copy of the API program leads its own clocks in THIS database right now. It holds the
 * advisory lock {@link API_CLOCKS_LEADER_KEY} for as long as it does, and Postgres lets the lock go
 * with the holder's transaction, so the lock is the fact itself: no request, no header and no row
 * an account can write sets it.
 *
 * Read from `pg_locks`, as the worker's own leader lock is verified (`leader-lock.ts`):
 * `(classid << 32) + objid` is the 64-bit key of the one-argument lock functions and `objsubid = 1`
 * names that form. The view lists the locks of every database on the server, and an advisory lock
 * belongs to one, so the row is asked for this database. Throws when the database cannot be asked;
 * the schedule reads that as "cannot tell" and pokes.
 */
export async function apiClocksLead(db: OwnedDb["db"]): Promise<boolean> {
  const rows = await db.execute(sql`
    select exists (
      select 1 from pg_locks
      where locktype = 'advisory' and granted and objsubid = 1
        and database = (select oid from pg_database where datname = current_database())
        and ((classid::bigint << 32) + objid::bigint) = ${API_CLOCKS_LEADER_KEY.toString()}::bigint
    ) as held`);
  return (rows[0] as { held?: unknown } | undefined)?.held === true;
}
