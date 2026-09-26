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

/** Read both hops. `readBackend` false (the database did not answer the probe) costs no round trip. */
export async function readDbTls(
  url: string, db: { execute(query: SQL): Promise<unknown> }, readBackend: boolean,
): Promise<DbTlsReading> {
  const dbTls = pgTransportOf(url) === "verified" && verifiedHandshakes(url) > 0;
  if (!readBackend) return { dbTls, dbTlsBackend: null };
  try {
    const out = await db.execute(sql`select ssl from pg_stat_ssl where pid = pg_backend_pid()`);
    const rows = (Array.isArray(out) ? out : (out as { rows?: unknown[] }).rows ?? []) as Array<{ ssl?: unknown }>;
    return { dbTls, dbTlsBackend: typeof rows[0]?.ssl === "boolean" ? rows[0].ssl : null };
  } catch {
    return { dbTls, dbTlsBackend: null };
  }
}
