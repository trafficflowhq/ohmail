import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { accounts, bindDb, bindingOf, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { calendarPool, inConnection, passDb } from "../src/calendar/connection.js";

/**
 * A CALENDAR TURN'S HANDLE NAMES ITS CONNECTION'S ACCOUNT, WHATEVER STORE THE POOL IS. The binder
 * is asked every time: a turn never runs on a handle that says nothing of whom it acts for.
 */
type Opens = { transaction: (...args: unknown[]) => unknown };

async function world(): Promise<{ store: Tx; plain: Opens; accountId: string }> {
  const db = await makeTestDb();
  const [a] = await db
    .insert(accounts)
    .values({ name: `turn ${randomUUID()}` })
    .returning();
  return { store: db as unknown as Tx, plain: db as unknown as Opens, accountId: a!.id };
}

describe("passDb binds a turn's handle to its connection's account on every store", () => {
  it("binds over a store nobody bound a view of: the turn's transaction opens on a handle that names the account", async () => {
    const w = await world();
    const opened = vi.spyOn(w.plain, "transaction");
    // No such connection: the turn finds nothing to work on, and it asked on the account's handle.
    const key = { accountId: w.accountId, id: randomUUID() };
    expect(await inConnection(passDb(calendarPool(w.store), w.accountId), key, async () => "worked")).toBe(
      "gone",
    );
    expect(opened).toHaveBeenCalledTimes(1);
    expect(bindingOf(opened.mock.contexts[0])).toEqual({ account: w.accountId, keyed: false });
  });

  it("binds over the view that names no account, as the organizer hands its pool", async () => {
    const w = await world();
    const opened = vi.spyOn(w.plain, "transaction");
    const roster = bindDb(w.store as unknown as object, { account: null }) as unknown as Tx;
    const key = { accountId: w.accountId, id: randomUUID() };
    expect(await inConnection(passDb(calendarPool(roster), w.accountId), key, async () => "worked")).toBe(
      "gone",
    );
    expect(bindingOf(opened.mock.contexts[0])).toEqual({ account: w.accountId, keyed: false });
  });

  it("refuses an id that is no account's on any store, and binds it to nothing never", async () => {
    const w = await world();
    for (const bad of ["", "acct-1", w.accountId.toUpperCase(), ` ${w.accountId}`]) {
      expect(() => passDb(calendarPool(w.store), bad), JSON.stringify(bad)).toThrow(
        expect.objectContaining({ code: "binding_refused" }),
      );
    }
  });
});
