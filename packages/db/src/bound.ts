/**
 * THE ACCOUNT'S BINDING ON A DATABASE HANDLE: its two types, and the one function that mints them.
 *
 * A request or a pass names the account its statements run for once, here, and the handle it gets
 * back carries that name to every transaction and savepoint opened on it. The types are brands
 * that exist only in the type system, so a `BoundDb` cannot be written down without calling
 * {@link bindDb}: a context built on a plain handle does not compile. The runtime mark is a frozen
 * object this module mints and remembers; a mark it did not mint (a forgery, or one from a second
 * copy of this module) is refused, and a key's value never sits on a handle at all.
 *
 * A bound handle is a view of its pool handle. Where the pool's factory registered a door (every
 * server pool, `client.ts`), the view's statements and transactions run in flights that write the
 * binder's statement right after BEGIN, before anything is read; a device store (PGlite, SQLite)
 * has no role and no policy, and gets the type and the mark and no statement. No driver import
 * here, so every store can use it.
 */
import { BINDING_BRAND, IN_TRANSACTION_BRAND, SAVEPOINT_BRAND, SERVER_POOL_BRAND } from "./dialect/index.js";
// From `logins.ts` and never `names.ts`: that one imports the staff role's grants, and this module
// loads in a device's engine.
import { ACCOUNT_SETTING, KEY_SETTING } from "./row-security/logins.js";

declare const boundTo: unique symbol;

/** A handle whose transactions run for one named account. Minted only by {@link bindDb}. */
export interface AccountBound { readonly [boundTo]: "account" }

/** A handle whose transactions run for no account: the binder ran and named none. */
export interface NothingBound { readonly [boundTo]: "nothing" }

/**
 * A handle that carries no binding: the pool's own. What a session-level statement takes (an index
 * built concurrently, a session's advisory lock, LISTEN): a flight would wrap it in a transaction.
 * A bound handle does not fit, by its brand; {@link refuseBound} says the same at run time.
 */
export interface NoBinding { readonly [boundTo]?: never }

/**
 * `D` without the brand that says it names nothing, or that it carries no binding at all. A handle
 * bound over one of those is the handle's own type with the new brand in place of the other:
 * intersecting two brands is `never`, and `never` fits every parameter unchecked. So binding the
 * pool's own handle (typed {@link NoBinding} where a file keeps it apart from its views) answers a
 * bound handle, never `never`.
 */
export type Unbranded<D> = D extends infer P & NothingBound ? P : D extends infer P & NoBinding ? P : D;

/** What a binding names: an account or none, and the key a look-up made before sign-in compares. */
export type BindTo =
  | { readonly account: string; readonly key?: string | null }
  | { readonly account: null; readonly key?: string | null };

/** What a handle's binding says, readable by anyone: the account, and whether a key is named. */
export interface Binding { readonly account: string | null; readonly keyed: boolean }

/**
 * Refusal to bind. The reason names what was wrong and the length of what was given, never the
 * value: an account id or a key in a log line is what this module exists to keep out of one.
 */
export class BindingRefusedError extends Error {
  readonly code = "binding_refused";
  constructor(readonly reason: string) {
    super(`refusing to bind this database handle: ${reason}`);
    this.name = "BindingRefusedError";
  }
}

/**
 * The binder's failure on the wire: the database did not take a transaction's binding (or a lone
 * statement's BEGIN was refused, and the statement ran alone, bound to nothing). Fixed text and the
 * SQLSTATE only: the driver's own error carries the statement's parameters, the key among them.
 * `mayHaveRun` says a lone statement may have run outside its transaction: never retry it blind.
 */
export class BindingFailedError extends Error {
  readonly code = "binding_failed";
  constructor(readonly sqlstate: string | null, readonly mayHaveRun: boolean) {
    super(`the database did not take this transaction's binding${sqlstate === null ? "" : ` (SQLSTATE ${sqlstate})`}`);
    this.name = "BindingFailedError";
  }
}

