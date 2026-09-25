import type { SQL } from "drizzle-orm";
import type { Dialect } from "@trafficflow/db/dialect";

/** One turn of the event loop: every dispatch already started has reached its driver. */
const nextTurn = (): Promise<void> =>
  new Promise((resolve) => (typeof setImmediate === "function" ? setImmediate(resolve) : setTimeout(resolve, 0)));

/**
 * THE SETTINGS RIDE THE READ'S FLUSH. They carry no parameter and nothing reads their answer, so
 * they are handed to the driver and not awaited: after one turn they are queued on the transaction
 * ahead of the reads, which postgres.js writes behind them in the same flush and PGlite runs after
 * them — one round trip for the pair through a pooler. The settings must be transaction-local.
 */
export async function afterSettings<T>(db: unknown, d: Dialect, setup: SQL, reads: () => Promise<T>): Promise<T> {
  const settings = d.exec(db, setup);
  settings.catch(() => { /* a failed setting fails the transaction; rethrown below otherwise */ });
  await nextTurn();
  const out = await reads();
  await settings;
  return out;
}
