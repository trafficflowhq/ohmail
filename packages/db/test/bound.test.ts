import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  assertBinding, bindDb, bindingOf, carryBinding, onServerPool, poolKeyOf, rebindTx, refuseBound, registerBindingDoor,
  BINDER_SQL, BindingRefusedError, BINDING_KEY_MAX,
  type AccountBound, type NoBinding, type NothingBound,
} from "../src/bound.js";
import { BINDING_BRAND, brandDialect } from "../src/dialect/index.js";
import { readFlightOf, registerReadFlight } from "../src/read-flight.js";
import { makeTestDb } from "../src/testing.js";

/**
 * THE BINDER, without a server: what it takes, what it refuses, and how a binding travels from a
 * handle to its transactions. A refusal names why and never echoes what it was given; a mark it did
 * not mint is no binding; the pool handle itself is never marked.
 */

type Handle = Awaited<ReturnType<typeof makeTestDb>>;
type Tx = { transaction: <R>(fn: (tx: object) => Promise<R>) => Promise<R>; execute: Handle["execute"] };

const A = "0f6c8a2e-3b1d-4c5e-9a7f-1b2c3d4e5f60";
const B = "7d1e2f30-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

let db: Handle;
beforeAll(async () => { db = await makeTestDb(); });

/** The refusal `fn` throws, checked to carry no copy of `value`. */
function refusal(fn: () => unknown, value: unknown): BindingRefusedError {
  let caught: unknown;
  try { fn(); } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(BindingRefusedError);
  const text = (caught as Error).message;
  if (typeof value === "string" && value.trim().length > 0) expect(text).not.toContain(value);
  expect(text).not.toContain(A);
  return caught as BindingRefusedError;
}

describe("the binder refuses what is not an account, and repeats none of it", () => {
  const hostile: ReadonlyArray<readonly [string, unknown]> = [
    ["empty", ""],
    ["spaces", " ".repeat(36)],
    ["upper case", A.toUpperCase()],
    ["braces", `{${A}}`],
    ["32 hex without dashes", A.replaceAll("-", "")],
    ["35 characters", A.slice(1)],
    ["37 characters", `${A}0`],
    ["a letter past f", `${A.slice(0, 35)}g`],
    ["an id with a statement after it", `${A}'; select set_config('ohmail.account', '${B}', false); --`],
    ["ten thousand characters", "a".repeat(10_000)],
    ["a number", 12_345],
    ["an object that prints as an id", { toString: () => A }],
  ];
  for (const [name, account] of hostile) {
    it(`refuses ${name}`, () => {
      const err = refusal(() => bindDb(db, { account: account as string }), account);
      expect(err.reason.length).toBeGreaterThan(0);
    });
  }

  it("names the length it was given, so a refusal can be read without the value", () => {
    expect(refusal(() => bindDb(db, { account: "a".repeat(10_000) }), "").message).toContain("10000");
  });

  const keys: ReadonlyArray<readonly [string, unknown]> = [
    ["an empty key", ""],
    [`a key of ${BINDING_KEY_MAX + 1} characters`, "k".repeat(BINDING_KEY_MAX + 1)],
    ["a NUL in a key", "abc\u0000def"],
    ["a line break in a key", "abc\ndef"],
    ["a lone surrogate in a key", "abc\ud800def"],
    ["a key that is no string", 42],
  ];
  for (const [name, key] of keys) {
    it(`refuses ${name}`, () => {
      refusal(() => bindDb(db, { account: A, key: key as string }), key);
      refusal(() => bindDb(db, { account: null, key: key as string }), key);
    });
  }

  it("takes a well-formed id it has never seen: the binder asks the database nothing", () => {
    expect(bindingOf(bindDb(db, { account: randomUUID() }))?.keyed).toBe(false);
  });
});

