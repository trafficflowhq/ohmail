/**
 * THE READ-FLIGHT REGISTRY: a pooled handle (`makePooledDb`) is paired with a second handle over the
 * same pool whose `transaction` sends begin, the callback's statements and commit without waiting
 * between them (`client.ts#withReadFlight`). Its own module, with no driver import, so a store
 * without a pool (PGlite, the phone) can ask and be told there is none.
 */
import { bindLike, rootOf } from "./bound.js";

const flights = new WeakMap<object, object>();
/** A bound view's flight, carrying the view's binding: one per view. */
const viewFlights = new WeakMap<object, object>();

/** Pair `handle` with its read-flight handle. */
export function registerReadFlight(handle: object, flight: object): void {
  flights.set(handle, flight);
}

/**
 * The read-flight handle paired with `db`, or `undefined` for a handle that has none. Read-only.
 * A bound view is answered with its pool's flight, bound as the view is.
 */
export function readFlightOf<T extends object>(db: T): T | undefined {
  const own = flights.get(db);
  if (own !== undefined) return own as T;
  const root = rootOf(db);
  if (root === db) return undefined;
  const flight = flights.get(root);
  if (flight === undefined) return undefined;
  let bound = viewFlights.get(db);
  if (bound === undefined) {
    bound = bindLike(flight, db);
    viewFlights.set(db, bound);
  }
  return bound as T;
}
