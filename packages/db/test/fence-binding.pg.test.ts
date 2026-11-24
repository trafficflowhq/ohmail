import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { fencedAccountWrite } from "../src/index.js";
import { fencedConnectionWrite } from "../src/calendar/index.js";
import { makeOwnedDb, makePooledDb, closePooledDbs, type OwnedDb } from "../src/cloud.js";
import { runMigrations } from "../src/admin.js";
import { PG_TEST_URL, realPgAvailable } from "../src/testing.js";
import { asTx, fenceBindingCases, NO_BINDING, refusedWith, type Opens } from "./_fence-binding-cases.js";

const AVAILABLE = await realPgAvailable();

describe.skipIf(!AVAILABLE)("the writer's fence on a server's pool", () => {
  let owned: OwnedDb | undefined;
  afterAll(async () => { await owned?.close(); await closePooledDbs(); });
  const world = fenceBindingCases(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL, { role: "worker" });
    return { plain: owned.db as object, server: true };
  });

  it("refuses the pool's own handle: on a server a writer says whom it acts for", async () => {
    for (const [what, pool] of [
      ["an owned pool", world.store().plain],
      ["a pooled handle", makePooledDb(PG_TEST_URL, { max: 2 }) as object],
    ] as const) {
      const opened = vi.spyOn(pool as Opens, "transaction");
      const body = vi.fn(async () => "wrote");
      await expect(fencedAccountWrite(asTx(pool), { accountId: world.A() }, body), what).rejects.toEqual(refusedWith(NO_BINDING));
      await expect(fencedConnectionWrite(asTx(pool), { accountId: world.A(), connectionId: randomUUID() }, body), what)
        .rejects.toEqual(refusedWith(NO_BINDING));
      expect(body, what).not.toHaveBeenCalled();
      expect(opened, what).not.toHaveBeenCalled();
      opened.mockRestore();
    }
  });

  it("refuses the staff handle: its role is no device's store", async () => {
    const staff = makePooledDb(PG_TEST_URL, { role: "staff" }) as object;
    const opened = vi.spyOn(staff as Opens, "transaction");
    const body = vi.fn(async () => "wrote");
    await expect(fencedAccountWrite(asTx(staff), { accountId: world.A() }, body)).rejects.toEqual(refusedWith(NO_BINDING));
    await expect(fencedConnectionWrite(asTx(staff), { accountId: world.A(), connectionId: randomUUID() }, body))
      .rejects.toEqual(refusedWith(NO_BINDING));
    expect(body).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    opened.mockRestore();
  });

  it("refuses a transaction opened on the pool's own handle: it names nobody either", async () => {
    const body = vi.fn(async () => "wrote");
    await expect((world.store().plain as Opens).transaction((tx) => fencedAccountWrite(asTx(tx), { accountId: world.A() }, body)))
      .rejects.toEqual(refusedWith(NO_BINDING));
    expect(body).not.toHaveBeenCalled();
  });
});
