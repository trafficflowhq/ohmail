/**
 * THE READ-FLIGHT REGISTRY: a pooled handle (`makePooledDb`) is paired with a second handle over the
 * same pool whose `transaction` sends begin, the callback's statements and commit without waiting
 * between them (`client.ts#withReadFlight`). Its own module, with no driver import, so a store
 * without a pool (PGlite, the phone) can ask and be told there is none.
 */
const flights = new WeakMap<object, object>();

/** Pair `handle` with its read-flight handle. */
export function registerReadFlight(handle: object, flight: object): void {
  flights.set(handle, flight);
}

/** The read-flight handle paired with `db`, or `undefined` for a handle that has none. Read-only. */
export function readFlightOf<T extends object>(db: T): T | undefined {
  return flights.get(db) as T | undefined;
}
