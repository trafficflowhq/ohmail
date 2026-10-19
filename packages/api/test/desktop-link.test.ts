import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { sessions, devices } from "@trafficflow/db";
import { loginTokens, authEvents } from "@trafficflow/db/cloud";
import { DESKTOP_LINK_PURPOSE, hashToken } from "@trafficflow/services";
import { makeDeps, seedSession, seedSessionFor, req, setCookieMap, FIXED_NOW } from "./helpers.js";

/**
 * THE BROWSER SIGN-IN HANDOFF — `POST /auth/desktop-link` → `POST /auth/desktop-claim`.
 *
 * The desktop app's hosted door asks for an address, a password and a six-digit code, because a
 * native window has no browser to run a ceremony in. That is a password typed somewhere nobody
 * can check an address bar. This pair is the alternative: the browser mints a one-use code, the
 * person retypes it into the app, and the app exchanges it for the same token pair the password
 * path produces.
 *
 * Everything here is over HTTP, and that is the point rather than a preference — three of the
 * five subjects below are decided by the PIPELINE and are invisible to a service-level test:
 *
 *  · **the step-up gate on the mint** is a route option consumed by `withStepUp`. A service test
 *    cannot see whether the route carries it, which is the only way this can rot.
 *  · **the claim being reachable with no session at all** is `options.public`, i.e. whether
 *    `withSession` 401s before the handler runs. A direct service call always "works".
 *  · **the claim setting no cookies** is a property of the response the handler builds. It is
 *    asserted here because a `Set-Cookie` on this route would turn a code displayed on a screen
 *    into a browser session on whatever origin fetched it.
 *
 * The two remaining subjects — single-use, and the purposes being mutually invisible — are
 * behavioural and are asserted through the same door. The CONCURRENT half of single-use is not
 * here and cannot be: PGlite is one connection and structurally cannot interleave two claims.
 * `desktop-link.pg.test.ts` runs that against real Postgres, and hash-at-rest with it.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

const IP = "198.51.100.9";

const envelope = async (res: Response): Promise<{ code: string; message: string }> => {
  const body = await res.json() as { error?: { code: string; message: string } };
  expect(body.error, `expected an error envelope, got ${JSON.stringify(body)}`).toBeDefined();
  return body.error!;
};

/** Mint a code the way the settings pane does: a full session that cleared step-up. */
async function mint(
  deps: ApiDeps, token: string, body: Record<string, unknown> = {},
): Promise<{ code: string; expiresIn: number }> {
  const res = await H(req("POST", "/auth/desktop-link", {
    bearer: token, body: JSON.stringify(body),
  }), deps);
  expect(res.status, `mint refused: ${await res.clone().text()}`).toBe(200);
  return await res.json() as { code: string; expiresIn: number };
}

/**
 * The claim, with the request BODY built by the caller rather than from named arguments.
 *
 * That is not a style choice. The single most important assertion in this file is about a body
 * with NO `verifier` KEY AT ALL against a bound code, and a helper taking `verifier?: string`
 * cannot express the difference between "absent" and "the empty string" at the wire — which is
 * exactly the distinction the implementation must not blur.
 */
const claimBody = (deps: ApiDeps, body: unknown, ip = IP): Promise<Response> =>
  H(req("POST", "/auth/desktop-claim", {
    headers: { "x-vercel-forwarded-for": ip },
    body: JSON.stringify(body),
  }), deps);

const claim = (deps: ApiDeps, code: unknown, ip = IP): Promise<Response> =>
  claimBody(deps, { code }, ip);

/**
 * A PKCE pair, computed with node's own crypto rather than with the service's `hashToken`.
 *
 * DELIBERATELY not `hashToken(verifier)`: that would make the test agree with the server by
 * construction, so a change to the digest or its encoding would move both sides together and
 * nothing would fail. The encoding is a WIRE CONTRACT — a second implementation computes it in
 * another language — so it is spelled out here as base64url of the SHA-256 of the verifier's
 * UTF-8 bytes, unpadded, and that literal is the thing under test.
 */
const pkce = (): { verifier: string; challenge: string } => {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier, "utf8").digest("base64url"),
  };
};

