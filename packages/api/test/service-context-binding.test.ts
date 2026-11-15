import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { bindingOf, BindingRefusedError } from "@trafficflow/db";
import { serviceContext } from "../src/context.js";
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

  it("gives one handle per request, and a second binding once the session changes", () => {
    const deps: ApiDeps = { ...base, session: sessionOf(A) };
    const first = serviceContext(deps, req("GET", "/x")).db;
    expect(serviceContext(deps, req("GET", "/x")).db).toBe(first);
    deps.session = sessionOf(B);
    const second = serviceContext(deps, req("GET", "/x")).db;
    expect(bindingOf(second)?.account).toBe(B);
    expect(bindingOf(first)?.account).toBe(A);
  });

  it("re-binds when the request's handle is swapped for another over the same pool", () => {
    const deps: ApiDeps = { ...base, session: sessionOf(A) };
    const before = serviceContext(deps, req("GET", "/x")).db;
    deps.db = Object.create(base.db) as ApiDeps["db"];
    const after = serviceContext(deps, req("GET", "/x")).db;
    expect(after).not.toBe(before);
    expect(bindingOf(after)?.account).toBe(A);
  });

  it("refuses a session whose account is empty or no id, rather than binding it to nothing", () => {
    for (const bad of ["", "acct-1", A.toUpperCase()]) {
      expect(() => serviceContext({ ...base, session: sessionOf(bad) }, req("GET", "/x")))
        .toThrow(BindingRefusedError);
    }
  });
});
