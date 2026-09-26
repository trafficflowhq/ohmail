import { createHash } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { pgTransportOf, verifiedHandshakes } from "./pg-tls.js";

/** What `/health` publishes about the database transport. Two hops, named apart. */
export interface DbTlsReading {
  /** THIS process's hop: a handshake on `url`'s pools verified the chain and the host name. */
  dbTls: boolean;
  /**
   * `pg_stat_ssl` for the backend that ran the statement. Behind a pooler this is the POOLER's
   * hop into Postgres, not this process's: measured false behind the managed pooler over a verified client
   * hop, so it can never stand in for {@link DbTlsReading.dbTls}. Null when not read.
   */
  dbTlsBackend: boolean | null;
}

/** The backend hop, once read, per connection string (by digest): it does not change within a process. */
const backendHop = new Map<string, boolean>();

/**
 * Read both hops. The backend hop costs one statement the FIRST time only, so `/health` keeps its
 * one-statement budget once warm (`round-trips.pg.test.ts`); an unreadable answer is not kept.
 * `readBackend` false (the database did not answer the probe) costs no round trip at all.
 */
export async function readDbTls(
  url: string, db: { execute(query: SQL): Promise<unknown> }, readBackend: boolean,
): Promise<DbTlsReading> {
  const dbTls = pgTransportOf(url) === "verified" && verifiedHandshakes(url) > 0;
  const key = createHash("sha256").update(url).digest("hex");
  const known = backendHop.get(key);
  if (known !== undefined) return { dbTls, dbTlsBackend: known };
  if (!readBackend) return { dbTls, dbTlsBackend: null };
  try {
    const out = await db.execute(sql`select ssl from pg_stat_ssl where pid = pg_backend_pid()`);
    const rows = (Array.isArray(out) ? out : (out as { rows?: unknown[] }).rows ?? []) as Array<{ ssl?: unknown }>;
    const ssl = typeof rows[0]?.ssl === "boolean" ? rows[0].ssl : null;
    if (ssl !== null) backendHop.set(key, ssl);
    return { dbTls, dbTlsBackend: ssl };
  } catch {
    return { dbTls, dbTlsBackend: null };
  }
}