describe("the handoff mint is gated by a live session AND a recent factor", () => {
  it("no session ⇒ 401, and nothing is minted", async () => {
    const { db, deps } = await makeDeps();
    const res = await H(req("POST", "/auth/desktop-link", { body: "{}" }), deps);
    expect(res.status).toBe(401);
    expect(await db.select().from(loginTokens)).toHaveLength(0);
  });

  it("a session that has NOT cleared step-up ⇒ 403 step_up_required, and nothing is minted", async () => {
    const { db, deps } = await makeDeps();
    // A full session whose second factor was asserted a long time ago — the shape of somebody
    // who left a tab open. It reads mail perfectly well; it may not grow a second machine a
    // long-lived credential, which is the same rule `DELETE /devices/:id` applies to taking
    // one away.
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: null });
    const res = await H(req("POST", "/auth/desktop-link", { bearer: s.token, body: "{}" }), deps);
    expect(res.status).toBe(403);
    expect((await envelope(res)).code).toBe("step_up_required");
    expect(await db.select().from(loginTokens)).toHaveLength(0);
  });

  it("a stepped-up session mints a code that is NOT stored in the clear, and audits the issue", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const { code, expiresIn } = await mint(deps, s.token);

    expect(code.length).toBeGreaterThanOrEqual(32);
    expect(expiresIn).toBe(120);

    const rows = await db.select().from(loginTokens);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.purpose).toBe(DESKTOP_LINK_PURPOSE);
    expect(rows[0]!.userId).toBe(s.userId);
    expect(rows[0]!.consumedAt).toBeNull();
    // The row holds the DIGEST and never the value. Asserted as an equality against the digest
    // and an INEQUALITY against the code, because "it is not equal to the code" alone would pass
    // for any encoding at all.
    expect(rows[0]!.tokenHash).toBe(hashToken(code));
    expect(rows[0]!.tokenHash).not.toBe(code);

    const events = await db.select().from(authEvents).where(eq(authEvents.userId, s.userId));
    expect(events.map((e) => e.event)).toContain("desktop_link_issued");
  });
});

describe("the claim needs no session, and hands back the native pair and nothing else", () => {
  it("an anonymous claim of a live code answers {tokens} — no cookies, no user", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const { code } = await mint(deps, s.token);

    const res = await claim(deps, code);
    expect(res.status).toBe(200);
    const body = await res.json() as { tokens?: { accessToken?: string; refreshToken?: string }; user?: unknown };
    expect(typeof body.tokens?.accessToken).toBe("string");
    expect(typeof body.tokens?.refreshToken).toBe("string");
    // NOT a browser sign-in. A `Set-Cookie` here would make a code read off a screen into a
    // session on whatever origin fetched it, and the claimant is a desktop install that reads
    // the body.
    expect(setCookieMap(res)).toEqual({});
    expect(body.user).toBeUndefined();

    // The session it established is REAL and REVOCABLE: a `sessions` row for the same user and
    // a `devices` row the account can see in Settings and take away again. That revocation path
    // is most of why offering the handoff is defensible at all.
    const live = await db.select().from(sessions).where(eq(sessions.userId, s.userId));
    expect(live.length).toBe(2);
    const claimed = live.find((r) => r.id !== s.sessionId)!;
    expect(claimed.scope).toBe("full");
    const dev = await db.select().from(devices).where(eq(devices.id, claimed.deviceId!));
    expect(dev[0]!.kind).toBe("macos");
  });

  it("the access token it returns really opens the account", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const { code } = await mint(deps, s.token);
    const { tokens } = await (await claim(deps, code)).json() as { tokens: { accessToken: string } };

    // Driven over HTTP rather than read out of the table: the subject is whether a client that
    // holds only this pair is signed in, and a row that looks right proves nothing about
    // `resolveSession`.
    const me = await H(req("GET", "/auth/session", { bearer: tokens.accessToken }), deps);
    expect(me.status).toBe(200);
    const seen = await me.json() as { user: { userId: string }; scope: string };
    expect(seen.user.userId).toBe(s.userId);
    expect(seen.scope).toBe("full");
  });
});

