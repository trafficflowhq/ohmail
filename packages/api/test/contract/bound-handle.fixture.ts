import { bindDb, bindingOf, rebindTx, type AccountBound, type NothingBound } from "@trafficflow/db";
import type { AdminDb, Roster, RosterDb } from "@trafficflow/db/cloud";
import type { BoundDb, Db, ServiceContext, UnboundDb } from "@trafficflow/services";
import { serviceContext } from "../../src/context.js";
import type { ApiDeps } from "../../src/deps.js";

/**
 * A SERVICE CONTEXT HOLDS A BOUND HANDLE, AND NOTHING ELSE COMPILES.
 *
 * No runtime code and no test: assertions that exist only as types, run by `tsc` (this directory
 * is its own project, referenced from the root). A context's handle is bound to the session's
 * account or to nothing, and only the binder mints either type. Each `@ts-expect-error` is one way
 * a request could reach the database without its account named; the line under it MUST fail to
 * compile, and the day it compiles the directive itself is the error.
 */

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

declare const plain: Db;
declare const bound: BoundDb;
declare const unbound: UnboundDb;
declare const roster: RosterDb;
declare const staff: AdminDb;
declare const deps: ApiDeps;
declare const req: Request;

const rest = { accountId: "", userId: null, now: () => new Date(0), requestId: "" };

// The positive control: a context on either bound type compiles.
export const onBound: ServiceContext = { ...rest, db: bound };
export const onUnbound: ServiceContext = { ...rest, db: unbound };
export const fromTheBinder: ServiceContext = { ...rest, db: bindDb(plain, { account: "" }) };
export const nothingFromTheBinder: ServiceContext = { ...rest, db: bindDb(plain, { account: null }) };
// The roster handle reaches a context only through the binder, as a bound handle.
export const rosterBound: BoundDb = bindDb(roster, { account: "" });

// @ts-expect-error — a context on a plain handle: its statements would run for no named account.
export const onPlain: ServiceContext = { ...rest, db: plain };
// @ts-expect-error — the roster handle reads across accounts; no request context carries it.
export const onRoster: ServiceContext = { ...rest, db: roster };
// @ts-expect-error — the staff handle answers for its role, never for an account.
export const onStaff: ServiceContext = { ...rest, db: staff };

// @ts-expect-error — bound to an account is not bound to nothing.
export const boundAsUnbound: UnboundDb = bound;
// @ts-expect-error — bound to nothing is not bound to an account.
export const unboundAsBound: BoundDb = unbound;
// @ts-expect-error — nor is either brand alone a handle.
export const brandAlone: BoundDb = {} as AccountBound;
// @ts-expect-error — nor the other brand.
export const otherBrandAlone: UnboundDb = {} as NothingBound;

// The request's context answers the union, and takes no account from its caller.
export type ContextAnswersTheUnion = Expect<Equal<ReturnType<typeof serviceContext>["db"], BoundDb | UnboundDb>>;
// @ts-expect-error — an account named by the caller: only the session's row names one.
export const pinned = serviceContext(deps, req, { accountId: "" });

// @ts-expect-error — a key's value is never readable through the binding.
export const keyRead = bindingOf(bound)?.key;

// A transaction that began bound to nothing is named an account once; one bound to an account never again.
declare const nothingTx: UnboundDb;
declare const accountTx: BoundDb;
export const namedOnce: Promise<Db & AccountBound> = rebindTx(nothingTx, { account: "" });
export const keyAgain: Promise<BoundDb> = rebindTx(accountTx, { key: null });
// @ts-expect-error — a second account on a transaction bound to one.
export const namedTwice = rebindTx(accountTx, { account: "" });

/** True when `T`, or what a function member answers, carries the roster brand. */
type CarriesRoster<T> =
  NonNullable<T> extends Roster ? true
  : NonNullable<T> extends (...args: never[]) => infer R ? (Awaited<R> extends Roster ? true : false)
  : false;
type RosterMembers = { [K in keyof ApiDeps]-?: CarriesRoster<ApiDeps[K]> extends true ? K : never }[keyof ApiDeps];
// No member of the request's container is, or answers, the roster handle.
export type NoRosterOnDeps = Expect<Equal<RosterMembers, never>>;
