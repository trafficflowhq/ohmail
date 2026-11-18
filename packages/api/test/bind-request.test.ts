import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp, apiRoutes } from "@trafficflow/api";
import { bindDb, bindingOf, BindingRefusedError } from "@trafficflow/db";
import { resolveSession } from "@trafficflow/services/auth";
import { bindRequest, doorDb, serviceContext } from "../src/context.js";
import type { ApiDeps, ResolvedSession } from "../src/deps.js";
import type { Db } from "@trafficflow/services";
import { FIXED_NOW, makeDeps, req, seedSession } from "./helpers.js";

/**
 * THE REQUEST IS BOUND ONCE, FROM ITS SESSION'S ROW, AT THE END OF THE SESSION DOOR.
 *
 * A host hands every request a handle bound to nothing. The session door resolves the token on a
 * handle keyed by the token's digest, and its last step binds the request's handle to the account
 * of the row that answered. Nothing a request carries names the account; a container that was
 * bound for one request serves no second one; a request with no session stays bound to nothing;
 * and a container whose handle no host minted serves no request at all.
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
/** The store's own handle: what a host mints a request's handle over, and what no request holds. */
let plain: Db;
beforeAll(async () => { ({ deps: base, db: plain } = await makeDeps()); });

/** A request's container as a host builds it: the handle minted bound to nothing. */
const minted = (over: Partial<ApiDeps> = {}): ApiDeps => ({ ...base, db: bindDb(plain, { account: null }), ...over });

describe("bindRequest binds the request's handle to its session's account, once", () => {
  it("binds the host's handle to the session's account and closes the session doors' second handle", () => {
    const deps = minted({ session: sessionOf(A), sessionDb: () => bindDb(plain, { account: null }) });
    bindRequest(deps);
    expect(bindingOf(deps.db)).toEqual({ account: A, keyed: false });
    expect(deps.sessionDb).toBeUndefined();
    expect("sessionDb" in deps).toBe(false);
  });

  it("leaves a request with no session bound to nothing, and closes the second handle all the same", () => {
    const deps = minted({ session: null, sessionDb: () => bindDb(plain, { account: null }) });
    const before = deps.db;
    bindRequest(deps);
    expect(deps.db).toBe(before);
    expect(bindingOf(deps.db)).toEqual({ account: null, keyed: false });
    expect(deps.sessionDb).toBeUndefined();
  });

  it("reads the session's row and nothing else of the request's container", () => {
    const deps = minted({ session: sessionOf(A), credentialAccount: B, erasedAccount: B, requestId: B });
    bindRequest(deps);
    expect(bindingOf(deps.db)?.account).toBe(A);
  });

  it("refuses a container handed to a second request: a handle that names an account is spent", () => {
    const deps = minted({ session: sessionOf(A) });
    bindRequest(deps);
    for (const next of [sessionOf(A), sessionOf(B), null]) {
      deps.session = next;
      expect(() => bindRequest(deps)).toThrow(BindingRefusedError);
      expect(bindingOf(deps.db)?.account).toBe(A);
    }
  });

  it("refuses a handle that carries a key: the session's look-up binds its own, and no request's handle holds one", () => {
    const deps: ApiDeps = { ...base, db: bindDb(plain, { account: null, key: "digest-of-a-token" }), session: sessionOf(A) };
    expect(() => bindRequest(deps)).toThrow(BindingRefusedError);
    expect(bindingOf(deps.db)).toEqual({ account: null, keyed: true });
  });

  it("refuses a session whose account is empty or no id, and binds it to nothing never", () => {
    for (const bad of ["", "acct-1", A.toUpperCase(), ` ${A}`]) {
      const deps = minted({ session: sessionOf(bad) });
      let refusal: unknown;
      try { bindRequest(deps); } catch (err) { refusal = err; }
      expect(refusal).toBeInstanceOf(BindingRefusedError);
      if (bad.trim() !== "") expect((refusal as Error).message).not.toContain(bad.trim());
      // Not bound to nothing by default: no context is built for this session on this handle.
      expect(() => serviceContext(deps, req("GET", "/x"))).toThrow(BindingRefusedError);
    }
  });

  it("refuses a handle no host minted, with a session and without one, and leaves it as it was", () => {
    for (const session of [sessionOf(A), sessionOf(B), null]) {
      // @ts-expect-error — the type refuses it too; the case is what happens at run time
      const deps: ApiDeps = { ...base, db: plain, session, sessionDb: () => bindDb(plain, { account: null }) };
      expect(() => bindRequest(deps)).toThrow(expect.objectContaining({ code: "binding_refused" }));
      expect(deps.db).toBe(plain);
      expect(bindingOf(deps.db)).toBeUndefined();
      // Nothing was closed either: the request never began.
      expect(deps.sessionDb).toBeDefined();
    }
  });

  it("says why in fixed words, and names no account in them", () => {
    // @ts-expect-error — the type refuses it too; the case is what happens at run time
    const deps: ApiDeps = { ...base, db: plain, session: sessionOf(A) };
    let refusal: unknown;
    try { bindRequest(deps); } catch (err) { refusal = err; }
    expect((refusal as Error).message).toContain("no host minted");
    expect((refusal as Error).message).not.toContain(A);
  });
});