describe("a code works ONCE, briefly, and only as the thing it was minted as", () => {
  it("SINGLE USE — the second claim of the same code is refused", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const { code } = await mint(deps, s.token);

    expect((await claim(deps, code)).status).toBe(200);

    const second = await claim(deps, code);
    expect(second.status).toBe(400);
    expect((await envelope(second)).code).toBe("invalid_code");
    // And no second session came of it. The status alone would pass for a handler that refused
    // AFTER establishing one.
    expect(await db.select().from(sessions).where(eq(sessions.userId, s.userId))).toHaveLength(2);
  });

  it("A MINT SUPERSEDES — asking for another code kills the one on screen", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const first = await mint(deps, s.token);
    const second = await mint(deps, s.token);
    expect(second.code).not.toBe(first.code);

    // The reason this matters: the commonest reason to press "show me another code" is that the
    // first one was seen by somebody. If it stayed live for its full two minutes, the decision to
    // replace it would have bought nothing.
    const stale = await claim(deps, first.code);
    expect(stale.status).toBe(400);
    expect((await envelope(stale)).code).toBe("invalid_code");
    expect((await claim(deps, second.code)).status).toBe(200);
  });

  it("and the rows this route can ever leave behind are bounded at one per user", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    // `login_tokens` has no reaper, and this is the one producer with neither a login throttle
    // nor a per-IP mail quota in front of it. Twenty presses must leave one row, not twenty.
    for (let i = 0; i < 20; i++) await mint(deps, s.token);
    const rows = await db.select().from(loginTokens)
      .where(eq(loginTokens.purpose, DESKTOP_LINK_PURPOSE));
    expect(rows).toHaveLength(1);
  });

  it("TTL — a code is dead two minutes after it was minted", async () => {
    const { db, deps, clock } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const { code } = await mint(deps, s.token);

    // One second inside the window still works; the assertion is that the boundary is where the
    // config says and not merely "somewhere".
    clock.advance(119_000);
    const stillLive = await db.select().from(loginTokens);
    expect(stillLive[0]!.expiresAt.getTime()).toBe(FIXED_NOW.getTime() + 120_000);

    clock.advance(2_000);
    const late = await claim(deps, code);
    expect(late.status).toBe(400);
    expect((await envelope(late)).code).toBe("invalid_code");
    // Not consumed — refused. An expired code that got marked used would hide the difference
    // between "too late" and "someone else claimed it".
    expect((await db.select().from(loginTokens))[0]!.consumedAt).toBeNull();
  });

  it("THE PURPOSES ARE MUTUALLY INVISIBLE — a mailed email_verify token cannot be claimed", async () => {
    const { db, deps, mail, mailer } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    // Minted through the mail service, i.e. the real other writer of this table, and the RAW
    // value is lifted out of the mail. That is what makes this the strong form of the test: the
    // caller below holds the exact secret and still gets nothing, because the claim's query
    // filters on `purpose`. Presenting a value nobody has would prove only that hashing works.
    await mail.issueEmailVerification({ db, now: () => FIXED_NOW }, {
      userId: s.userId, to: `mila+${s.accountId}@lichtgrat.example`,
    });
    const mailed = await db.select().from(loginTokens)
      .where(eq(loginTokens.purpose, "email_verify"));
    expect(mailed).toHaveLength(1);
    const raw = new URL(mailer.only("email_verification").data.verifyUrl).searchParams.get("token")!;
    expect(hashToken(raw)).toBe(mailed[0]!.tokenHash);

    const refused = await claim(deps, raw);
    expect(refused.status).toBe(400);
    expect((await envelope(refused)).code).toBe("invalid_code");
    // …and the row it could not see is untouched, so the link still works for the thing it IS.
    const after = await db.select().from(loginTokens)
      .where(and(eq(loginTokens.purpose, "email_verify"), eq(loginTokens.id, mailed[0]!.id)));
    expect(after[0]!.consumedAt).toBeNull();
    // No session came of it either — the check that survives a future handler which refuses
    // after establishing one.
    expect(await db.select().from(sessions).where(eq(sessions.userId, s.userId))).toHaveLength(1);
  });

  it("a desktop code cannot be presented as a FIRST FACTOR login token", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const { code } = await mint(deps, s.token);

    // `peekLoginToken` filters `purpose='login'`, so the 2FA surface must not see this row.
    // Driven at the route rather than the service: the refusal has to be an HTTP answer.
    const res = await H(req("POST", "/auth/2fa/totp/verify", {
      body: JSON.stringify({ loginToken: code, code: "000000" }),
    }), deps);
    expect(res.status).toBe(401);
    // Still claimable afterwards, which proves the 2FA path did not consume it either.
    expect((await claim(deps, code)).status).toBe(200);
  });

  it("a blank, absent or absurd code is a 400 and never a 500", async () => {
    const { deps } = await makeDeps();
    for (const body of ["{}", JSON.stringify({ code: "" }), JSON.stringify({ code: 42 }),
      JSON.stringify({ code: "x".repeat(2000) })]) {
      const res = await H(req("POST", "/auth/desktop-claim", {
        headers: { "x-vercel-forwarded-for": IP }, body,
      }), deps);
      expect(res.status, `body ${body.slice(0, 40)} answered ${res.status}`).toBe(400);
      expect((await envelope(res)).code).toBe("invalid_code");
    }
  });
});

