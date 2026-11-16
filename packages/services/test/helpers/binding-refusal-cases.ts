import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { accounts, bindDb, bindingOf, type LedgerTx } from "@trafficflow/db";
import { dbFor, runInTransaction, withAccountTx, type Db, type ServiceContext } from "../../src/context.js";

/**
 * A TRANSACTION OPENS ONLY ON A HANDLE THAT NAMES ITS CONTEXT'S ACCOUNT. The cases, for a device's
 * store and a server's pool alike: a context's handle and its account come by separate ways, and a
 * transaction is refused before it opens where they disagree, or where the handle names nothing at
 * all. `open` answers the store's own handle and nothing bound over it.
 */
export function bindingRefusalCases(open: () => Promise<Db>): void {
  let plain: Db;
  let A = "";
  let B = "";
  /** The transactions the store's own handle was asked for: a refusal opens none. */
  let opened: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    plain = await open();
    const [a] = await plain.insert(accounts).values({ name: `refusals a ${randomUUID()}` }).returning();
    const [b] = await plain.insert(accounts).values({ name: `refusals b ${randomUUID()}` }).returning();
    A = a!.id;
    B = b!.id;
  });
  afterEach(() => { opened?.mockRestore(); });

  const watch = (): void => { opened = vi.spyOn(plain as unknown as { transaction: (...a: unknown[]) => unknown }, "transaction"); };
  const ctxOn = (db: unknown, accountId: string): ServiceContext =>
    ({ db: db as ServiceContext["db"], accountId, userId: null, now: () => new Date(), requestId: "refusals" });
  const NO_BINDING = "a transaction was asked on a handle that names no binding";
  const NOT_ITS_OWN = "the context's account is not the one its handle names";
  const refusedWith = (reason: string) => expect.objectContaining({ code: "binding_refused", reason });

  /** Each way a context and its handle can disagree: the handle, the account the context runs for, the reason. */
  const disagreements = (): Array<[string, unknown, string, string]> => [
    ["an account's context on the store's own handle", plain, A, NO_BINDING],
    ["a context for no account on the store's own handle", plain, "", NO_BINDING],
    ["A's context on B's handle", bindDb(plain, { account: B }), A, NOT_ITS_OWN],
    ["A's context on a handle bound to nothing", bindDb(plain, { account: null }), A, NOT_ITS_OWN],
    ["A's context on a handle bound to nothing with a key", bindDb(plain, { account: null, key: "a-digest" }), A, NOT_ITS_OWN],
    ["a context for no account on A's handle", bindDb(plain, { account: A }), "", NOT_ITS_OWN],
  ];

  describe("runInTransaction", () => {
    it("refuses a context whose handle does not name its account, before any transaction opens", async () => {
      for (const [what, db, accountId, reason] of disagreements()) {
        watch();
        const body = vi.fn(async () => "ran");
        await expect(runInTransaction(ctxOn(db, accountId), body), what).rejects.toEqual(refusedWith(reason));
        expect(body, what).not.toHaveBeenCalled();
        expect(opened, what).not.toHaveBeenCalled();
        opened.mockRestore();
      }
    });

    it("says nothing of an account in its refusals", async () => {
      for (const [, db, accountId] of disagreements()) {
        const refusal = await runInTransaction(ctxOn(db, accountId), async () => "ran").then(() => null, (err: Error) => err);
        expect(refusal?.message).not.toContain(A);
        expect(refusal?.message).not.toContain(B);
      }
    });

    it("opens for a context on its own account's handle, with the fence that names it, and the transaction carries the binding", async () => {
      const ctx = ctxOn(dbFor(plain, A), A);
      expect(await runInTransaction(ctx, async (txCtx) => bindingOf(txCtx.db))).toEqual({ account: A, keyed: false });
      expect(await runInTransaction(ctx, async (txCtx) => bindingOf(txCtx.db), { fence: { accountId: A } }))
        .toEqual({ account: A, keyed: false });
      // And again inside it: a nested transaction is asked on the transaction's own handle.
      expect(await runInTransaction(ctx, (txCtx) => runInTransaction(txCtx, async (inner) => bindingOf(inner.db))))
        .toEqual({ account: A, keyed: false });
    });

    it("opens for a context that runs for no account on a handle bound to nothing", async () => {
      const ctx = ctxOn(bindDb(plain, { account: null }), "");
      expect(await runInTransaction(ctx, async (txCtx) => bindingOf(txCtx.db))).toEqual({ account: null, keyed: false });
    });

    it("a credential's door still fences for the account its row named, whatever its handle names", async () => {
      // OWED, and held here so that the day it changes is seen. Such a door knows its account only
      // from the row its credential found: before sign-in its handle names none, and a browser
      // signed in as A that presents B's credential holds A's handle and is refused 409 by the door
      // itself, inside this transaction. Until each door names its account inside its own
      // transaction, a fence's account is not held to the handle's.
      const before = ctxOn(bindDb(plain, { account: null }), "");
      expect(await runInTransaction(before, async (txCtx) => bindingOf(txCtx.db), { fence: { accountId: A } }))
        .toEqual({ account: null, keyed: false });
      const signedInAsA = ctxOn(dbFor(plain, A), A);
      expect(await runInTransaction(signedInAsA, async (txCtx) => bindingOf(txCtx.db), { fence: { accountId: B } }))
        .toEqual({ account: A, keyed: false });
    });
  });

  describe("withAccountTx", () => {
    it("refuses a context whose handle does not name its account, before any transaction opens", async () => {
      for (const [what, db, accountId, reason] of disagreements()) {
        watch();
        const body = vi.fn(async (_tx: LedgerTx) => "ran");
        await expect(withAccountTx(ctxOn(db, accountId), body), what).rejects.toEqual(refusedWith(reason));
        expect(body, what).not.toHaveBeenCalled();
        expect(opened, what).not.toHaveBeenCalled();
        opened.mockRestore();
      }
    });

    it("holds the handle it is told to open on to the same: `db` named beside a context that is right", async () => {
      const ctx = ctxOn(dbFor(plain, A), A);
      for (const [what, db, reason] of [
        ["the store's own handle", plain, NO_BINDING],
        ["B's handle", bindDb(plain, { account: B }), NOT_ITS_OWN],
        ["a handle bound to nothing", bindDb(plain, { account: null }), NOT_ITS_OWN],
      ] as const) {
        watch();
        const body = vi.fn(async (_tx: LedgerTx) => "ran");
        await expect(withAccountTx(ctx, body, { db: db as ServiceContext["db"] }), what).rejects.toEqual(refusedWith(reason));
        expect(body, what).not.toHaveBeenCalled();
        expect(opened, what).not.toHaveBeenCalled();
        opened.mockRestore();
      }
    });

    it("opens for a context on its own account's handle, and the transaction carries the binding", async () => {
      expect(await withAccountTx(ctxOn(dbFor(plain, A), A), async (tx) => bindingOf(tx))).toEqual({ account: A, keyed: false });
    });
  });

  describe("dbFor", () => {
    it("answers a handle bound to the account it is asked for", () => {
      expect(bindingOf(dbFor(plain, A))).toEqual({ account: A, keyed: false });
    });

    it("refuses an empty id and any string that is no account's: no string names \"no account\"", () => {
      for (const bad of ["", " ", "acct-1", A.toUpperCase(), `${A} `]) {
        expect(() => dbFor(plain, bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: "binding_refused" }));
      }
    });
  });
}