/** The longest key a binding carries; a keyed look-up compares a digest or an address, never more. */
export const BINDING_KEY_MAX = 512;

/**
 * THE BINDER'S ONE STATEMENT, and the only text in the product that writes either name: the account
 * and the key, both, in every flight (an empty string names none, and shadows any value left on the
 * session, the role or the database), local to the transaction (`true` is a literal), as bind
 * parameters through the one-flush send, never a named prepared statement. The flight requires
 * both columns to echo what it sent.
 */
export const BINDER_SQL =
  `select set_config('${ACCOUNT_SETTING}', $1, true) as account, set_config('${KEY_SETTING}', $2, true) as key`;

/** What a door writes for a binding: the binder's two parameters, `""` for none. */
export interface BindingValues { readonly account: string; readonly key: string }

/** How a pool's factory puts a binding on its wire: the drizzle session a bound view runs through. */
export interface BindingDoor { sessionFor(values: BindingValues): object }

/** Each registered pool handle's door. */
const doors = new WeakMap<object, BindingDoor>();
/** Each transaction a flight opened: how it is named again, on its own connection. */
const txDoors = new WeakMap<object, (values: BindingValues) => Promise<void>>();

/**
 * Register `handle`'s door (the factory that built it does, in `client.ts`). The handle is a
 * server pool's from here on, and says so to every transaction opened on it or on a view of it
 * ({@link onServerPool}).
 */
export function registerBindingDoor(handle: object, door: BindingDoor): void {
  doors.set(handle, door);
  Object.defineProperty(handle, SERVER_POOL_BRAND, { value: true, enumerable: false, configurable: false, writable: false });
}

/** Register how the transaction `tx` is named again (the flight that opened it does). */
export function registerTxDoor(tx: object, rename: (values: BindingValues) => Promise<void>): void {
  txDoors.set(tx, rename);
}

/** A postgres.js client sits behind `db`: the shape the factory's door must have been registered for. */
function hasDriverClient(db: object): boolean {
  let client: unknown;
  // A wrapper of a bound view reads the view's own refusal here: a view answers nothing through
  // `$client`, and is no driver's own handle.
  try { client = (db as { $client?: unknown }).$client; } catch { return false; }
  return typeof client === "function" && typeof (client as { unsafe?: unknown }).unsafe === "function";
}

/** Why `account` is not an account id this binder takes, or null. One loop, no pattern, no repair. */
function accountRefusal(account: unknown): string | null {
  if (typeof account !== "string") return `an account of type ${account === null ? "null" : typeof account}, not a string`;
  if (account.length !== 36) return `an account of ${account.length} characters, not 36`;
  for (let i = 0; i < 36; i++) {
    const c = account.charCodeAt(i);
    const ok = i === 8 || i === 13 || i === 18 || i === 23
      ? c === 45
      : (c >= 48 && c <= 57) || (c >= 97 && c <= 102);
    if (!ok) return `an account of 36 characters that is not a lower-case id (position ${i})`;
  }
  return null;
}

/** Why `key` is not a key this binder takes, or null. `undefined` and `null` name none. */
function keyRefusal(key: unknown): string | null {
  if (key === undefined || key === null) return null;
  if (typeof key !== "string") return `a key of type ${typeof key}, not a string`;
  if (key.length === 0) return "an empty key (no key is null)";
  if (key.length > BINDING_KEY_MAX) return `a key of ${key.length} characters, over ${BINDING_KEY_MAX}`;
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return `a key of ${key.length} characters with a control character (position ${i})`;
    // A lone surrogate would reach the wire as U+FFFD: a different key than the caller named.
    if (c >= 0xdc00 && c <= 0xdfff) return `a key of ${key.length} characters that is not well-formed text (position ${i})`;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < key.length ? key.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return `a key of ${key.length} characters that is not well-formed text (position ${i})`;
      i++;
    }
  }
  return null;
}