describe("a code minted against a CHALLENGE is spendable only by whoever holds the verifier", () => {
  /**
   * THE ONE THIS WHOLE MECHANISM STANDS ON.
   *
   * The deep link exists because a person should not have to retype a code, and the price of it
   * is that `ohmail://` is claimed by whichever program on the machine registered it — nothing
   * authenticates that. The binding is what makes an intercepted code worthless, and the way the
   * binding gets bypassed is not by breaking SHA-256: it is by sending LESS. `{code}` with no
   * `verifier` key must be refused for a bound code.
   *
   * The implementation shape that fails this is the natural one — build the WHERE conditionally,
   * `if (verifier) conditions.push(binding)` — because with no verifier there is no predicate and
   * a bound row matches every other conjunct. That reads as a correct optional parameter and is a
   * complete bypass, which is why this test presents a body with the KEY ABSENT rather than an
   * empty string: the two must not be the same request, and only the wire can say so.
   */
  it("ABSENT verifier field on a bound code ⇒ refused, and the code is NOT burned", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const { verifier, challenge } = pkce();
    const { code } = await mint(deps, s.token, { challenge });

    const refused = await claimBody(deps, { code });
    expect(refused.status, "a bound code was claimed with no verifier at all").toBe(400);
    expect((await envelope(refused)).code).toBe("invalid_code");
    // No session came of it — the check that survives a handler which refuses AFTER establishing.
    expect(await db.select().from(sessions).where(eq(sessions.userId, s.userId))).toHaveLength(1);

    // AND THE CODE SURVIVED. The predicate is on the UPDATE, so a claim that cannot satisfy the
    // binding matches no row and changes nothing. A consume-then-compare implementation would let
    // any scheme interceptor destroy a code it could not spend, which is a denial of service
    // dressed as a refusal — and the person's app is still holding the right verifier.
    expect((await db.select().from(loginTokens))[0]!.consumedAt).toBeNull();
    expect((await claimBody(deps, { code, verifier })).status).toBe(200);
  });

  it("the RIGHT verifier claims it, and the raw verifier is never stored", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const { verifier, challenge } = pkce();
    const { code } = await mint(deps, s.token, { challenge });

    // The commitment is on the row, stored as sent — it is the PUBLIC half of the pair, so it is
    // neither hashed again nor sealed, and a reader of the table can check the binding.
    const before = await db.select().from(loginTokens);
    expect(before).toHaveLength(1);
    expect(before[0]!.challengeHash).toBe(challenge);
    // …and the verifier itself is nowhere, which is the property that makes an interceptor's
    // copy of the code useless: the only place it exists is the process that invented it.
    expect(JSON.stringify(before[0]!)).not.toContain(verifier);

    const res = await claimBody(deps, { code, verifier });
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await res.json() as { tokens?: { accessToken?: string } };
    expect(typeof body.tokens?.accessToken).toBe("string");
    expect(setCookieMap(res)).toEqual({});
    expect((await db.select().from(loginTokens))[0]!.consumedAt).not.toBeNull();
  });

  it("a WRONG verifier is refused in the SAME words as a code that never existed", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const { challenge } = pkce();
    const { code } = await mint(deps, s.token, { challenge });

    // A verifier of the right SHAPE and the wrong value — the shape matters, because a refusal
    // that came from a format check rather than from the comparison would prove nothing.
    const wrong = pkce().verifier;
    const bad = await claimBody(deps, { code, verifier: wrong });
    const unknown = await claimBody(deps, { code: "no-such-code-at-all", verifier: wrong });

    expect(bad.status).toBe(400);
    expect(unknown.status).toBe(bad.status);
    // BYTE-IDENTICAL envelopes. Telling a caller "the code is real, your proof is wrong" is
    // exactly the fact a scheme interceptor would like to learn: it turns a useless code into a
    // confirmed target. Compared as whole objects rather than by `.code`, so a future field that
    // distinguished them — a hint, a retry count — fails here.
    expect(await envelope(bad)).toEqual(await envelope(unknown));
    expect((await db.select().from(loginTokens))[0]!.consumedAt).toBeNull();
  });

  it("an UNBOUND code is claimable with NO verifier, and is REFUSED when one is presented", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });

    // No challenge at mint: the retype flow, where nobody is holding a verifier. The column is
    // NULL rather than an empty string — NULL is the state the claim's predicate reads. This path
    // is UNCHANGED by the login-CSRF fix: no verifier presented ⇒ claimable, exactly as before.
    const first = await mint(deps, s.token);
    expect((await db.select().from(loginTokens))[0]!.challengeHash).toBeNull();
    expect((await claimBody(deps, { code: first.code })).status).toBe(200);

    // …and an unbound code claimed WHILE A VERIFIER IS PRESENTED is refused, not admitted. This
    // is the login-CSRF / session-fixation direction (SEC2-AUTH-DEEPLINK-INJECT): the only caller
    // that ever presents a verifier is one that minted a challenge and therefore opened a BOUND
    // code (`apps/sidecar/src/cloud-engine.ts` keeps the verifier and publishes the challenge; the
    // field is OMITTED when no challenge was minted — `cloud-signin.ts:256-263`). So an unbound
    // row reaching a verifier-bearing claim is an ATTACKER's code injected onto a victim whose
    // install is mid-handoff; admitting it would sign that victim into the attacker's account.
    // The predicate is on the UPDATE, so the refused claim burns nothing.
    const second = await mint(deps, s.token);
    const injected = await claimBody(deps, { code: second.code, verifier: pkce().verifier });
    expect(injected.status, "an unbound code was claimed while a verifier was presented").toBe(400);
    expect((await envelope(injected)).code).toBe("invalid_code");
    expect((await db.select().from(loginTokens))[0]!.consumedAt).toBeNull();
    // …and it stays claimable the way it WAS minted — unbound, no verifier — so a real retype
    // client that never sends a verifier is untouched.
    expect((await claimBody(deps, { code: second.code })).status).toBe(200);
  });

  it("a MALFORMED challenge is refused at the mint — never a silently UNBOUND code", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });

    // The failure this refusal exists to prevent: the app sends something the server cannot use,
    // the server shrugs and mints an ordinary code, and the app then hands that code to a URL
    // scheme any program can claim — believing all the while that it is worthless without the
    // verifier. Every party thinks the binding is on. So a challenge that is not a SHA-256 digest
    // stops the mint, and NOTHING is minted.
    for (const challenge of [
      "short",
      `${"A".repeat(43)}=`,                       // padded
      "A".repeat(44),                              // one too long
      "A".repeat(42),                              // one too short
      "not+base64url/at+all=========================",
      createHash("sha256").update("v").digest("hex"),  // hex, not base64url
    ]) {
      const res = await H(req("POST", "/auth/desktop-link", {
        bearer: s.token, body: JSON.stringify({ challenge }),
      }), deps);
      expect(res.status, `challenge ${challenge.slice(0, 24)} was accepted`).toBe(400);
      expect((await envelope(res)).code).toBe("invalid_challenge");
      expect(await db.select().from(loginTokens), "a refused mint left a row").toHaveLength(0);
    }

    // A non-string is the same fault and not a silent unbound mint either — `{challenge: 42}` is
    // a caller that meant to bind and did not.
    const wrongType = await H(req("POST", "/auth/desktop-link", {
      bearer: s.token, body: JSON.stringify({ challenge: 42 }),
    }), deps);
    expect(wrongType.status).toBe(400);
    expect(await db.select().from(loginTokens)).toHaveLength(0);

    // …and an ABSENT challenge is not a fault at all. This is the line that keeps the refusal
    // above from quietly becoming "the deep link is now mandatory".
    expect((await mint(deps, s.token)).code.length).toBeGreaterThanOrEqual(32);
  });

  it("the SUPERSEDE still kills the previous code, across the binding boundary", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const a = pkce();

    // Bound, then unbound: pressing "show me another code" from a page the app opened, and then
    // from one the person opened. The supersede is a DELETE keyed on user and purpose, so it must
    // not have grown a challenge-shaped exception — a bound row that outlived its replacement
    // would be a live way in that the screen no longer shows.
    const bound = await mint(deps, s.token, { challenge: a.challenge });
    const unbound = await mint(deps, s.token);
    expect((await db.select().from(loginTokens))).toHaveLength(1);
    expect((await claimBody(deps, { code: bound.code, verifier: a.verifier })).status).toBe(400);
    expect((await claimBody(deps, { code: unbound.code })).status).toBe(200);

    // …and the other order, which is the one that matters more: an unbound code must not survive
    // a bound mint, or the deep-link ceremony would leave a retypable code behind it.
    const s2 = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const b = pkce();
    const stale = await mint(deps, s2.token);
    const fresh = await mint(deps, s2.token, { challenge: b.challenge });
    expect((await claimBody(deps, { code: stale.code })).status).toBe(400);
    expect((await claimBody(deps, { code: fresh.code, verifier: b.verifier })).status).toBe(200);
  });

  it("an over-long verifier is a 400 and never a 500", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const { challenge } = pkce();
    const { code } = await mint(deps, s.token, { challenge });

    // Bounded before it reaches `sha256`, for the reason the code itself is: this arrives from an
    // anonymous caller and an unbounded body is free work for whoever wants to send a megabyte.
    for (const verifier of ["x".repeat(2000), 42, null, { a: 1 }]) {
      const res = await claimBody(deps, { code, verifier });
      expect(res.status, `verifier ${String(verifier).slice(0, 20)} answered ${res.status}`).toBe(400);
      expect((await envelope(res)).code).toBe("invalid_code");
    }
    expect((await db.select().from(loginTokens))[0]!.consumedAt).toBeNull();
  });
});

