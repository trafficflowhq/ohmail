import { describe, it, expect } from "vitest";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { accounts } from "@trafficflow/db";
import { makeWaitlistService } from "@trafficflow/services";
import { makeDeps, req, setCookieMap } from "./helpers.js";

/**
 * Stage-2 OPEN REGISTRATION **over the wire**, because the service test cannot see
 * the two things that actually decide whether a stranger gets in.
 *
 *  1. **The BODY shape.** `POST /auth/register`'s handler used to destructure a required
 *     `inviteCode` and hand it on; a service that tolerates an absent code is worthless if
 *     the route still demands one. Nothing below sends the field at all.
 *  2. **The REFUSAL shape.** "A 429 must be a clean refusal, never a 500" is a claim about
 *     `withErrorEnvelope`, not about `AuthService` — a `ServiceError` that the envelope does
 *     not recognise surfaces as 500 on the one endpoint reachable with no credential at all.
 *     That is exactly how an earlier hardening pass found four 500s. So every refusal here is
 *     asserted at the HTTP layer, with its JSON envelope parsed.
 *
 * The enrollment fence is re-asserted rather than assumed: opening the gate must not have
 * widened what the session behind it can do.
 */

const app = createApp(apiRoutes);
const PW = "pw-correct-horse-battery";

/** Every request carries a platform IP header — `clientIp` trusts only this one. */
const IP = "198.51.100.7";

const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

/** Register WITHOUT the field at all — not with an empty one. */
function registerBody(email: string, inviteCode?: string): string {
  return JSON.stringify({
    email, password: PW, displayName: "A Stranger",
    ...(inviteCode === undefined ? {} : { inviteCode }),
  });
}

const post = (deps: ApiDeps, email: string, code?: string, ip: string = IP): Promise<Response> =>
  H(req("POST", "/auth/register", {
    headers: { "x-forwarded-for": ip },
    body: registerBody(email, code),
  }), deps);

const envelope = async (res: Response): Promise<{ code: string; message: string }> => {
  const body = await res.json() as { error?: { code: string; message: string } };
  expect(body.error, `a refusal must carry the error envelope, got ${JSON.stringify(body)}`)
    .toBeDefined();
  return body.error!;
};