describe("a bound handle says whom it runs for, and never its key", () => {
  it("reads the account and whether a key is named; the key's value is nowhere on it", () => {
    const view = bindDb(db, { account: A, key: "digest-of-a-code" });
    const read = bindingOf(view)!;
    expect(read).toEqual({ account: A, keyed: true });
    expect(Object.keys(read)).not.toContain("key");
    expect(JSON.stringify(read)).not.toContain("digest-of-a-code");
    expect(Object.getOwnPropertySymbols(view).map((s) => String((view as unknown as Record<symbol, unknown>)[s])))
      .not.toContain("digest-of-a-code");
    expect(bindingOf(bindDb(db, { account: null }))).toEqual({ account: null, keyed: false });
  });

  it("leaves the pool handle unmarked, and a plain handle reads no binding", () => {
    bindDb(db, { account: A });
    expect(bindingOf(db)).toBeUndefined();
    expect(bindingOf({})).toBeUndefined();
  });

  it("answers the statements as the pool does: a view sends what its pool sends", async () => {
    const view = bindDb(db, { account: A });
    const rows = await view.execute(sql`select 41 + 1 as n`);
    expect((rows as unknown as { rows: Array<{ n: number }> }).rows[0]!.n).toBe(42);
  });

  it("on a device store the binder sends no statement: a bound view's count is the plain handle's", async () => {
    type Client = { query: (...a: unknown[]) => unknown; transaction: (fn: (tx: Client) => unknown, ...r: unknown[]) => unknown };
    const client = (db as unknown as { $client: Client }).$client;
    const { query, transaction } = client;
    let sent = 0;
    client.query = function (this: Client, ...a: unknown[]) { sent++; return query.apply(this, a); };
    client.transaction = function (this: Client, fn: (tx: Client) => unknown, ...r: unknown[]) {
      sent++;
      return transaction.call(this, (tx: Client) => {
        const inner = tx.query;
        tx.query = (...a: unknown[]) => { sent++; return inner.apply(tx, a); };
        return fn(tx);
      }, ...r);
    };
    const count = async (run: () => Promise<unknown>): Promise<number> => { sent = 0; await run(); return sent; };
    try {
      const view = bindDb(db, { account: A, key: "k" }) as unknown as Tx;
      const plainTx = db as unknown as Tx;
      const plain = await count(() => db.execute(sql`select 1`));
      expect(plain).toBeGreaterThan(0);
      expect(await count(() => view.execute(sql`select 1`))).toBe(plain);
      const inTx = (h: Tx) => () => h.transaction(async (tx) => (tx as unknown as Tx).execute(sql`select 1`));
      const plainInTx = await count(inTx(plainTx));
      expect(plainInTx).toBeGreaterThan(1);
      expect(await count(inTx(view))).toBe(plainInTx);
    } finally {
      client.query = query;
      client.transaction = transaction;
    }
  });
});

describe("what may follow what", () => {
  it("binds plain to anything, nothing to an account, and the same account again", () => {
    const nothing = bindDb(db, { account: null });
    expect(bindingOf(bindDb(nothing, { account: A }))?.account).toBe(A);
    const a = bindDb(db, { account: A });
    expect(bindingOf(bindDb(a, { account: A, key: "k" }))).toEqual({ account: A, keyed: true });
  });

  it("refuses a second account, and nothing on a handle bound to an account", () => {
    const a = bindDb(db, { account: A });
    refusal(() => bindDb(a, { account: B }), B);
    refusal(() => bindDb(a, { account: null }), "");
  });

  it("shares one keyless nothing-bound view per pool handle", () => {
    expect(bindDb(db, { account: null })).toBe(bindDb(db, { account: null }));
    expect(bindDb(db, { account: null, key: "k" })).not.toBe(bindDb(db, { account: null }));
  });

  it("refuses a handle inside a transaction: that is rebindTx's", async () => {
    await (db as unknown as Tx).transaction(async (tx) => {
      refusal(() => bindDb(tx, { account: A }), "");
    });
  });
});