describe("signing another session out takes the code it left on screen", () => {
  /**
   * A code is a grant that signs in on its own, so a door that signs its session out takes it too:
   * the HTTP doors, the hosted logout override's own transaction included. A code minted after the
   * door by a session still live is the control.
   */
  const DOORS: Array<[string, (deps: ApiDeps, bearer: string, other: string) => Promise<Response>, boolean]> = [
    ["POST /auth/logout {allDevices}", (deps, bearer) =>
      H(req("POST", "/auth/logout", { bearer, body: JSON.stringify({ allDevices: true }) }), deps), true],
    ["DELETE /devices/:id", (deps, bearer, other) => H(req("DELETE", `/devices/${other}`, { bearer }), deps), false],
    ["POST /devices/revoke-web-sessions", (deps, bearer) =>
      H(req("POST", "/devices/revoke-web-sessions", { bearer, body: "{}" }), deps), false],
  ];

  for (const [door, run, takesCaller] of DOORS) {
    it(`${door}: the other session's code is refused; a code minted after claims`, async () => {
      const { db, deps } = await makeDeps();
      const a = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
      const b = await seedSessionFor(db, { accountId: a.accountId, userId: a.userId, now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
      const { code } = await mint(deps, b.token);

      const res = await run(deps, a.token, b.sessionId);
      expect(res.status, await res.clone().text()).toBeLessThan(300);

      const refused = await claim(deps, code);
      expect(refused.status, "the code outlived the sign-out").toBe(400);
      expect((await envelope(refused)).code).toBe("invalid_code");

      const live = takesCaller
        ? (await seedSessionFor(db, { accountId: a.accountId, userId: a.userId, now: FIXED_NOW, lastTwofaAt: FIXED_NOW })).token
        : a.token;
      expect((await claim(deps, (await mint(deps, live)).code)).status).toBe(200);
    });
  }
});

describe("a claimed desktop keeps the browser's factor time", () => {
  /**
   * The claim used to stamp its session's factor time `now`, so a stepped-up session could link a
   * desktop, that desktop could link the next one inside its fresh window, and so on: step-up never
   * aged out on one factor. A claim now inherits the factor time of the session that minted the
   * code, so the chain ages out on the first factor. `POST /pair` is the step-up door it reaches.
   */
  it("a chain of claims keeps the first factor's time; past its window the claimed desktop cannot pair", async () => {
    const { db, deps, clock } = await makeDeps();
    const stampOf = async (accessToken: string): Promise<string | undefined> =>
      (await db.select({ at: sessions.lastTwofaAt }).from(sessions)
        .where(eq(sessions.accessTokenHash, hashToken(accessToken))))[0]?.at?.toISOString();
    const t0 = FIXED_NOW;
    const web = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: t0 });

    clock.advance(60_000);
    const a = await (await claim(deps, (await mint(deps, web.token)).code)).json() as { tokens: { accessToken: string } };
    expect(await stampOf(a.tokens.accessToken), "the claim stamped its own time").toBe(t0.toISOString());

    clock.advance(2 * 60_000);
    const b = await (await claim(deps, (await mint(deps, a.tokens.accessToken)).code)).json() as { tokens: { accessToken: string } };
    expect(await stampOf(b.tokens.accessToken)).toBe(t0.toISOString());

    clock.advance(2 * 60_000 + 1_000); // one second past the window opened by the factor at t0
    const pairFrom = (bearer: string) => H(req("POST", "/pair", {
      bearer, body: JSON.stringify({ grant: "device-pair", label: "Phone" }),
    }), deps);
    const refused = await pairFrom(b.tokens.accessToken);
    expect(refused.status).toBe(403);
    expect((await envelope(refused)).code).toBe("step_up_required");

    // The control: a factor asserted now, linked and claimed inside its window, pairs.
    const fresh = await seedSessionFor(db, { accountId: web.accountId, userId: web.userId, now: clock.now(), lastTwofaAt: clock.now() });
    const c = await (await claim(deps, (await mint(deps, fresh.token)).code)).json() as { tokens: { accessToken: string } };
    expect((await pairFrom(c.tokens.accessToken)).status).toBe(200);
  });
});