describe("POST /auth/register with NO invite code", () => {
  it("publicSignup ON: a constant 202, NO cookies, and an account really exists", async () => {
    const { db, deps, mailer } = await makeDeps(undefined, { publicSignup: true });
    const res = await post(deps, "stranger@example.com");

    // Now 202 and a fixed body, where the earlier version answered 201 + an enrollment session. The session
    // had to go: one branch of this endpoint cannot carry a credential when the other cannot.
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "ok" });

    // NOT ONE COOKIE. This is the assertion the service test structurally cannot make, and the
    // one that matters most: a constant JSON body with a `Set-Cookie` on the fresh branch only
    // is the same oracle moved into a header, and `enrollmentSession()` would have set two.
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(setCookieMap(res)).toEqual({});

    // The account really was created — a fact the response deliberately does not confirm.
    expect(await db.select().from(accounts)).toHaveLength(1);
    // …and the continuation went to the inbox.
    expect(mailer.only("email_verification").to).toBe("stranger@example.com");
  });

  it("the response is BYTE-IDENTICAL for a fresh and an already-registered address", async () => {
    // The test the whole slice exists for. #3 accepted a 201-vs-409 oracle and named the
    // trigger for reversing it; this is the reversal, asserted on the bytes rather than on a
    // status code, plus every header a client could read a difference out of.
    const { deps } = await makeDeps(undefined, {
      publicSignup: true, maxPublicRegistrationsPerWindow: 50,
    });

    const first = await post(deps, "twice@example.com");
    const second = await post(deps, "twice@example.com");
    const control = await post(deps, "never-seen@example.com");

    for (const [a, b] of [[second, first], [second, control]] as const) {
      expect(a.status).toBe(b.status);
      expect(await a.clone().text()).toBe(await b.clone().text());
      expect(a.headers.get("content-type")).toBe(b.headers.get("content-type"));
      expect(a.headers.get("set-cookie")).toBe(b.headers.get("set-cookie"));
    }

    // Spelled out, so a future reader does not have to reconstruct it from the loop.
    expect(second.status).toBe(202);
    expect(await second.text()).toBe('{"status":"ok"}');
    expect(second.headers.get("set-cookie")).toBeNull();
  });

  it("the header SET is identical too, not merely the ones we thought to check", async () => {
    // A whitelist of compared headers is a test that passes until somebody adds a header. This
    // compares the full sorted name list, minus the two that legitimately differ per request.
    const { deps } = await makeDeps(undefined, {
      publicSignup: true, maxPublicRegistrationsPerWindow: 50,
    });
    const names = (r: Response): string[] =>
      [...r.headers.keys()].filter((k) => k !== "x-request-id").sort();

    const fresh = await post(deps, "hdr@example.com");
    const taken = await post(deps, "hdr@example.com");
    expect(names(taken)).toEqual(names(fresh));
  });

  it("the response never carries `mailed`, which is a limiter readout", async () => {
    // `RegistrationPending.mailed` exists for the operator smoke path and the suite. On the wire
    // it would tell an anonymous caller whether the per-recipient mail budget for an address they
    // named is spent — i.e. whether we recently sent that person other mail. Exactly the mistake
    // `POST /waitlist` shipped and had to undo.
    const { deps } = await makeDeps(undefined, { publicSignup: true });
    const body = await (await post(deps, "nomailed@example.com")).text();
    expect(body).toBe('{"status":"ok"}');
    expect(body).not.toContain("mailed");
  });

  it("publicSignup OFF (the default): the same request is refused, and no account appears", async () => {
    const { db, deps } = await makeDeps();
    const res = await post(deps, "stranger@example.com");
    expect(res.status).toBe(400);
    expect((await envelope(res)).code).toBe("validation_failed");
    expect(await db.select().from(accounts)).toHaveLength(0);
  });

  it("the open path hands out NO credential, so there is no session to fence", async () => {
    // Under that change this case checked that the enrollment session register returned was still
    // unprivileged. There is no session on this path any more, which is the stronger version of
    // the same property: the fence cannot be climbed by a credential that was never issued.
    const { deps } = await makeDeps(undefined, { publicSignup: true });
    const res = await post(deps, "fenced@example.com");

    expect(res.status).toBe(202);
    expect(setCookieMap(res)).toEqual({});
    // Nothing in the body is presentable as one either.
    const raw = await res.text();
    expect(raw).not.toMatch(/token/i);

    // The INVITE path still mints one, and it is still an unprivileged enrollment session — the
    // enrollment fence, re-asserted where it still applies.
    const { code } = await makeWaitlistService({ mail: undefined })
      .mintInvite({ db: deps.db, now: deps.now }, { email: "inv@example.com", send: false });
    const invited = await post(deps, "inv@example.com", code);
    expect(invited.status).toBe(201);
    const cookies = setCookieMap(invited);
    const cookie = `tf_session=${cookies.tf_session}; tf_csrf=${cookies.tf_csrf}`;

    const mailboxes = await H(req("GET", "/mailboxes", { cookie }), deps);
    expect(mailboxes.status).toBe(403);
    expect((await envelope(mailboxes)).code).toBe("enrollment_incomplete");

    const session = await H(req("GET", "/auth/session", { cookie }), deps);
    expect(session.status).toBe(200);
    expect((await session.json() as { scope: string }).scope).toBe("enrollment");
  });
});