describe("a binding travels to every transaction and savepoint opened on the handle", () => {
  it("is carried into a transaction and a savepoint, and checked by carryBinding", async () => {
    const view = bindDb(db, { account: A }) as unknown as Tx;
    await view.transaction(async (tx) => {
      expect(bindingOf(tx)).toBe(bindingOf(view));
      expect(carryBinding(view, tx)).toBe(tx);
      await (tx as unknown as Tx).transaction(async (sp) => {
        expect(bindingOf(sp)).toBe(bindingOf(view));
      });
    });
  });

  it("refuses to carry a binding a transaction lost on the way", async () => {
    const view = bindDb(db, { account: A });
    await (db as unknown as Tx).transaction(async (plainTx) => {
      refusal(() => carryBinding(view, plainTx), "");
    });
  });
});

describe("rebindTx names a transaction again, from inside it", () => {
  it("names the account once in a transaction that began bound to nothing, then any key", async () => {
    const nothing = bindDb(db, { account: null }) as unknown as Tx;
    await nothing.transaction(async (tx) => {
      const named = await rebindTx(tx as object & NothingBound, { account: A });
      expect(bindingOf(named)).toEqual({ account: A, keyed: false });
      const keyed = await rebindTx(named as object & AccountBound, { key: "k1" });
      expect(bindingOf(keyed)).toEqual({ account: A, keyed: true });
      await expect(rebindTx(keyed as unknown as object & NothingBound, { account: B })).rejects.toBeInstanceOf(BindingRefusedError);
      expect(bindingOf(keyed)?.account).toBe(A);
    });
  });

  it("refuses a savepoint, a plain handle and a transaction not opened on a bound handle", async () => {
    const nothing = bindDb(db, { account: null }) as unknown as Tx;
    await nothing.transaction(async (tx) => {
      await (tx as unknown as Tx).transaction(async (sp) => {
        await expect(rebindTx(sp as object & NothingBound, { account: A })).rejects.toBeInstanceOf(BindingRefusedError);
      });
    });
    await expect(rebindTx(nothing as unknown as object & NothingBound, { account: A })).rejects.toBeInstanceOf(BindingRefusedError);
    await (db as unknown as Tx).transaction(async (tx) => {
      await expect(rebindTx(tx as object & NothingBound, { account: A })).rejects.toBeInstanceOf(BindingRefusedError);
    });
  });
});

describe("a mark the binder did not mint is no binding", () => {
  it("refuses a forged mark", () => {
    const forged = brandDialect(Object.create(db) as object, "pg");
    Object.defineProperty(forged, BINDING_BRAND, { value: Object.freeze({ account: A, keyed: false }) });
    expect(bindingOf(forged)).toBeUndefined();
    refusal(() => bindDb(forged, { account: A }), "");
  });

  it("refuses a mark from a second copy of the binder", async () => {
    vi.resetModules();
    const copy = await import("../src/bound.js");
    const theirs = copy.bindDb(db, { account: A });
    expect(copy.bindingOf(theirs)?.account).toBe(A);
    expect(bindingOf(theirs)).toBeUndefined();
    refusal(() => bindDb(theirs, { account: A }), "");
  });
});

describe("derived handles keep the binding and the pool", () => {
  it("keys a fact about the store by a token of the pool's own, the same for every view", () => {
    const token = poolKeyOf(db);
    expect(token).not.toBe(db);
    expect(poolKeyOf(bindDb(db, { account: A }))).toBe(token);
    expect(poolKeyOf(bindDb(db, { account: null }))).toBe(token);
    expect(poolKeyOf({})).not.toBe(token);
  });

  it("answers a bound view's read flight with the pool's, bound as the view is", () => {
    const pool = brandDialect({ name: "pool" }, "pg");
    const flight = brandDialect({ name: "flight" }, "pg");
    registerReadFlight(pool, flight);
    const view = bindDb(pool, { account: A, key: "k" });
    const viewFlight = readFlightOf(view)!;
    expect(Object.getPrototypeOf(viewFlight)).toBe(flight);
    expect(bindingOf(viewFlight)).toBe(bindingOf(view));
    expect(readFlightOf(view)).toBe(viewFlight);
    expect(readFlightOf(bindDb(db, { account: A }))).toBeUndefined();
  });
});

/** Two types are the same type, in both directions: `never` and `any` equal nothing but themselves. */
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;

