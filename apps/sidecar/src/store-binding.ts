import { bindDb, type AccountBound, type NoBinding, type NothingBound } from "@trafficflow/db";
import { passContext, type PassContext } from "@trafficflow/services/mail";
import type { LocalDb } from "./db.js";

/**
 * WHOM A HANDLE OF THIS DEVICE'S STORE ACTS FOR, and the one file of this app that binds one.
 *
 * A device's store holds one account, its world's (`identity.ts`), and has no role and no policy:
 * a bound handle here is a type and a mark, and sends what the store's own handle sends. The mark
 * is what the shared code reads where it holds a handle and an account that came by separate ways
 * (`assertBinding`), on a device as on a server. Three handles stand, by whom the code that holds
 * one acts for:
 *
 * - The store's own ({@link StoreDb}), with no binding: the organizer's and the engine's own
 *   statements. It is never replaced by a view of itself: `assertBinding`'s rule for a device's
 *   store takes a handle with no mark, and a handle that names nothing names no mailbox's
 *   account and would not pass it.
 * - Bound to nothing ({@link unboundOf}): what a request holds until its session is read (its
 *   pipeline then binds it, once, to the session's account), what a session's look-up is asked
 *   on, and what a pass walks before it binds each row.
 * - Bound to the world's account ({@link ownContextOf}, {@link ownDbOf}): the engine's own work
 *   for the one account this store holds, where no request stands behind it.
 */

/**
 * A device store's own handle. A bound view does not fit, by its brand. It is bound through this
 * file's functions alone, which take it as a `LocalDb`: handed to the binder under this type, the
 * two brands meet and the answer is typed `never`, which fits every parameter unchecked.
 */
export type StoreDb = LocalDb & NoBinding;

/** A view of a device's store that names no account and carries no key. */
export type UnboundLocalDb = LocalDb & NothingBound;

/** A view of a device's store that names one account. */
export type BoundLocalDb = LocalDb & AccountBound;

/** The view of `store` that names no account. One for each store: the binder keeps it. */
export function unboundOf(store: LocalDb): UnboundLocalDb {
  return bindDb(store, { account: null });
}

/**
 * The view of `store` bound to `world`'s account, the one account the store holds: what a
 * container of the engine's own is handed, for a dial no request's container reaches.
 */
export function ownDbOf(store: LocalDb, world: { readonly accountId: string }): BoundLocalDb {
  return bindDb(store, { account: world.accountId });
}

/**
 * A CONTEXT OF THE ENGINE'S OWN, for work no request stands behind: bound to `world`'s account.
 * The handle and the context's account come from the one world, so they cannot disagree; and the
 * world is the one the engine was started over, never a session's, never a mailbox row's, never
 * an id a request or another device named. No user stands behind it.
 */
export function ownContextOf(
  store: LocalDb,
  world: { readonly accountId: string },
  rest: { readonly now: () => Date; readonly requestId: string },
): PassContext {
  return passContext(unboundOf(store), world.accountId, { userId: null, now: rest.now, requestId: rest.requestId });
}