describe("the claim is attempt-bound per connection", () => {
  it("the eleventh attempt from one IP is 429, and a different IP is unaffected", async () => {
    const { deps } = await makeDeps();
    // `maxDesktopClaimsPerWindow` is 10. Ten wrong codes are admitted and refused on their
    // merits; the eleventh is refused by the limiter — which is a DIFFERENT code and status, so
    // the two refusals stay distinguishable to a client that wants to say something useful.
    for (let i = 0; i < 10; i++) {
      expect((await claim(deps, `wrong-${i}`)).status).toBe(400);
    }
    const capped = await claim(deps, "wrong-10");
    expect(capped.status).toBe(429);
    expect((await envelope(capped)).code).toBe("rate_limited");

    // Per connection, not global. A shared bucket would let one prober take the flow away from
    // everybody, which is the failure `ip-throttle.ts` was lifted out of the waitlist to avoid.
    expect((await claim(deps, "wrong-0", "203.0.113.4")).status).toBe(400);
  });

  it("a LIVE code is still refused once the window is spent — the limiter is ahead of the read", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const { code } = await mint(deps, s.token);
    for (let i = 0; i < 10; i++) await claim(deps, `wrong-${i}`);

    const capped = await claim(deps, code);
    expect(capped.status).toBe(429);
    // AND THE CODE SURVIVED. A limiter that ran after the burn would have spent somebody's
    // credential on a request it then refused, and they would have no way to tell.
    expect((await db.select().from(loginTokens))[0]!.consumedAt).toBeNull();
  });
});
