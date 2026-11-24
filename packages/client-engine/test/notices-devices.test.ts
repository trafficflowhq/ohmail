/**
 * THE ACCOUNT'S NAMED DEVICES, READ CLOSED. A device notice is decided from three whole numbers of
 * the copy's settings record. The reader answers all three or nothing: a record that says anything
 * else where a number belongs tells nothing, and nothing but the three numbers comes out of it.
 */
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore } from "../src/index.js";
import { devicesOf, noticeSampleOf } from "../src/notices/sample.js";
import type { EntityReader } from "../src/store.js";
import type { SyncChange } from "../src/types.js";

const AT = "2026-11-17T09:00:00.000Z";
const ACCOUNT = "0b8e6a52-3f0c-4a61-9d6e-6f1b1c1d2e3f";

/** A copy that holds `records` as its settings records, and nothing else. */
const copyOf = (...records: unknown[]): EntityReader =>
  ({ list: (type: string) => (type === "settings" ? records : []) }) as unknown as EntityReader;

const record = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  accountId: ACCOUNT, dormancyDays: null, folderMailboxesOff: {}, locale: null, updatedAt: AT,
  devices: 2, devicesMade: 5, devicesRevoked: 1,
  ...over,
});

describe("the closed reader of the account's named devices", () => {
  it("answers the three numbers of the copy's one settings record", () => {
    expect(devicesOf(copyOf(record()))).toEqual({ made: 5, revoked: 1, live: 2 });
    expect(devicesOf(copyOf(record({ devices: 0, devicesMade: 0, devicesRevoked: 0 })))).toEqual({ made: 0, revoked: 0, live: 0 });
  });

  it("reads the record the feed delivers, through the engine's own store", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    expect(devicesOf(store), "a copy with no settings record yet").toBeNull();
    const change = (seq: number, entity: Record<string, unknown>): SyncChange =>
      ({ type: "settings", op: "update", id: ACCOUNT, seq, updatedAt: AT, entity }) as SyncChange;
    await store.applyChanges([change(1, record())]);
    expect(devicesOf(store)).toEqual({ made: 5, revoked: 1, live: 2 });
    // The same stamp and other numbers: the record is replaced by the feed's order, not by its date.
    await store.applyChanges([change(2, record({ devicesMade: 6, devices: 3 }))]);
    expect(devicesOf(store)).toEqual({ made: 6, revoked: 1, live: 3 });
    expect(noticeSampleOf(store, devicesOf(store)).devices).toEqual({ made: 6, revoked: 1, live: 3 });
  });

  it("answers nothing for a record of a server that sends none of the three", () => {
    const { devices: _a, devicesMade: _b, devicesRevoked: _c, ...older } = record();
    expect(devicesOf(copyOf(older))).toBeNull();
  });

  it("answers nothing unless all three are whole numbers", () => {
    for (const name of ["devices", "devicesMade", "devicesRevoked"]) {
      for (const value of ["3", 2.5, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, null, undefined, true, [3], { n: 3 }]) {
        expect(devicesOf(copyOf(record({ [name]: value }))), `${name}: ${String(value)}`).toBeNull();
      }
      const missing = record();
      delete missing[name];
      expect(devicesOf(copyOf(missing)), `${name} missing`).toBeNull();
    }
  });

  it("answers nothing for a member that is only inherited", () => {
    const inherited = Object.create({ devicesMade: 5 }) as Record<string, unknown>;
    Object.assign(inherited, { devices: 2, devicesRevoked: 1 });
    expect(devicesOf(copyOf(inherited))).toBeNull();
  });

  it("answers nothing for no record, two records, or a record that is no object", () => {
    expect(devicesOf(copyOf())).toBeNull();
    expect(devicesOf(copyOf(record(), record()))).toBeNull();
    for (const odd of [null, "5", 5, [5, 1, 2]]) expect(devicesOf(copyOf(odd)), String(odd)).toBeNull();
  });

  it("carries nothing of the record but the three numbers", () => {
    const wordy = record({ label: "Mila's phone", kind: "mobile-android", ip: "203.0.113.9", device: { label: "Kitchen" } });
    const read = devicesOf(copyOf(wordy));
    expect(read).toEqual({ made: 5, revoked: 1, live: 2 });
    expect(Object.keys(read!).sort()).toEqual(["live", "made", "revoked"]);
    expect(JSON.stringify(read)).not.toMatch(/Mila|Kitchen|203|android/);
  });
});