/** The marks this copy minted: frozen, so a mark cannot be edited into another account. */
const minted = new WeakSet<object>();
/** A key's value, beside its mark and never on a handle. */
const keys = new WeakMap<object, string>();
/** A bound view's pool handle. */
const roots = new WeakMap<object, object>();
/** Each pool handle's own token for {@link poolKeyOf}. */
const poolKeys = new WeakMap<object, object>();
/** Each pool handle's one nothing-bound view without a key: it carries no request state. */
const nothingViews = new WeakMap<object, object>();

function mint(account: string | null, key: string | null): Binding {
  const mark: Binding = Object.freeze({ account, keyed: key !== null });
  minted.add(mark);
  if (key !== null) keys.set(mark, key);
  return mark;
}

/** The mark a handle carries: one this copy minted, `"foreign"` for any other value, or none. */
function markOf(db: unknown): Binding | "foreign" | undefined {
  if (db === null || typeof db !== "object") return undefined;
  const mark = (db as Record<symbol, unknown>)[BINDING_BRAND];
  if (mark === undefined) return undefined;
  return typeof mark === "object" && mark !== null && minted.has(mark) ? mark as Binding : "foreign";
}

function refuse(reason: string): never {
  throw new BindingRefusedError(reason);
}

/** The binder's parameters for `mark`. */
function valuesOf(mark: Binding): BindingValues {
  return { account: mark.account ?? "", key: keys.get(mark) ?? "" };
}

/**
 * A view of `root` that carries `mark`. Where `root`'s factory registered a door, the view's own
 * session puts the binding at the head of every transaction and lone statement; a device store has
 * none, and its view sends what `root` sends. Drizzle's relational builders and the raw client were
 * built over the pool's own session, so on a view they answer nothing.
 */
function viewOf(root: object, mark: Binding): object {
  const view = Object.create(root) as object;
  Object.defineProperty(view, BINDING_BRAND, { value: mark, enumerable: false, configurable: false, writable: false });
  const door = doors.get(root);
  if (door !== undefined) {
    Object.defineProperty(view, "session", {
      value: door.sessionFor(valuesOf(mark)), enumerable: false, configurable: false, writable: false,
    });
  }
  for (const side of ["query", "_", "$client"]) {
    Object.defineProperty(view, side, {
      get: () => refuse(`a bound handle answers nothing through ${side === "_" ? "its internals" : side}`),
      enumerable: false, configurable: false,
    });
  }
  roots.set(view, root);
  return view;
}

/** Handles the binder refuses outright: the staff handle, which reads as no account by its role. */
const unbindable = new WeakSet<object>();

/** Never bind `db` (the staff handle's factory says so of its handle). */
export function refuseBinding(db: object): void {
  unbindable.add(db);
}

/**
 * BIND A HANDLE TO AN ACCOUNT, OR TO NOTHING. The one way to a {@link AccountBound} or a
 * {@link NothingBound} handle. Refused, before anything is written: an account that is not a
 * lower-case id (`""` included: no account is `null`), a key that is empty, over
 * {@link BINDING_KEY_MAX} or holds a control character, a handle inside a transaction (that is
 * `rebindTx`'s), a second account on a bound handle or nothing on an account-bound one, a mark this
 * copy did not mint, and a handle whose factory refused binding. An id with no account behind it
 * binds: the binder asks the database nothing.
 */
