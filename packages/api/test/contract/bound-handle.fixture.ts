import { bindDb, bindingOf, rebindTx, type AccountBound, type NoBinding, type NothingBound } from "@trafficflow/db";
import { ensureHotPathIndexes, ensureSearchExtensions } from "@trafficflow/db/admin";
import type { AdminDb, Roster, RosterDb } from "@trafficflow/db/cloud";
import {
  dbFor, passContext, resolveSession, runAccountLifecyclePass, runAwayResponderPass, runOwedSentCopyPass,
  runScheduledSendPass, runSendReconcilePass, runStorageMailPass, sweepAgedScheduledFiles, sweepScheduledSendFiles,
  type BoundDb, type ContextDb, type Db, type ServiceContext, type UnboundDb,
} from "@trafficflow/services";
import { doorDb, serviceContext } from "../../src/context.js";
import type { ApiDeps, AttachmentStagingFactory } from "../../src/deps.js";
import { recordStaffEvents, staffDb } from "../../src/staff-audit.js";

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

// ── A PLAIN HANDLE NO LONGER COMPILES ─────────────────────────────────────────────────────────
// The pool's own handle reaches nothing that runs a request's or a pass's statement. Each
// directive below is one place it used to fit.

// A request's container holds a minted handle: bound to nothing by its host, to an account by its session.
export const mintedDeps: Pick<ApiDeps, "db"> = { db: unbound };
export const boundDeps: Pick<ApiDeps, "db"> = { db: bound };
// @ts-expect-error — a container on the pool's own handle: its routes would run for no named account.
export const plainDeps: Pick<ApiDeps, "db"> = { db: plain };
// @ts-expect-error — nor on the roster's handle.
export const rosterDeps: Pick<ApiDeps, "db"> = { db: roster };
// @ts-expect-error — nor on the staff's.
export const staffDeps: Pick<ApiDeps, "db"> = { db: staff };
// @ts-expect-error — the session doors' second handle is minted too.
export const plainSessionDb: Pick<ApiDeps, "sessionDb"> = { sessionDb: () => plain };
// The request's handle is exactly the context's: either minted type, and nothing else.
export type DepsHoldAContextsHandle = Expect<Equal<ApiDeps["db"], ContextDb>>;
export type ContextDbIsTheTwo = Expect<Equal<ContextDb, BoundDb | UnboundDb>>;

/** True when `T`, or what a function member answers, is a database handle that carries no binding. */
type IsPlainHandle<T> = [T] extends [never] ? false : T extends Db ? (T extends AccountBound | NothingBound ? false : true) : false;
type AnswersPlain<T> =
  IsPlainHandle<NonNullable<T>> extends true ? true
  : NonNullable<T> extends (...args: never[]) => infer R ? (IsPlainHandle<Awaited<R>> extends true ? true : false)
  : false;
// The staff's handle is its role's and never bound (`adminDb`): it is the one member that answers a handle with no binding.
type PlainMembers = { [K in keyof ApiDeps]-?: AnswersPlain<ApiDeps[K]> extends true ? K : never }[keyof ApiDeps];
export type NoPlainHandleOnDeps = Expect<Equal<Exclude<PlainMembers, "adminDb">, never>>;
// The positive control of that reading: a member typed by the pool's own handle is seen.
export type APlainMemberIsSeen = Expect<Equal<AnswersPlain<Db>, true>>;
export type APlainFactoryIsSeen = Expect<Equal<AnswersPlain<() => Promise<Db>>, true>>;
export type AMintedMemberIsNot = Expect<Equal<AnswersPlain<ContextDb>, false>>;

// The upload staging is built over the request's handle.
declare const staging: AttachmentStagingFactory;
export const stagedOnTheRequest = staging(bound);
// @ts-expect-error — never over the pool's own.
export const stagedOnPlain = staging(plain);

