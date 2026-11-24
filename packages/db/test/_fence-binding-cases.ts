import { randomUUID } from "node:crypto";
import { beforeAll, expect, it, vi } from "vitest";
import { accounts, bindDb, bindingOf, fencedAccountWrite, onServerPool, type Tx } from "../src/index.js";
import { fencedConnectionWrite } from "../src/calendar/index.js";

/** A store as the cases need it: its own handle, and whether a role stands behind it. */
export interface FenceStore { plain: object; server: boolean }

const NO_BINDING = "a transaction was asked on a handle that names no binding";
const NOT_ITS_OWN = "the context's account is not the one its handle names";
const refusedWith = (reason: string) => expect.objectContaining({ code: "binding_refused", reason });
const asTx = (db: object): Tx => db as unknown as Tx;
type Opens = { transaction: <T>(fn: (tx: object) => Promise<T>) => Promise<T> };

/**
 * THE WRITER'S FENCE ASKS WHOM ITS HANDLE ACTS FOR. A handle that names an account names the
 * fence's; one that names none at all is a device's own store and nothing else. The cases that
 * hold on every store, a device's and a server's; each file adds what is its store's alone.
 */
export function fenceBindingCases(open: () => Promise<FenceStore>): { store: () => FenceStore; A: () => string; B: () => string } {
  let store: FenceStore;
  let A = "";
  let B = "";

  beforeAll(async () => {
    store = await open();
    const db = store.plain as { insert: (t: typeof accounts) => { values: (v: { name: string }) => { returning: () => Promise<Array<{ id: string }>> } } };
    A = (await db.insert(accounts).values({ name: `fence a ${randomUUID()}` }).returning())[0]!.id;
    B = (await db.insert(accounts).values({ name: `fence b ${randomUUID()}` }).returning())[0]!.id;
  });

  it("opens on a handle that names the fence's account, and its transaction carries that name", async () => {
    const view = bindDb(store.plain, { account: A });
    expect(await fencedAccountWrite(asTx(view), { accountId: A }, async (tx) => bindingOf(tx))).toEqual({ account: A, keyed: false });
    // Again inside it, on the transaction's own handle.
    expect(await fencedAccountWrite(asTx(view), { accountId: A }, (tx) =>
      fencedAccountWrite(tx, { accountId: A }, async (inner) => bindingOf(inner)))).toEqual({ account: A, keyed: false });
  });

  it("refuses a handle that names another account, or nothing, before it opens anything", async () => {
    for (const [what, view] of [
      ["B's handle", bindDb(store.plain, { account: B })],
      ["a handle bound to nothing", bindDb(store.plain, { account: null })],
      ["a handle bound to nothing with a key", bindDb(store.plain, { account: null, key: "a-digest" })],
    ] as const) {
      const opened = vi.spyOn(store.plain as Opens, "transaction");
      const body = vi.fn(async () => "wrote");
      await expect(fencedAccountWrite(asTx(view), { accountId: A }, body), what).rejects.toEqual(refusedWith(NOT_ITS_OWN));
      await expect(fencedConnectionWrite(asTx(view), { accountId: A, connectionId: randomUUID() }, body), what)
        .rejects.toEqual(refusedWith(NOT_ITS_OWN));
      expect(body, what).not.toHaveBeenCalled();
      expect(opened, what).not.toHaveBeenCalled();
      opened.mockRestore();
    }
  });

  it("refuses a transaction of another account's handle that is handed on to it", async () => {
    const other = bindDb(store.plain, { account: B }) as unknown as Opens;
    const body = vi.fn(async () => "wrote");
    await expect(other.transaction((tx) => fencedAccountWrite(asTx(tx), { accountId: A }, body))).rejects.toEqual(refusedWith(NOT_ITS_OWN));
    expect(body).not.toHaveBeenCalled();
  });

  it("knows a server's pool from a device's store, through a view and inside a transaction", async () => {
    const plain = store.plain as Opens;
    expect(onServerPool(plain)).toBe(store.server);
    expect(onServerPool(bindDb(store.plain, { account: A }))).toBe(store.server);
    expect(await plain.transaction(async (tx) => onServerPool(tx))).toBe(store.server);
    expect(await (bindDb(store.plain, { account: A }) as unknown as Opens).transaction(async (tx) => onServerPool(tx))).toBe(store.server);
    // And a savepoint under either.
    expect(await plain.transaction((tx) => (tx as Opens).transaction(async (inner) => onServerPool(inner)))).toBe(store.server);
  });

  it("binds an object made over a bound view only on a device's store: on a server its statements would ride the view's own binding", async () => {
    // A wrapper (a double, a counting handle) made over the view that names nothing, then bound to A:
    // its statements go through the view it wraps, whose flights name nothing, while its mark would say A.
    const wrapper = Object.create(bindDb(store.plain, { account: null })) as object;
    if (store.server) {
      expect(() => bindDb(wrapper, { account: A })).toThrow(
        refusedWith("the handle is a wrapper of a bound one; wrap the pool's own handle, then bind"));
    } else {
      expect(bindingOf(bindDb(wrapper, { account: A }))).toEqual({ account: A, keyed: false });
    }
    // An object made over the store's own handle: a device binds it; a server knows it for a driver
    // handle its factory never registered, and refuses it as before.
    const overTheOwn = Object.create(store.plain) as object;
    if (store.server) {
      expect(() => bindDb(overTheOwn, { account: A })).toThrow(refusedWith("a postgres.js handle its factory did not register"));
    } else {
      expect(bindingOf(bindDb(overTheOwn, { account: A }))).toEqual({ account: A, keyed: false });
    }
  });

  return { store: () => store, A: () => A, B: () => B };
}

export { NO_BINDING, NOT_ITS_OWN, refusedWith, asTx, type Opens };
