import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { bindDb, bindingOf, BindingRefusedError } from "@trafficflow/db";
import { bindRequest, serviceContext } from "../src/context.js";
import type { ApiDeps, ResolvedSession } from "../src/deps.js";
import { makeDeps, req } from "./helpers.js";

/**
 * THE REQUEST'S HANDLE IS BOUND BY ITS SESSION, AND BY NOTHING THE REQUEST CARRIES.
 *
 * Written from the caller's side: a signed-in request that names another account everywhere it
 * can (the body, the query, the path, a header) still gets a context bound to its own session's
 * account; a request with no session gets one bound to nothing; a session whose account is no id
 * is refused rather than bound to nothing.
 */

const A = randomUUID();
const B = randomUUID();

function sessionOf(accountId: string): ResolvedSession {
  return {
    accountId, userId: randomUUID(), sessionId: randomUUID(), lastTwofaAt: null,
    scope: "full", via: "bearer", emailVerifiedAt: null,
  };
}

let base: ApiDeps;
beforeAll(async () => { ({ deps: base } = await makeDeps()); });

describe("serviceContext binds the request's handle to the session's account", () => {
  it("binds A however loudly the request names B", () => {
    const deps: ApiDeps = { ...base, session: sessionOf(A) };
    const ctx = serviceContext(deps, req("POST", `/messages/${B}?accountId=${B}`, {
      headers: { "x-ohmail-account": B, "x-account-id": B },
      body: JSON.stringify({ accountId: B, account: B }),
    }));
    expect(bindingOf(ctx.db)).toEqual({ account: A, keyed: false });
    expect(ctx.accountId).toBe(A);
  });

  it("binds a request with no session to nothing", () => {
    const ctx = serviceContext({ ...base, session: null }, req("POST", "/auth/login", {
      body: JSON.stringify({ accountId: B }),
    }));
    expect(bindingOf(ctx.db)).toEqual({ account: null, keyed: false });
    expect(ctx.accountId).toBe("");
  });

  it("gives one handle per request: the one its session was bound to, and no other once the session changes", () => {
    // A request as a host hands it over: its handle minted bound to nothing, then bound by its session.
    const deps: ApiDeps = { ...base, db: bindDb(base.db, { account: null }), session: sessionOf(A) };
    bindRequest(deps);
    const first = serviceContext(deps, req("GET", "/x")).db;
    expect(first).toBe(deps.db);
    expect(serviceContext(deps, req("GET", "/x")).db).toBe(first);
    expect(bindingOf(first)).toEqual({ account: A, keyed: false });
    // The session changed under a handle already bound: no context is built for the other account.
    deps.session = sessionOf(B);
    expect(() => serviceContext(deps, req("GET", "/x"))).toThrow(BindingRefusedError);
    deps.session = null;
    expect(() => serviceContext(deps, req("GET", "/x"))).toThrow(BindingRefusedError);
    expect(bindingOf(first)?.account).toBe(A);
  });

  it("binds over the handle the request holds when its session is bound: a handle swapped before that, never after", () => {
    const swapped = bindDb(Object.create(base.db) as ApiDeps["db"], { account: null });
    const deps: ApiDeps = { ...base, db: bindDb(base.db, { account: null }), session: sessionOf(A), sessionDb: () => swapped };
    // The session doors swap the handle before the token is resolved.
    deps.db = deps.sessionDb!();
    bindRequest(deps);
    const ctx = serviceContext(deps, req("GET", "/x"));
    expect(ctx.db).toBe(deps.db);
    expect(bindingOf(ctx.db)?.account).toBe(A);
    expect(Object.getPrototypeOf(Object.getPrototypeOf(ctx.db))).toBe(base.db);
    // The second handle's door is closed with the binding.
    expect(deps.sessionDb).toBeUndefined();
  });

  it("refuses a session whose account is empty or no id, rather than binding it to nothing", () => {
    for (const bad of ["", "acct-1", A.toUpperCase()]) {
      expect(() => serviceContext({ ...base, session: sessionOf(bad) }, req("GET", "/x")))
        .toThrow(BindingRefusedError);
    }
  });
});