describe("an account bound over a handle bound to nothing is a bound handle, in its type too", () => {
  type Plain = Handle;
  type Bound = Plain & AccountBound;
  type Unbound = Plain & NothingBound;

  it("binds nothing to an account as the handle's own type with the account's brand, never as `never`", () => {
    const plain: Plain = db;
    const unbound = bindDb(plain, { account: null });
    const bound = bindDb(plain, { account: A });
    const either = (Math.random() < 2 ? bound : unbound) as Bound | Unbound;
    const fromUnbound = bindDb(unbound, { account: A });
    const fromEither = bindDb(either, { account: A });
    const fromBound = bindDb(bound, { account: A });
    const keyedNothing = bindDb(unbound, { account: null, key: "k" });
    // Each line is a compile-time reading (`tsc -p packages/db/tsconfig.test-dirs.json`): were the
    // account's brand intersected with the other, each of these types would be `never`.
    const t1: Equal<typeof fromUnbound, Bound> = true;
    const t2: Equal<typeof fromEither, Bound> = true;
    const t3: Equal<typeof fromBound, Bound> = true;
    const t4: Equal<typeof bound, Bound> = true;
    const t5: Equal<typeof keyedNothing, Unbound> = true;
    const t6: Equal<typeof unbound, Unbound> = true;
    expect([t1, t2, t3, t4, t5, t6]).toEqual([true, true, true, true, true, true]);
    // A handle typed `never` would pass both of these; a bound one passes the first alone.
    const needsBound = (h: Bound): Bound => h;
    const needsUnbound = (h: Unbound): Unbound => h;
    expect(bindingOf(needsBound(fromUnbound))?.account).toBe(A);
    // @ts-expect-error a handle bound to an account is not one bound to nothing
    needsUnbound(fromUnbound);
    // @ts-expect-error a plain handle is neither
    needsBound(plain);
  });

  it("a session-level function's parameter takes the plain handle and no bound one", () => {
    const takesSession = (h: { execute: Plain["execute"] } & NoBinding): boolean => bindingOf(h) === undefined;
    expect(takesSession(db)).toBe(true);
    // @ts-expect-error a handle bound to an account does not fit
    expect(takesSession(bindDb(db, { account: A }))).toBe(false);
    // @ts-expect-error nor one bound to nothing
    expect(takesSession(bindDb(db, { account: null }))).toBe(false);
  });
});

describe("the binder's statement is built from the lock's two names and is the text it always was", () => {
  it("names both settings, local to the transaction, as bind parameters", () => {
    expect(BINDER_SQL).toBe(
      "select set_config('ohmail.account', $1, true) as account, set_config('ohmail.key', $2, true) as key",
    );
  });
});