describe("a context is built on the request's own handle", () => {
  it("refuses a handle no host minted: no context is bound from the session over the store's own handle", () => {
    for (const session of [sessionOf(A), null]) {
      // @ts-expect-error — the type refuses it too; the case is what happens at run time
      expect(() => serviceContext({ ...base, db: plain, session }, req("GET", "/x")))
        .toThrow(expect.objectContaining({ code: "binding_refused" }));
    }
  });

  it("refuses a host's handle that its session never bound: a session beside a handle bound to nothing", () => {
    const deps = minted({ session: sessionOf(A) });
    expect(() => serviceContext(deps, req("GET", "/x"))).toThrow(BindingRefusedError);
  });

  it("answers the handle bound to nothing for a request with no session", () => {
    const deps = minted({ session: null });
    bindRequest(deps);
    const ctx = serviceContext(deps, req("POST", "/auth/login"));
    expect(ctx.db).toBe(deps.db);
    expect(ctx.accountId).toBe("");
  });
});

describe("doorDb is the handle of a door that runs for no account", () => {
  it("answers the host's handle, bound to nothing and without a key", () => {
    const deps = minted();
    expect(doorDb(deps)).toBe(deps.db);
    expect(bindingOf(doorDb(deps))).toEqual({ account: null, keyed: false });
  });

  it("is refused on a handle no host minted: a clock's route walks on no store's own handle", () => {
    // @ts-expect-error — the type refuses it too; the case is what happens at run time
    expect(() => doorDb({ ...base, db: plain })).toThrow(expect.objectContaining({ code: "binding_refused" }));
  });

  it("is refused on a request that was bound to an account, and on a handle that carries a key", () => {
    const bound = minted({ session: sessionOf(A) });
    bindRequest(bound);
    expect(() => doorDb(bound)).toThrow(BindingRefusedError);
    expect(() => doorDb({ ...base, db: bindDb(plain, { account: null, key: "a-door's-word" }) })).toThrow(BindingRefusedError);
  });
});