export function bindDb<D extends object>(db: D, to: { readonly account: string; readonly key?: string | null }): Unbranded<D> & AccountBound;
export function bindDb<D extends object>(db: D, to: { readonly account: null; readonly key?: string | null }): Unbranded<D> & NothingBound;
export function bindDb(db: object, to: BindTo): object {
  if (to === null || typeof to !== "object") refuse("no binding was named");
  const account = to.account;
  if (account !== null) {
    const why = accountRefusal(account);
    if (why !== null) refuse(why);
  }
  const keyWhy = keyRefusal(to.key);
  if (keyWhy !== null) refuse(keyWhy);
  if (db === null || typeof db !== "object") refuse("there is no handle");
  if ((db as Record<symbol, unknown>)[IN_TRANSACTION_BRAND] === true) {
    refuse("the handle is inside a transaction; a transaction is named again with rebindTx");
  }
  const held = markOf(db);
  if (held === "foreign") refuse("the handle carries a binding this module did not mint");
  if (held !== undefined) {
    if (held.account !== null && account !== held.account) {
      refuse(account === null ? "the handle is bound to an account, and nothing is not a narrower binding"
        : "the handle is bound to another account");
    }
  }
  // A copy or a wrapper of a bound view (a test's double, an object made over one) carries the
  // view's mark and is no view this module made. On a server its statements would ride the wrapped
  // view's own binding whatever was named here: refused. On a device's store no statement carries
  // a binding, and the wrapper is bound as any handle is.
  if (held !== undefined && !roots.has(db) && onServerPool(db)) {
    refuse("the handle is a wrapper of a bound one; wrap the pool's own handle, then bind");
  }
  const root = roots.get(db) ?? db;
  if (unbindable.has(root)) refuse("this handle's factory refuses a binding");
  // A driver handle the factory did not register would be bound in type and plain on the wire.
  if (!doors.has(root) && hasDriverClient(root)) refuse("a postgres.js handle its factory did not register");
  const key = to.key ?? null;
  if (account === null && key === null) {
    const shared = nothingViews.get(root);
    if (shared !== undefined) return shared;
    const view = viewOf(root, mint(null, null));
    nothingViews.set(root, view);
    return view;
  }
  return viewOf(root, mint(account, key));
}

/**
 * NAME A TRANSACTION AGAIN, inside it. The key may be named any number of times; the account once,
 * in a transaction that began bound to nothing, and never changed or taken back. Only the outermost
 * handle of a transaction opened on a bound handle: a rolled-back savepoint would take a local
 * setting back while its mark said otherwise. The mark changes once the binding stands.
 */
export function rebindTx<D extends object>(tx: D & NothingBound, to: { readonly account: string; readonly key?: string | null }): Promise<D & AccountBound>;
export function rebindTx<D extends AccountBound | NothingBound>(tx: D, to: { readonly key: string | null }): Promise<D>;
export async function rebindTx(tx: object, to: { readonly account?: string; readonly key?: string | null }): Promise<object> {
  if (to === null || typeof to !== "object") refuse("no binding was named");
  const naming = "account" in to;
  if (naming) {
    const why = accountRefusal(to.account);
    if (why !== null) refuse(why);
  }
  const keyWhy = keyRefusal(to.key);
  if (keyWhy !== null) refuse(keyWhy);
  if (tx === null || typeof tx !== "object") refuse("there is no handle");
  const from = tx as Record<symbol, unknown>;
  if (from[IN_TRANSACTION_BRAND] !== true) refuse("the handle is not a transaction; a handle is bound with bindDb");
  if (from[SAVEPOINT_BRAND] === true) refuse("the handle is a savepoint; only the outermost transaction is named again");
  const held = markOf(tx);
  if (held === undefined) refuse("the transaction was not opened on a bound handle");
  if (held === "foreign") refuse("the transaction carries a binding this module did not mint");
  if (naming && held.account !== null) refuse("the transaction is bound to an account already");
  const account = naming ? to.account! : held.account;
  const mark = mint(account, to.key ?? null);
  // On a server the binder's statement goes first, on the transaction's own connection; the mark
  // follows only once the database has echoed it.
  await txDoors.get(tx)?.(valuesOf(mark));
  Object.defineProperty(tx, BINDING_BRAND, { value: mark, enumerable: false, configurable: true, writable: false });
  return tx;
}

/**
 * A transaction handle opened on `parent`, typed as `parent` is, its binding checked. A bound
 * parent's transaction carries the same binding (the transaction wrapper copies it); anything else
 * is a handle that lost its account on the way, and is refused. The dialect brand is the wrapper's
 * too, and where a caller carries it by hand (`carryDialect`) it does so before this.
 */
