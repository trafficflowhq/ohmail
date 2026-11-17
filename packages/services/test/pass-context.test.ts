import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { bindDb, bindingOf } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { passContext } from "../src/index.js";

/**
 * ONE ROW OF A PASS GETS ITS OWN CONTEXT, BOUND TO ITS OWN ACCOUNT.
 *
 * A pass walks rows of many accounts on a handle that names none. What it does for one row runs on
 * the context `passContext` answers: the handle is bound to the row's account, and the context
 * names the same account, because both come from the one argument. Nothing else may stand in for
 * an account: no empty id, no malformed one, no handle that carries a key, no other account's handle.
 */

const A = randomUUID();
const B = randomUUID();
const rest = { userId: null, now: () => new Date(0), requestId: "pass" };

let store: Awaited<ReturnType<typeof makeTestDb>>;
beforeAll(async () => { store = await makeTestDb(); });

/** The walk as a host hands it to a pass: bound to nothing. */
const walk = () => bindDb(store, { account: null });

describe("passContext", () => {
  it("binds the row's handle to the account it is handed, and the context names that account", () => {
    const ctx = passContext(walk(), A, rest);
    expect(bindingOf(ctx.db)).toEqual({ account: A, keyed: false });
    expect(ctx.accountId).toBe(A);
    expect(ctx).toMatchObject({ userId: null, requestId: "pass" });
  });

  it("gives each row its own: A, then B, then A again, none carried over from the row before", () => {
    const seen = [A, B, A].map((id) => {
      const ctx = passContext(walk(), id, rest);
      return [ctx.accountId, bindingOf(ctx.db)?.account];
    });
    expect(seen).toEqual([[A, A], [B, B], [A, A]]);
  });

  it("leaves the walk as it was: still bound to nothing after a row was bound over it", () => {
    const w = walk();
    passContext(w, A, rest);
    expect(bindingOf(w)).toEqual({ account: null, keyed: false });
  });

  it("takes a handle no host minted, as a device's pass hands its store", () => {
    const ctx = passContext(store, A, rest);
    expect(bindingOf(ctx.db)?.account).toBe(A);
    expect(bindingOf(store)).toBeUndefined();
  });

  it("refuses an empty id, and binds nothing in its place", () => {
    expect(() => passContext(walk(), "", rest)).toThrow(expect.objectContaining({ code: "binding_refused" }));
  });

  it("refuses what is no lower-case id: an upper-case one, a short one, a word", () => {
    for (const bad of [A.toUpperCase(), A.slice(0, 35), "not-an-account", `${A} `]) {
      expect(() => passContext(walk(), bad, rest), bad.length.toString())
        .toThrow(expect.objectContaining({ code: "binding_refused" }));
    }
  });

  it("refuses a walk that carries a key: a keyed door binds no account", () => {
    const keyed = bindDb(store, { account: null, key: "the-door's-word" });
    expect(() => passContext(keyed, A, rest)).toThrow(expect.objectContaining({ code: "binding_refused" }));
  });

  it("refuses a handle bound to another account: a row's context is never made over another row's", () => {
    const rowOfA = passContext(walk(), A, rest);
    expect(() => passContext(rowOfA.db, B, rest)).toThrow(expect.objectContaining({ code: "binding_refused" }));
  });

  it("names no id in a refusal", () => {
    let said = "";
    try { passContext(bindDb(store, { account: A }), B, rest); } catch (err) { said = String((err as Error).message); }
    expect(said).not.toBe("");
    expect(said).not.toContain(A);
    expect(said).not.toContain(B);
  });
});