describe("an offered code is still judged, at the route", () => {
  it("a wrong code is refused even with the gate open", async () => {
    const { db, deps } = await makeDeps(undefined, {
      publicSignup: true, inviteCodes: new Set<string>(),
    });
    const res = await post(deps, "x@example.com", "OHMAIL-ZZZZ-ZZZZ-ZZZZ");
    expect(res.status).toBe(403);
    expect((await envelope(res)).code).toBe("invite_invalid");
    expect(await db.select().from(accounts)).toHaveLength(0);
  });

  it("a valid bound code still works with the gate open", async () => {
    const { deps } = await makeDeps(undefined, {
      publicSignup: true, inviteCodes: new Set<string>(),
    });
    const { code } = await makeWaitlistService({ mail: undefined })
      .mintInvite({ db: deps.db, now: deps.now }, { email: "invited@example.com", send: false });
    const res = await post(deps, "invited@example.com", code);
    expect(res.status).toBe(201);
  });
});

describe("the limiter refuses cleanly at the HTTP layer", () => {
  it("the N+1th signup is 429 with a parseable envelope — not a 500, not a 423", async () => {
    const { deps } = await makeDeps(undefined, {
      publicSignup: true, maxPublicRegistrationsPerWindow: 2,
    });
    expect((await post(deps, "one@example.com")).status).toBe(202);
    expect((await post(deps, "two@example.com")).status).toBe(202);

    const res = await post(deps, "three@example.com");
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect((await envelope(res)).code).toBe("rate_limited");
  });

  it("the bucket is per CLIENT: a second address is unaffected by the first's spend", async () => {
    // If the API read a proxy's address rather than the caller's, every visitor would share
    // one bucket and this would be a 429. It is the unit-level twin of the live check
    // recorded in the project's design notes #4b.
    const { deps } = await makeDeps(undefined, {
      publicSignup: true, maxPublicRegistrationsPerWindow: 1,
    });
    expect((await post(deps, "a@example.com", undefined, "203.0.113.1")).status).toBe(202);
    expect((await post(deps, "b@example.com", undefined, "203.0.113.1")).status).toBe(429);
    expect((await post(deps, "c@example.com", undefined, "203.0.113.2")).status).toBe(202);
  });

  it("a SPOOFED x-forwarded-for cannot mint a fresh bucket", async () => {
    // The host appends the client's address to the forwarding chain. An earlier hop
    // must leave that client's signup allowance intact.
    const { deps } = await makeDeps(undefined, {
      publicSignup: true, maxPublicRegistrationsPerWindow: 1,
    });
    const spoofed = (email: string, claim: string): Promise<Response> =>
      H(req("POST", "/auth/register", {
        headers: { "x-forwarded-for": `${claim}, ${IP}` },
        body: registerBody(email),
      }), deps);

    expect((await spoofed("s1@example.com", "1.1.1.1")).status).toBe(202);
    expect((await spoofed("s2@example.com", "2.2.2.2")).status).toBe(429);
    expect((await spoofed("s3@example.com", "3.3.3.3")).status).toBe(429);
  });

  it("NO platform IP at all: the open path answers 503, it does not silently skip the limit", async () => {
    const { deps } = await makeDeps(undefined, { publicSignup: true });
    const res = await H(req("POST", "/auth/register", { body: registerBody("noip@example.com") }), deps);
    expect(res.status).toBe(503);
    expect((await envelope(res)).code).toBe("signup_unavailable");
  });
});

describe("the capacity valve, at the route", () => {
  it("past the cap the open path answers 503 signup_capacity", async () => {
    const { deps } = await makeDeps(undefined, { publicSignup: true, publicSignupCap: 1 });
    expect((await post(deps, "first@example.com")).status).toBe(202);

    const res = await post(deps, "second@example.com");
    expect(res.status).toBe(503);
    const err = await envelope(res);
    expect(err.code).toBe("signup_capacity");
    // The client keys the waitlist hand-off on this code, so the sentence must also be one
    // a person can act on rather than an internal state name.
    expect(err.message).toMatch(/list/i);
  });
});
