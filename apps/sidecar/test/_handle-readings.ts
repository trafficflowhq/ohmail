import { getTableName, is, Table } from "drizzle-orm";
import { bindingOf } from "@trafficflow/db";

/**
 * WHOM EACH STATEMENT'S HANDLE NAMED, read on a device's store. Not a test file.
 *
 * A device sends no binding to its store: a bound handle there is a view of the store's own, with
 * a mark. So what a server's test reads off the wire is read here off the handle a statement was
 * built on: every view inherits the store handle's builders, and each builder is made to note the
 * binding of the handle it was called on before it does what it did. A transaction's handle is
 * noted the same way, with the binding its transaction was opened under.
 */

/** `"plain"`: the store's own handle. `"nothing"`: bound to no account. `"keyed"`: no account, under a key. Else the account's id. */
export type Rode = string;

export interface HandleReading {
  readonly rode: Rode;
  readonly verb: "select" | "insert" | "update" | "delete" | "execute" | "transaction";
  /** The table the statement was built over; null for a raw statement and for a transaction's opening. */
  readonly table: string | null;
  /** Built on a transaction's handle. */
  readonly inTransaction: boolean;
}

/** A list of readings, and two questions asked of it. */
export interface Readings {
  /** The statements, in the order they were built. */
  readonly all: readonly HandleReading[];
  /** The readings over `table`. */
  of(table: string): HandleReading[];
  /** Whom the statements over `table` rode, each name once, sorted. */
  rodeOf(table: string): Rode[];
}

export interface HandleReadings extends Readings {
  /** Forget what was read so far. */
  clear(): void;
  /** What was read so far, taken out: a test's own statements after this are not among them. */
  take(): Readings;
}

function readingsOver(all: readonly HandleReading[]): Readings {
  return {
    all,
    of: (table) => all.filter((r) => r.table === table),
    rodeOf: (table) => [...new Set(all.filter((r) => r.table === table).map((r) => r.rode))].sort(),
  };
}

/** The marker the dialect's own wrapper leaves on a wrapped `transaction`, so it is not wrapped again over this one. */
const TRANSACTION_WRAPPED = Symbol.for("ohmail.db.dialect.txWrapped");

type Fn = (this: object, ...args: unknown[]) => unknown;

function rode(handle: object): Rode {
  const binding = bindingOf(handle);
  if (binding === undefined) return "plain";
  if (binding.account !== null) return binding.account;
  return binding.keyed ? "keyed" : "nothing";
}

const nameOf = (table: unknown): string | null => (is(table, Table) ? getTableName(table) : null);

/**
 * Read the handles of `store`, a device store's own handle, from now on. The builders are replaced
 * on the handle itself, where its views find them; the store's statements are unchanged.
 */
export function readHandles(store: object): HandleReadings {
  const all: HandleReading[] = [];
  const note = (handle: object, verb: HandleReading["verb"], table: string | null, inTransaction: boolean): void => {
    all.push({ rode: rode(handle), verb, table, inTransaction });
  };

  const watch = (handle: object, inTransaction: boolean): void => {
    const methods = handle as Record<string, Fn | undefined>;
    const put = (name: string, value: Fn): void => {
      Object.defineProperty(handle, name, { value, enumerable: false, configurable: true, writable: true });
    };
    for (const verb of ["insert", "update", "delete"] as const) {
      const was = methods[verb];
      if (typeof was !== "function") continue;
      put(verb, function (this: object, ...args: unknown[]) {
        note(this, verb, nameOf(args[0]), inTransaction);
        return was.apply(this, args);
      });
    }
    for (const name of ["select", "selectDistinct"] as const) {
      const was = methods[name];
      if (typeof was !== "function") continue;
      put(name, function (this: object, ...args: unknown[]) {
        const asked = this;
        const builder = was.apply(this, args) as { from: Fn };
        const from = builder.from;
        builder.from = function (this: object, ...of: unknown[]) {
          note(asked, "select", nameOf(of[0]), inTransaction);
          return from.apply(builder, of);
        };
        return builder;
      });
    }
    // A raw statement: `execute` on the desktop's store, the four spellings the phone's driver has.
    for (const name of ["execute", "run", "all", "get", "values"] as const) {
      const was = methods[name];
      if (typeof was !== "function") continue;
      put(name, function (this: object, ...args: unknown[]) {
        note(this, "execute", null, inTransaction);
        return was.apply(this, args);
      });
    }
    const transaction = methods.transaction;
    if (typeof transaction === "function") {
      const watched = function (this: object, body: unknown, ...rest: unknown[]) {
        note(this, "transaction", null, inTransaction);
        const run = body as (tx: object, ...inner: unknown[]) => unknown;
        return transaction.call(this, (tx: object, ...inner: unknown[]) => {
          watch(tx, true);
          return run(tx, ...inner);
        }, ...rest);
      };
      Object.defineProperty(watched, TRANSACTION_WRAPPED, { value: true, enumerable: false });
      put("transaction", watched);
    }
  };

  watch(store, false);
  return {
    ...readingsOver(all),
    clear: () => { all.length = 0; },
    take: () => readingsOver(all.splice(0)),
  };
}