// The binder answers a handle, never `never`, whatever it is bound over.
declare const own: Db & NoBinding;
export function binderAnswers(): void {
  const overNothing = bindDb(unbound, { account: "" });
  const overTheOwn = bindDb(own, { account: "" });
  const nothingOverTheOwn = bindDb(own, { account: null });
  const accountOverNothing: Expect<Equal<typeof overNothing, BoundDb>> = true;
  const accountOverTheOwn: Expect<Equal<typeof overTheOwn, BoundDb>> = true;
  const nothingOverOwn: Expect<Equal<typeof nothingOverTheOwn, UnboundDb>> = true;
  void [accountOverNothing, accountOverTheOwn, nothingOverOwn];
}
// @ts-expect-error — and a bound handle is not the pool's own: a session-level statement takes no view.
export const viewAsTheOwn: Db & NoBinding = bound;
// @ts-expect-error — the search set-up runs on the pool's own handle.
void ensureSearchExtensions(bound);
// @ts-expect-error — and so do the hot-path indexes, on a view bound to nothing as on one bound to an account.
void ensureHotPathIndexes(unbound);

// A context's handle for an account is bound to an account, and to nothing never.
export type DbForAnswersBound = Expect<Equal<ReturnType<typeof dbFor>, BoundDb>>;

// A pass walks a handle bound to nothing, and binds each row's account over it.
declare const passDeps: never;
export const walked = passContext(unbound, "", { userId: null, now: () => new Date(0), requestId: "" });
// @ts-expect-error — a pass's row is not bound over the pool's own handle.
export const walkedPlain = passContext(plain, "", { userId: null, now: () => new Date(0), requestId: "" });
// @ts-expect-error — nor over a handle that names another account already.
export const walkedBound = passContext(bound, "", { userId: null, now: () => new Date(0), requestId: "" });
export const passes = [
  () => runScheduledSendPass(unbound, passDeps), () => runSendReconcilePass(unbound, passDeps),
  () => runOwedSentCopyPass(unbound, passDeps), () => runAwayResponderPass(unbound, passDeps),
  () => runAccountLifecyclePass(unbound, passDeps), () => runStorageMailPass(unbound, passDeps),
  () => sweepScheduledSendFiles(unbound), () => sweepAgedScheduledFiles(unbound, new Date(0)),
];
export const passesOnPlain = [
  // @ts-expect-error — each pass entry refuses the pool's own handle.
  () => runScheduledSendPass(plain, passDeps),
  // @ts-expect-error
  () => runSendReconcilePass(plain, passDeps),
  // @ts-expect-error
  () => runOwedSentCopyPass(plain, passDeps),
  // @ts-expect-error
  () => runAwayResponderPass(plain, passDeps),
  // @ts-expect-error
  () => runAccountLifecyclePass(plain, passDeps),
  // @ts-expect-error
  () => runStorageMailPass(plain, passDeps),
  // @ts-expect-error
  () => sweepScheduledSendFiles(plain),
  // @ts-expect-error
  () => sweepAgedScheduledFiles(plain, new Date(0)),
];
export const passesOnAnAccount = [
  // @ts-expect-error — and a handle bound to one account: a pass walks rows of many.
  () => runScheduledSendPass(bound, passDeps),
  // @ts-expect-error
  () => runSendReconcilePass(bound, passDeps),
  // @ts-expect-error
  () => runOwedSentCopyPass(bound, passDeps),
  // @ts-expect-error
  () => runAwayResponderPass(bound, passDeps),
  // @ts-expect-error
  () => runAccountLifecyclePass(bound, passDeps),
  // @ts-expect-error
  () => runStorageMailPass(bound, passDeps),
  // @ts-expect-error
  () => sweepScheduledSendFiles(bound),
  // @ts-expect-error
  () => sweepAgedScheduledFiles(bound, new Date(0)),
];

// The session's look-up runs before any account is bound: on a handle bound to nothing.
export const lookedUp = () => resolveSession(unbound, "", new Date(0));
// @ts-expect-error — not on the pool's own handle.
export const lookedUpPlain = () => resolveSession(plain, "", new Date(0));
// @ts-expect-error — and not on a handle that names an account.
export const lookedUpBound = () => resolveSession(bound, "", new Date(0));

// The operators' trail is written on the staff door's handle.
export const trail = () => recordStaffEvents(staffDb(deps), []);
export const door: UnboundDb = doorDb(deps);
// @ts-expect-error — not on the pool's own handle.
export const trailPlain = () => recordStaffEvents(plain, []);
// @ts-expect-error — and never on a customer's.
export const trailBound = () => recordStaffEvents(bound, []);