export function carryBinding<P extends object>(parent: P, tx: object): P {
  const from = markOf(parent);
  const into = markOf(tx);
  if (from === "foreign" || into === "foreign") refuse("a handle carries a binding this module did not mint");
  if (from !== into) refuse("the transaction does not carry its handle's binding");
  return tx as P;
}

/** The binding `db` carries, or `undefined` for a plain handle. A key's value is never answered. */
export function bindingOf(db: unknown): Binding | undefined {
  const mark = markOf(db);
  return mark === "foreign" ? undefined : mark;
}

/**
 * Is `db` a server pool's handle, a bound view of one, or a transaction opened on either? True
 * where the pool's factory registered a door (`client.ts`): there a role and its policies stand
 * behind every statement. A device store (PGlite, SQLite) has no door and answers false, and so
 * does the staff handle, whose role is its whole binding.
 */
export function onServerPool(db: unknown): boolean {
  if (db === null || typeof db !== "object") return false;
  return doors.has(roots.get(db) ?? db) || (db as Record<symbol, unknown>)[SERVER_POOL_BRAND] === true;
}

/**
 * REFUSE A HANDLE THAT DOES NOT NAME `account` (`null`: no account). What a caller that holds both
 * a handle and the account it acts for asks before it opens a transaction: the two came by separate
 * ways, and here they must agree. Refused: a mark this copy did not mint; a handle that names
 * another account, or nothing where an account is asked, or an account where none is; and a handle
 * with no binding at all. With `"device"` that last one passes off a server pool and is refused on
 * one, a transaction opened on the pool's own handle included: the two fences of this package,
 * which a device's organizer reaches on its plain store. The reason is fixed text and never an id.
 */
export function assertBinding<D extends object>(db: D, account: string): asserts db is D & AccountBound;
export function assertBinding<D extends object>(db: D, account: null): asserts db is D & NothingBound;
export function assertBinding<D extends object>(db: D, account: string | null): asserts db is D & (AccountBound | NothingBound);
export function assertBinding(db: object, account: string | null, unmarked: "device"): void;
export function assertBinding(db: object, account: string | null, unmarked?: "device"): void {
  const held = markOf(db);
  if (held === "foreign") refuse("the handle carries a binding this module did not mint");
  if (held === undefined) {
    if (unmarked === "device" && !onServerPool(db) && !unbindable.has(rootOf(db))) return;
    refuse("a transaction was asked on a handle that names no binding");
  }
  if (held.account !== account) refuse("the context's account is not the one its handle names");
}

/**
 * REFUSE A BOUND HANDLE where a session-level statement is about to be sent: `what` names the
 * caller in the refusal. Thrown before anything is written; a plain handle passes.
 */
export function refuseBound(db: unknown, what: string): void {
  if (markOf(db) !== undefined) refuse(`${what} runs on the pool's own handle, never on a bound one: its statements are the session's`);
}

/**
 * The key a binding names, for the door that writes it, or null. Not exported from the package:
 * only this module and the pool's door read a key's value.
 */
export function keyOfBinding(mark: Binding): string | null {
  return minted.has(mark) ? keys.get(mark) ?? null : null;
}

/** The pool handle a bound view came from, or `db` itself. */
export function rootOf<T extends object>(db: T): T {
  return (roots.get(db) ?? db) as T;
}

/** A view of `handle` with the binding `like` carries (a derived handle of a bound one), or `handle`. */
export function bindLike<T extends object>(handle: T, like: unknown): T {
  const mark = markOf(like);
  if (mark === undefined) return handle;
  if (mark === "foreign") refuse("the handle carries a binding this module did not mint");
  return viewOf(rootOf(handle), mark) as T;
}

/**
 * An opaque token per pool handle, the same for every view bound over it: what a memo of a fact
 * about the store (a probe, a marker) is keyed by, so a request's own view does not ask again.
 */
export function poolKeyOf(db: object): object {
  const root = rootOf(db);
  let token = poolKeys.get(root);
  if (token === undefined) {
    token = Object.freeze(Object.create(null) as object);
    poolKeys.set(root, token);
  }
  return token;
}