describe("assertBinding refuses a handle that does not name the account asked", () => {
  it("passes a handle bound to the account, and one bound to nothing where none is asked, keyed or not", () => {
    expect(() => assertBinding(bindDb(db, { account: A }), A)).not.toThrow();
    expect(() => assertBinding(bindDb(db, { account: A, key: "k" }), A)).not.toThrow();
    expect(() => assertBinding(bindDb(db, { account: null }), null)).not.toThrow();
    expect(() => assertBinding(bindDb(db, { account: null, key: "k" }), null)).not.toThrow();
  });

  it("refuses another account, nothing where an account is asked, and an account where none is: fixed words, no id", () => {
    const wrong = [
      refusal(() => assertBinding(bindDb(db, { account: B }), A), B),
      refusal(() => assertBinding(bindDb(db, { account: null }), A), ""),
      refusal(() => assertBinding(bindDb(db, { account: null, key: "digest-of-a-code" }), A), "digest-of-a-code"),
      refusal(() => assertBinding(bindDb(db, { account: B }), null), B),
    ];
    for (const err of wrong) {
      expect(err.reason).toBe("the context's account is not the one its handle names");
      expect(err.message).not.toContain(B);
    }
  });

  it("refuses a plain handle: a transaction is asked only on a handle that names its binding", () => {
    expect(refusal(() => assertBinding(db, A), "").reason).toBe("a transaction was asked on a handle that names no binding");
    expect(refusal(() => assertBinding(db, null), "").reason).toBe("a transaction was asked on a handle that names no binding");
  });

  it("refuses a mark it did not mint", () => {
    const forged = brandDialect(Object.create(db) as object, "pg");
    Object.defineProperty(forged, BINDING_BRAND, { value: Object.freeze({ account: A, keyed: false }) });
    refusal(() => assertBinding(forged, A), "");
    refusal(() => assertBinding(forged, A, "device"), "");
  });

  it("narrows the handle it was handed to the bound type, so the caller needs no cast", () => {
    const handed: Handle = bindDb(db, { account: A });
    assertBinding(handed, A);
    const bound: Handle & AccountBound = handed;
    expect(bindingOf(bound)?.account).toBe(A);
    const nothing: Handle = bindDb(db, { account: null });
    assertBinding(nothing, null);
    const unbound: Handle & NothingBound = nothing;
    expect(bindingOf(unbound)?.account).toBeNull();
  });

  describe("the fences' rule for a handle with no binding at all", () => {
    /** A handle as a server pool's factory leaves it: a door is registered for it. */
    const pooled = (): object => {
      const pool = brandDialect({ name: "pool" }, "pg");
      registerBindingDoor(pool, { sessionFor: () => ({}) });
      return pool;
    };

    it("passes off a server pool: a device's own store names nobody and holds one person's mail", () => {
      expect(onServerPool(db)).toBe(false);
      expect(() => assertBinding(db, A, "device")).not.toThrow();
      expect(() => assertBinding(db, null, "device")).not.toThrow();
    });

    it("is refused on a server pool, where a role and its policies stand behind the statement", () => {
      const pool = pooled();
      expect(onServerPool(pool)).toBe(true);
      expect(refusal(() => assertBinding(pool, A, "device"), "").reason)
        .toBe("a transaction was asked on a handle that names no binding");
    });

    it("still refuses a handle that names another account, on a device and on a server alike", () => {
      refusal(() => assertBinding(bindDb(db, { account: B }), A, "device"), B);
      refusal(() => assertBinding(bindDb(pooled(), { account: B }), A, "device"), B);
    });
  });
});

describe("onServerPool tells a server pool's handle and its views from a device store", () => {
  it("answers true for a handle a door was registered for and for every view bound over it", () => {
    const pool = brandDialect({ name: "pool" }, "pg");
    expect(onServerPool(pool)).toBe(false);
    registerBindingDoor(pool, { sessionFor: () => ({}) });
    expect(onServerPool(pool)).toBe(true);
    expect(onServerPool(bindDb(pool, { account: A }))).toBe(true);
    expect(onServerPool(bindDb(pool, { account: null, key: "k" }))).toBe(true);
  });

  it("answers false for a device store, its views, and what is no handle", () => {
    expect(onServerPool(db)).toBe(false);
    expect(onServerPool(bindDb(db, { account: A }))).toBe(false);
    expect(onServerPool(null)).toBe(false);
    expect(onServerPool("pool")).toBe(false);
  });
});

describe("refuseBound keeps a bound handle away from a session-level statement", () => {
  it("passes the pool's own handle and refuses every view of it, naming the caller and no id", () => {
    expect(() => refuseBound(db, "the index build")).not.toThrow();
    const err = refusal(() => refuseBound(bindDb(db, { account: A }), "the index build"), "");
    expect(err.reason).toContain("the index build");
    refusal(() => refuseBound(bindDb(db, { account: null }), "the index build"), "");
    refusal(() => refuseBound(bindDb(db, { account: null, key: "digest-of-a-code" }), "the index build"), "digest-of-a-code");
  });

  it("refuses a mark it did not mint too: what is not the pool's own handle sends no session statement", () => {
    const forged = brandDialect(Object.create(db) as object, "pg");
    Object.defineProperty(forged, BINDING_BRAND, { value: Object.freeze({ account: A, keyed: false }) });
    refusal(() => refuseBound(forged, "the index build"), "");
  });
});
