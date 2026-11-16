import { describe, expect, it } from "vitest";
import { fencedAccountWrite, bindingOf } from "../src/index.js";
import { makeTestDb } from "../src/testing.js";
import { asTx, fenceBindingCases, type Opens } from "./_fence-binding-cases.js";

describe("the writer's fence on a device's store", () => {
  const world = fenceBindingCases(async () => ({ plain: (await makeTestDb()) as object, server: false }));

  it("opens on the store's own handle: one person's organizer writes there, and no role stands behind it", async () => {
    const plain = world.store().plain;
    expect(await fencedAccountWrite(asTx(plain), { accountId: world.A() }, async (tx) => bindingOf(tx) ?? "no binding")).toBe("no binding");
    // And inside a transaction the organizer opened on it.
    expect(await (plain as Opens).transaction((tx) =>
      fencedAccountWrite(asTx(tx), { accountId: world.A() }, async (inner) => bindingOf(inner) ?? "no binding"))).toBe("no binding");
  });
});