describe("the session door, through the pipeline", () => {
  const app = createApp(apiRoutes);

  it("resolves the token, then binds the request's handle to the account of the row that answered", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const container: ApiDeps = { ...deps, db: bindDb(db, { account: null }), sessionDb: () => bindDb(db, { account: null }) };
    const res = await app.handle(req("GET", "/mailboxes", { bearer: s.token }), container);
    expect(res.status).toBe(200);
    expect(bindingOf(container.db)).toEqual({ account: s.accountId, keyed: false });
    expect(container.sessionDb).toBeUndefined();
  });

  it("binds A's request to A however loudly it names B: query, body, three headers and the `tf_owner` cookie", async () => {
    const { db, deps } = await makeDeps();
    const a = await seedSession(db, { now: FIXED_NOW });
    const b = await seedSession(db, { now: FIXED_NOW });
    const container: ApiDeps = { ...deps, db: bindDb(db, { account: null }) };
    const res = await app.handle(req("GET", `/mailboxes?accountId=${b.accountId}&account=${b.accountId}`, {
      bearer: a.token, cookie: `tf_owner=${b.accountId}`,
      headers: { "x-ohmail-account": b.accountId, "x-account-id": b.accountId, "x-tf-account": b.accountId },
    }), container);
    expect(res.status).toBe(200);
    expect(bindingOf(container.db)?.account).toBe(a.accountId);
  });

  it("a container handed to a second request answers 500, and its handle still names the first account alone", async () => {
    const { db, deps } = await makeDeps();
    const a = await seedSession(db, { now: FIXED_NOW });
    const b = await seedSession(db, { now: FIXED_NOW });
    const container: ApiDeps = { ...deps, db: bindDb(db, { account: null }) };
    expect((await app.handle(req("GET", "/mailboxes", { bearer: a.token }), container)).status).toBe(200);
    for (const token of [b.token, a.token]) {
      const again = await app.handle(req("GET", "/mailboxes", { bearer: token }), container);
      expect(again.status).toBe(500);
      expect(bindingOf(container.db)?.account).toBe(a.accountId);
    }
  });

  it("an enrollment session dropped on a public route leaves the request bound to nothing", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, scope: "enrollment" });
    const container: ApiDeps = { ...deps, db: bindDb(db, { account: null }) };
    const res = await app.handle(req("POST", "/auth/login", {
      bearer: s.token, body: JSON.stringify({ email: "nobody@lichtgrat.example", password: "not-the-password-1" }),
    }), container);
    expect(res.status).toBeLessThan(500);
    expect(container.session).toBeNull();
    expect(bindingOf(container.db)).toEqual({ account: null, keyed: false });
  });

  it("a container whose handle no host minted answers 500 to a signed-in request, and nothing is bound", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    // @ts-expect-error — the type refuses it too; the case is what happens at run time
    const container: ApiDeps = { ...deps, db };
    const res = await app.handle(req("GET", "/mailboxes", { bearer: s.token }), container);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("internal");
    expect(container.db).toBe(db);
    expect(bindingOf(container.db)).toBeUndefined();
  });

  it("a protected route with no session answers 401 and binds nothing", async () => {
    const { db, deps } = await makeDeps();
    const container: ApiDeps = { ...deps, db: bindDb(db, { account: null }) };
    const res = await app.handle(req("GET", "/mailboxes", { bearer: "no-such-token" }), container);
    expect(res.status).toBe(401);
    expect(bindingOf(container.db)).toEqual({ account: null, keyed: false });
  });
});

describe("the session's look-up binds its own handle: no account, keyed by the token's digest", () => {
  it("resolves on a plain handle and on one bound to nothing, and answers the row's account", async () => {
    const { db } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    // @ts-expect-error — the type refuses it too; the case is what happens at run time
    expect((await resolveSession(db, s.token, FIXED_NOW))?.accountId).toBe(s.accountId);
    expect((await resolveSession(bindDb(db, { account: null }), s.token, FIXED_NOW))?.accountId).toBe(s.accountId);
  });

  it("is refused on a handle that names an account already: the door runs before any account is bound", async () => {
    const { db } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    // @ts-expect-error — the type refuses it too; the case is what happens at run time
    await expect(resolveSession(bindDb(db, { account: s.accountId }), s.token, FIXED_NOW)).rejects.toBeInstanceOf(BindingRefusedError);
  });
});
