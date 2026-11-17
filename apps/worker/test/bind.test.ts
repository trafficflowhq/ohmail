import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { bindingOf } from "@trafficflow/db";
import type { OwnedDb } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { bindWorker } from "../src/start/bind.js";

/**
 * THE WORKER'S TWO VIEWS OF ITS POOL. `roster` names no account; `forAccount(id)` names one, and
 * answers that account's handle and its repository. An account's pair is kept from one reading of
 * the roster to the next, under the id it was bound for, and no account is ever handed another's.
 */

const A = randomUUID();
const B = randomUUID();

let store: OwnedDb["db"];
beforeAll(async () => { store = await makeTestDb() as unknown as OwnedDb["db"]; });

describe("bindWorker", () => {
  it("the roster's view names no account and carries no key", () => {
    expect(bindingOf(bindWorker(store).roster)).toEqual({ account: null, keyed: false });
  });

  it("an account's handle names that account, and its repository comes with it", () => {
    const pair = bindWorker(store).forAccount(A);
    expect(bindingOf(pair.db)).toEqual({ account: A, keyed: false });
    expect(typeof pair.repo.transaction).toBe("function");
  });

  it("A, then B, then A again: each is handed its own, never the one asked for before it", () => {
    const binding = bindWorker(store);
    const seen = [A, B, A].map((id) => bindingOf(binding.forAccount(id).db)?.account);
    expect(seen).toEqual([A, B, A]);
    expect(binding.forAccount(B).db).not.toBe(binding.forAccount(A).db);
    expect(binding.forAccount(B).repo).not.toBe(binding.forAccount(A).repo);
  });

  it("keeps an account's pair until the roster is read again, and makes it afresh after", () => {
    const binding = bindWorker(store);
    const first = binding.forAccount(A);
    expect(binding.forAccount(A)).toBe(first);
    const ofB = binding.forAccount(B);
    binding.forgetAccounts();
    const second = binding.forAccount(A);
    expect(second).not.toBe(first);
    expect(bindingOf(second.db)?.account).toBe(A);
    expect(binding.forAccount(B)).not.toBe(ofB);
    // A pair taken before the roster was read again still names its own account.
    expect(bindingOf(first.db)?.account).toBe(A);
  });

  it("two bindings of one pool keep their own pairs", () => {
    const one = bindWorker(store);
    const two = bindWorker(store);
    expect(two.forAccount(A)).not.toBe(one.forAccount(A));
  });

  it("refuses what is no account id, and binds nothing in its place", () => {
    const binding = bindWorker(store);
    for (const bad of ["", A.toUpperCase(), "acct-1", A.slice(1)]) {
      expect(() => binding.forAccount(bad), String(bad.length)).toThrow(expect.objectContaining({ code: "binding_refused" }));
    }
    // A refused id leaves nothing behind under its name.
    expect(() => binding.forAccount("")).toThrow();
    expect(bindingOf(binding.forAccount(A).db)?.account).toBe(A);
  });

  it("leaves the pool's own handle as it was", () => {
    const binding = bindWorker(store);
    binding.forAccount(A);
    expect(bindingOf(store)).toBeUndefined();
    expect(bindingOf(binding.roster)?.account).toBeNull();
  });
});
