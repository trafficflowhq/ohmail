import { makeDrizzleRepo, type DrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { bindDb, bindingOf, type AccountBound, type NothingBound } from "@trafficflow/db";
import type { OwnedDb } from "@trafficflow/db/cloud";
import { markDatabaseFaults } from "../db-fault.js";

/**
 * THE WORKER'S HANDLES, AND THE ONE PLACE IN THE WORKER THAT BINDS ONE.
 *
 * The worker's pool has two views and no other way in. `roster` names no account: the reads that
 * say which mailboxes and accounts this shard serves, and what runs for no account at all. And
 * `forAccount(id)`, bound to one account: everything done for one mailbox or one account, the
 * sync's repository included. The pool's own handle is held here and by the start file, which
 * made it; no section of the worker is handed it.
 *
 * WHICH ACCOUNT. The id handed to `forAccount` is the account of the row that named the work: the
 * roster row a mailbox was attached from, an account of the walk's own list, the row a statement
 * just read. Never an id found in a letter, a request's payload or a provider's answer. An id that
 * is no account id is refused by the binder; nothing is bound to nothing in its place.
 */

/** The worker's pool handle as its start file makes it. */
type Pool = OwnedDb["db"];

/** The view that names no account. */
export type WorkerRosterDb = Pool & NothingBound;

/** One account's handle, and the sync's repository over it. */
export interface AccountHandles {
  readonly db: Pool & AccountBound;
  readonly repo: DrizzleRepo;
}

export interface WorkerBinding {
  /** Bound to nothing: the roster's reads and what runs for no account. */
  readonly roster: WorkerRosterDb;
  /** Bound to `accountId`: its handle and its repository, the same pair until the roster is read again. */
  forAccount(accountId: string): AccountHandles;
  /** Forget every account's pair. The roster's load calls it: handles last from one reading of the roster to the next. */
  forgetAccounts(): void;
}

/**
 * The two views over `pool`. An account's pair is kept under the id it was bound for and handed
 * out again only while its handle still names that id; a pair is never found under another id.
 */
export function bindWorker(pool: Pool): WorkerBinding {
  const roster = bindDb(pool, { account: null });
  const kept = new Map<string, AccountHandles>();
  return {
    roster,
    forAccount(accountId) {
      const held = kept.get(accountId);
      if (held !== undefined && bindingOf(held.db)?.account === accountId) return held;
      const db = bindDb(pool, { account: accountId });
      // Every database call of the sync names its origin (`db-fault.ts`), on each account's repository alike.
      const made: AccountHandles = { db, repo: markDatabaseFaults(makeDrizzleRepo(db), "repo") };
      kept.set(accountId, made);
      return made;
    },
    forgetAccounts() {
      kept.clear();
    },
  };
}
