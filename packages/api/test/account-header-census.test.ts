import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { refreshTokens } from "@trafficflow/db";
import { authEvents } from "@trafficflow/db/cloud";
import { generateToken, hashToken, totpNow } from "@trafficflow/services";
import { ACCOUNT_HEADER, createApp, apiRoutes, csrfTokenFor, type ApiDeps, type Route } from "@trafficflow/api";
import { makeDeps, seedSession, seedSessionFor, req, setCookieMap, sweepPath, FIXED_NOW, type TestClock } from "./helpers.js";

/**
 * ═══ THE OWNER-BOUND RESPONSE CENSUS ══════════════════════════════════════════════════════════
 *
 * `AF-RESPONSE-NOT-OWNER-BOUND`. A mirror belongs to exactly one account and no byte from another
 * account's session may reach it. The client binds each request to the account it believes is
 * signed in and asks again when the answer lands — but both are OBSERVATIONS, made when something
 * reads. A switch to another account and back that completes entirely inside one request's flight
 * leaves every client-side observation reading exactly as it did before, and a response selected
 * under the other account is applied. The browser cannot observe a state it was never asked
 * about; only the server can name whose question it answered.
 *
 * So the server names it, on every response that resolved a session. This file is the pair of
 * censuses that keep that true, and they are deliberately of two different KINDS:
 *
 *  1. **The source census** — the header is set in exactly ONE place. A second site is a second
 *     thing to keep true, and the value it would carry is the one thing that must not disagree
 *     with itself.
 *  2. **The route census** — every route in `apiRoutes` that resolves a session answers with the
 *     header, driven through the real `createApp` over a real session. EXACT over the table, with
 *     no remainder: a new route is covered by construction, and if it ever stops being, this
 *     goes red naming it.
 *
 * ── WHY BOTH, AND WHY THE ROUTE ONE IS BEHAVIOURAL ───────────────────────────────────────────
 *
 * `app.ts` records three occasions on which a route declared a control whose pipeline omitted the
 * middleware that reads it — `verifiedEmail`, `withSpendGate`, `withStepUp` — and all three
 * LOOKED like controls in the route table. A source census alone would have been green for every
 * one of them. The sweep below is the half that cannot be satisfied by a declaration: it asks the
 * real app, over the real table, and reads what comes back.
 *
 * ── WHAT IS NOT CLAIMED HERE ─────────────────────────────────────────────────────────────────
 *
 * This is the SERVER half. It makes the account nameable; it does not make anybody check it. The
 * client half — comparing the header against the account the browser is bound to, before any byte
 * is applied — is `apps/webapp`, and until it lands this header is a statement nobody reads. That
 * is worth saying plainly rather than letting the census read as a closed loop.
 *
 * Nor does it close the race itself: a server that names the account does not stop the session
 * from changing mid-flight. It makes the change VISIBLE to a client that compares, which is the
 * one thing no arrangement of client-side checks could do.
 */

const SRC = resolve(fileURLToPath(new URL("../src", import.meta.url)));

/** Every `.ts` file under `packages/api/src`, recursively. */
function srcFiles(dir: string = SRC): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("the header is set in exactly one place", () => {
  /**
   * The literal, and the exported constant, each traced across the whole of `src`. Both
   * directions are needed: a second site could spell the header out, or it could import the
   * constant, and a census that checked only one of those would be green for the other.
   */
  it("only `app.ts` names it", () => {
    const files = srcFiles();
    // Anti-vacuity: a walker that found nothing would pass every assertion below.
    expect(files.length, "no source files found — the walker is broken").toBeGreaterThan(20);

    const literal: string[] = [];
    const constant: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      const rel = relative(SRC, f);
      if (text.includes(ACCOUNT_HEADER)) literal.push(rel);
      if (text.includes("ACCOUNT_HEADER")) constant.push(rel);
    }

    // NAMING IS NOT WRITING, in either spelling. `routes/hello.ts` names the header in the comment
    // that explains the capability advertising it — documentation, not a second answer. What must
    // stay singular is the WRITE, and it is checked below for the literal exactly as it is for the
    // constant, so `headers.set("X-Ohmail-Account", …)` spelled out longhand is caught too.
    const literalWriters = files
      .filter((f) => new RegExp(`headers\\.set\\(\\s*["'\`]${ACCOUNT_HEADER}`, "i").test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(literalWriters, "no file may write the header by its literal name").toEqual([]);
    expect(
      literal.includes("app.ts"),
      "app.ts must still define the header — the literal has to live somewhere",
    ).toBe(true);
    // NAMING the constant is not SETTING the header, and the census tests the second. `index.ts`
    // re-exports it so the webapp and the tests learn the header without re-spelling it, and
    // `context.ts`/`router.ts`/`deps.ts` cite it from the comments that explain the machinery
    // feeding it. Forbidding those would be a census against documentation. What must stay
    // singular is the WRITE, so that is what is counted — everywhere, not just in app.ts.
    /* RE-DERIVED, not relaxed. The write used to be a literal `headers.set(ACCOUNT_HEADER, …)`
       here; it now goes through `app.ts`'s own `withHeader`, which decides whether the runtime
       has a body to copy — on React Native's `Response` it has none, and the copy emptied every
       session-authenticated answer on the phone's own door. So the census counts the WRITE in
       both spellings: the direct `headers.set` and the one argument position that reaches it. */
    const WRITE = /headers\.set\(\s*ACCOUNT_HEADER|withHeader\([^)]*ACCOUNT_HEADER/;
    const setters = files.filter((f) => WRITE.test(readFileSync(f, "utf8")))
      .map((f) => relative(SRC, f));
    expect(setters, "exactly one file writes the header").toEqual(["app.ts"]);

    // And every file that merely names it does so without writing it — the check that keeps the
    // sentence above true as the citation list grows.
    for (const rel of constant) {
      const text = readFileSync(join(SRC, rel), "utf8");
      const writes = (text.match(/headers\.set\(\s*ACCOUNT_HEADER/g)?.length ?? 0)
        + (text.match(/withHeader\([^)]*ACCOUNT_HEADER/g)?.length ?? 0);
      expect(writes, `${rel} may cite the constant, not write it`).toBe(rel === "app.ts" ? 1 : 0);
    }
    const barrel = readFileSync(join(SRC, "index.ts"), "utf8");
    const mentions = barrel.split("\n").filter((l) => l.includes("ACCOUNT_HEADER"));
    expect(mentions.length, "one line in the barrel, and it is an export").toBe(1);
    expect(
      mentions[0]!.trimStart().startsWith("export {"),
      "the barrel may re-export the constant and must not use it",
    ).toBe(true);
  });

  /**
   * And within `app.ts`, set once. The `handle` seam is above every pipeline, so a route CANNOT
   * bypass it — this asserts nobody has since moved the set down into one.
   */
  it("`app.ts` sets it once, above the pipelines", () => {
    const src = readFileSync(join(SRC, "app.ts"), "utf8");
    const sets = (src.match(/headers\.set\(ACCOUNT_HEADER/g)?.length ?? 0)
      + (src.match(/withHeader\([^)]*ACCOUNT_HEADER/g)?.length ?? 0);
    expect(sets, "exactly one write of ACCOUNT_HEADER in app.ts").toBe(1);
    /* AND IT GOES THROUGH THE ONE PLACE THAT DECIDES WHETHER TO COPY THE RESPONSE. A bare
       `new Response(res.body, …)` beside this is the defect: on React Native's `Response` there
       is no `body` property, so the copy carries an empty string and a person's mail never
       reaches the app that asked for it. */
    expect(src, "the write must route through `withHeader`")
      .toMatch(/withHeader\(res,\s*ACCOUNT_HEADER/);
    // The value comes from the resolved session, never from anything the caller sent.
    expect(src).toContain("deps.session?.accountId");
    expect(
      src.includes("ACCOUNT_HEADER") && !/req\.headers\.get\(\s*ACCOUNT_HEADER/.test(src),
      "the response header must never echo a request header of the same name",
    ).toBe(true);
  });
});

/**
 * SSE closes on its own lifetime rather than on the census's patience: `GET /events` is a real
 * route in the sweep and its body is a stream. Short enough that the sweep does not wait on it,
 * long enough that the route still builds its Response the way it does in production.
 */
const FAST_SSE = { heartbeatMs: 5, pollMs: 5, lifetimeMs: 20 };

const app = createApp(apiRoutes);

/** A path for a route pattern: well-formed ids and queries that name no row (`sweepPath`). */
const pathFor = (route: Route, id: string): string => sweepPath(route, id);

/**
 * Drive one route and read the header off the answer. `deps` is spread FRESH per request because
 * `withSession` mutates `session` in place, and the body is cancelled because one of these routes
 * is a live stream.
 */
async function headerFor(
  base: ApiDeps, route: Route, init: { bearer?: string; headers?: Record<string, string> },
): Promise<{ status: number; account: string | null }> {
  const r = req(route.method, pathFor(route, randomUUID()), init);
  const res = await app.handle(r, { ...base, session: null, idempotency: null, sse: FAST_SSE });
  await res.body?.cancel().catch(() => {});
  return { status: res.status, account: res.headers.get(ACCOUNT_HEADER) };
}

describe("every route that resolves a session names the account it answered for", () => {
  /**
   * The positive sweep, EXACT over the table. `anonymous` routes are excluded because
   * ANONYMOUS_PIPELINE never resolves a session at all — they are swept separately below, and the
   * two sets together are the whole table, so nothing falls between them.
   */
  it("every non-anonymous route carries the header, whatever it answers", async () => {
    const { db, deps } = await makeDeps();

    // The CREDENTIAL routes are excluded and covered separately: they answer for the credential
    // they resolved, so driving them with a session and a nonsense body establishes nothing and
    // they correctly name nobody. Excluding them here would be a hole if the set were open, so
    // the set is frozen by name in the last test of this file.
    const routes = apiRoutes.filter((r) => !r.options?.anonymous && !r.options?.credentialSubject);
    expect(routes.length, "an empty sweep passes vacuously").toBeGreaterThan(100);

    const silent: string[] = [];
    const wrong: string[] = [];
    for (const route of routes) {
      // A FRESH SESSION PER ROUTE, and it is not tidiness. Several routes in this table END the
      // session they are given — `DELETE /account` erases the account, the sign-out routes revoke
      // it, and `POST /auth/refresh` presented with an ACCESS token trips reuse detection and
      // revokes the whole family. Sharing one session made every route after the first of those
      // answer 401 with no header, which is indistinguishable from the defect this census is for:
      // 164 routes reported as silent, and the sweep would have been just as red with the header
      // working perfectly.
      const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
      const { status, account } = await headerFor(deps, route, { bearer: s.token });
      if (account === null) silent.push(`${route.method} ${route.pattern} → ${status}`);
      else if (account !== s.accountId) wrong.push(`${route.method} ${route.pattern} → ${account}`);
    }

    expect(
      silent,
      "routes that answered a live session without naming the account they answered for",
    ).toEqual([]);
    expect(wrong, "routes that named an account other than the session's").toEqual([]);
  });

  /**
   * The anti-vacuity half, and the one that keeps the sweep above from being satisfiable by a
   * header welded on unconditionally. An `anonymous` route resolves no session — nothing about it
   * is account-scoped — so it must stay silent even when the caller presents a live credential.
   */
  /**
   * WHAT THIS PRESENTS, precisely: a live SESSION credential (a bearer for a real account). It does
   * not synthesise each route's own body credential — an anonymous route that wants a pairing
   * token or a staff secret is driven without one and answers its own refusal. That is enough for
   * the claim being made, which is about the SESSION never leaking into the header on a pipeline
   * that resolves none; it is not a claim that these routes were exercised successfully.
   */
  it("every anonymous route stays silent, even with a live session presented", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });

    const routes = apiRoutes.filter((r) => r.options?.anonymous);
    expect(routes.length, "an empty sweep passes vacuously").toBeGreaterThan(10);

    const spoke: string[] = [];
    for (const route of routes) {
      const { account } = await headerFor(deps, route, { bearer: s.token });
      if (account !== null) spoke.push(`${route.method} ${route.pattern} → ${account}`);
    }
    expect(spoke, "anonymous routes resolve no session and must name no account").toEqual([]);
  });

  /** Absent for a caller who presented nothing: a 401 is not a response issued for anybody. */
  it("an unauthenticated caller is named as nobody", async () => {
    const { deps } = await makeDeps();
    const protectedRoutes = apiRoutes.filter((r) => !r.options?.public && !r.options?.anonymous);
    expect(protectedRoutes.length).toBeGreaterThan(100);

    const spoke: string[] = [];
    for (const route of protectedRoutes) {
      const { status, account } = await headerFor(deps, route, {});
      if (status !== 401 || account !== null) {
        spoke.push(`${route.method} ${route.pattern} → ${status} ${account ?? "(silent)"}`);
      }
    }
    expect(spoke, "protected routes must answer 401 and name nobody").toEqual([]);
  });
});

describe("the name comes from the session, and from nothing else", () => {
  /**
   * THE INVARIANT ITSELF. Two live sessions for two accounts, the same route, one after the
   * other: the answer names whoever the SESSION resolved for, which is the whole content of the
   * claim a client will compare against.
   */
  it("two sessions on one route are named differently", async () => {
    const { db, deps } = await makeDeps();
    const a = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const b = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    expect(a.accountId).not.toBe(b.accountId);

    const sync = apiRoutes.find((r) => r.method === "GET" && r.pattern === "/sync");
    expect(sync, "/sync must exist for this to mean anything").toBeDefined();

    const forA = await headerFor(deps, sync!, { bearer: a.token });
    const forB = await headerFor(deps, sync!, { bearer: b.token });
    expect(forA.account).toBe(a.accountId);
    expect(forB.account).toBe(b.accountId);
  });

  /**
   * A caller who SENDS the header does not get it back. The value is read from the session row;
   * a header that echoed the caller's own claim would confirm every switch it exists to catch.
   */
  it("a forged request header is not echoed", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const other = randomUUID();

    const sync = apiRoutes.find((r) => r.method === "GET" && r.pattern === "/sync")!;
    const { account } = await headerFor(deps, sync, {
      bearer: s.token, headers: { [ACCOUNT_HEADER]: other },
    });
    expect(account).toBe(s.accountId);
    expect(account).not.toBe(other);
  });

  /**
   * The routes the gap row names, spelled out rather than left to the sweep. The sweep already
   * covers them; naming them is what makes a future reader able to check the row against the
   * test without re-deriving which patterns carry mail.
   */
  it("the mail-bearing routes are in the table and covered", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });

    const wanted = [
      "/sync", "/sync/snapshot", "/sync/pull", "/messages/bodies", "/mailboxes", "/search",
    ];
    const missing = wanted.filter((p) => !apiRoutes.some((r) => r.pattern === p));
    expect(missing, "the gap row names these; a rename must update both").toEqual([]);

    const silent: string[] = [];
    for (const pattern of wanted) {
      for (const route of apiRoutes.filter((r) => r.pattern === pattern)) {
        const { account } = await headerFor(deps, route, { bearer: s.token });
        if (account !== s.accountId) silent.push(`${route.method} ${pattern}`);
      }
    }
    expect(silent, "a mail-bearing route that does not name its account").toEqual([]);
  });
});

/**
 * ═══ THE CREDENTIAL ROUTES ═════════════════════════════════════════════════════════════════════
 *
 * The sign-in and token routes answer for the credential they resolved, not for the session that
 * carried the request. Both halves of that are guarded here, and they are different claims:
 *
 *  · the REFUSAL — a live session for A presenting a credential for B is refused, and nothing is
 *    rotated or issued. This is the half that makes the header honest rather than merely narrower:
 *    a response that mixed the two could not be labelled truthfully at all.
 *  · the NAME — with no session at all, the response still names the account its tokens belong to.
 */
describe("the sign-in and token routes name the credential, not the session", () => {
  /** A live refresh-token row for an existing session. Returns the raw token. */
  async function seedRefresh(db: Awaited<ReturnType<typeof makeDeps>>["db"], s: {
    accountId: string; userId: string; sessionId: string;
  }): Promise<string> {
    const raw = generateToken();
    await db.insert(refreshTokens).values({
      accountId: s.accountId, userId: s.userId, sessionId: s.sessionId,
      familyId: randomUUID(), tokenHash: hashToken(raw),
      expiresAt: new Date(FIXED_NOW.getTime() + 60 * 60 * 1000),
    });
    return raw;
  }

  const post = (base: ApiDeps, path: string, init: { bearer?: string; body: string }): Promise<Response> =>
    app.handle(req("POST", path, init), { ...base, session: null, idempotency: null });

  /**
   * THE FINDING, as a test. Bearer for A, B's refresh token in the body. Before the refusal this
   * answered 200 with B's freshly minted tokens and `X-Ohmail-Account: A` — a response a client
   * comparing the header would have accepted and merged into A's mirror.
   */
  it("refuses a live session for A presenting a credential for B, and rotates nothing", async () => {
    const { db, deps } = await makeDeps();
    const a = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const b = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const bToken = await seedRefresh(db, b);

    const refused = await post(deps, "/auth/refresh", {
      bearer: a.token, body: JSON.stringify({ refreshToken: bToken }),
    });
    expect(refused.status, "a session for one account and a credential for another").toBe(409);
    expect((await refused.json() as { error?: { code?: string } }).error?.code).toBe("session_conflict");
    // It named nobody: the request established nothing for either account.
    expect(refused.headers.get(ACCOUNT_HEADER)).toBeNull();

    // NOTHING ROTATED — B's token is untouched and still spends, which is the half a refusal
    // placed after the consuming UPDATE would have failed while still answering 409.
    const after = await post(deps, "/auth/refresh", { body: JSON.stringify({ refreshToken: bToken }) });
    expect(after.status, "B's token must survive A's refused attempt").toBe(200);
    expect(after.headers.get(ACCOUNT_HEADER)).toBe(b.accountId);
  });

  /**
   * The sessionless case, which is the ordinary one: a browser whose access token has expired has
   * no session for `withSession` to resolve, so before this change the response named nobody at
   * all — on the one route whose whole job is to hand back a session.
   */
  it("a sessionless refresh names the account the token belongs to", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const raw = await seedRefresh(db, s);

    const res = await post(deps, "/auth/refresh", { body: JSON.stringify({ refreshToken: raw }) });
    expect(res.status).toBe(200);
    expect(res.headers.get(ACCOUNT_HEADER)).toBe(s.accountId);
  });

  /**
   * The same session presenting its OWN credential is the legitimate shape and must be untouched —
   * without this, welding the refusal shut would pass the case above.
   */
  it("a session presenting its own account's credential is admitted", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const raw = await seedRefresh(db, s);

    const res = await post(deps, "/auth/refresh", { bearer: s.token, body: JSON.stringify({ refreshToken: raw }) });
    expect(res.status, "same account on both sides — nothing ambiguous").toBe(200);
    expect(res.headers.get(ACCOUNT_HEADER)).toBe(s.accountId);
  });

  /**
   * A response that established nothing names nobody, even when a session is ambient. Before the
   * flag this took the header from `deps.session` and labelled a refused sign-in with the account
   * of whoever happened to be signed in in that browser.
   */
  it("a refused sign-in under an ambient session names nobody", async () => {
    const { db, deps } = await makeDeps();
    const a = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });

    const res = await post(deps, "/auth/login", {
      bearer: a.token,
      body: JSON.stringify({ email: "nobody@lichtgrat.example", password: "wrong-password-entirely" }),
    });
    expect(res.status).not.toBe(200);
    expect(
      res.headers.get(ACCOUNT_HEADER),
      "nothing was established, so there is no account this response belongs to",
    ).toBeNull();
  });

  /**
   * ═══ DERIVED, NOT ENUMERATED ═══════════════════════════════════════════════════════════════
   *
   * The predecessor of this test asserted a list of five route patterns that I had written down.
   * It passed, and it was wrong: five MORE routes mint a session from a body credential — both
   * 2FA verifies, the recovery code, the paired-device redeem and the invite registration — and
   * every one of them answered a successful sign-in while naming the ambient session or nobody.
   * **The census codified the omission instead of detecting it**, which is the exact defect class
   * `router.ts` warns about one flag along: a set chosen by whoever was thinking about it that
   * afternoon.
   *
   * So the expected set is COMPUTED from the handlers themselves. `Function.prototype.toString()`
   * gives each route's real closure source, and a route that reaches any session-minting seam is
   * a credential route by construction. Add a route that calls `webSession(...)` and this goes red
   * until it carries the flag; delete a seam and it goes red for naming one that no longer mints.
   *
   * **The seams are the property, and they are named rather than pattern-matched.** A list of
   * FUNCTIONS THAT MINT is a fact about the code that changes when the code does; a list of route
   * patterns is a fact about what somebody remembered.
   *
   * Why the runtime still reads an explicit flag rather than deriving it the same way: a wrong
   * answer here fails LOUDLY, in a test, and a wrong answer in `handle` would fail silently on a
   * sign-in response. Derivation belongs where it is checked, not where it is served.
   */
  it("every session-minting route carries the flag, and only those", () => {
    /** Route-level seams that mint or rotate a session from a credential in the request. */
    const MINTING_SEAMS = [
      "webSession(",           // the full-session route helper (2FA verifies, recovery)
      "enrollmentSession(",    // the enrollment-session route helper (login/verify/register)
      "enrollmentResult(",     // the factor-enrolment helper — exchanges into a FULL session
      "sessionMinter(",        // the paired-device redeem's minter
      ".refresh(",             // POST /auth/refresh
      ".token(",               // POST /oauth/token
      ".claimDesktopLink(",    // POST /auth/desktop-claim
      ".claimDesktopApproval(", // POST /auth/desktop-approval/claim
    ];

    const mints = (r: Route): string[] => {
      const src = r.handler.toString();
      return MINTING_SEAMS.filter((s) => src.includes(s));
    };

    // AND THE SUBJECT ONLY MOVES ON A PUBLIC ROUTE. `enrollmentResult(` was missing from the seams
    // above, and adding it brought in `/auth/2fa/totp/activate` and
    // `/auth/2fa/webauthn/register/verify` — both of which DO mint a full session. Neither should
    // carry the flag, and the reason is not that they were forgotten:
    //
    // they are PROTECTED (`enrollmentOk`, never `public`), so the credential proving them is bound
    // to the session already on the request. The ambient session IS the subject there, and it
    // cannot disagree with the mint. Worse, flagging them would make the NON-minting branch — a
    // factor enrolled with no new session — name nobody, when that response plainly belongs to the
    // session that asked.
    //
    // So the property is "mints from a body credential AND is public", and the public half is what
    // makes an ambient session capable of disagreeing with the credential in the first place. That
    // is the whole reason this flag exists.
    const derived = apiRoutes.filter((r) => mints(r).length > 0 && r.options?.public === true)
      .map((r) => `${r.method} ${r.pattern}`).sort();

    // Named so the exclusion is visible rather than implied: these mint and are deliberately out.
    const protectedMinters = apiRoutes.filter((r) => mints(r).length > 0 && r.options?.public !== true)
      .map((r) => `${r.method} ${r.pattern}`).sort();
    expect(protectedMinters).toEqual([
      "POST /auth/2fa/totp/activate",
      "POST /auth/2fa/webauthn/register/verify",
    ]);
    const flagged = apiRoutes.filter((r) => r.options?.credentialSubject)
      .map((r) => `${r.method} ${r.pattern}`).sort();

    // Anti-vacuity, both ways: a `toString` that stopped returning source, or a seam list that
    // matched nothing, would make this pass on an empty set.
    expect(derived.length, "no route appears to mint a session — the derivation is broken").toBeGreaterThan(5);

    expect(
      flagged,
      "a route whose handler reaches a session-minting seam must carry `credentialSubject`, and " +
        "a route that carries it must reach one. This set is DERIVED from the handlers; if it " +
        "disagrees with the flags, the flags are the thing to change.",
    ).toEqual(derived);

    // Every seam must still be reachable — a renamed helper would silently shrink the derived set
    // and this census would agree with the flags while covering less.
    for (const seam of MINTING_SEAMS) {
      expect(
        apiRoutes.some((r) => r.handler.toString().includes(seam)),
        `no route reaches "${seam}" any more — remove it or fix the name, do not leave it decorative`,
      ).toBe(true);
    }
  });
});

/**
 * The 2FA verifies, the recovery code and the paired redeem all mint a full session from a
 * credential in the BODY. Round two found every one of them unflagged: a sessionless successful
 * sign-in returned a session and named nobody, so a client enforcing the header would have had to
 * reject a correct sign-in.
 */
describe("a session minted from a body credential is named", () => {
  const PW = "pw-correct-horse";

  /** Register, enrol TOTP, and return what a fresh login needs. */
  async function readyToSignIn(deps: ApiDeps, db: Parameters<typeof seedSessionFor>[0], clock: TestClock, email: string) {
    const reg = await app.handle(
      req("POST", "/auth/register", { body: JSON.stringify({ email, password: PW, displayName: "G", inviteCode: "INVITE-OK" }) }),
      { ...deps, session: null, idempotency: null },
    );
    expect(reg.status).toBe(201);
    const { user } = await reg.json() as { user: { userId: string; accountId: string } };

    const { token } = await seedSessionFor(db, { accountId: user.accountId, userId: user.userId, now: clock.now(), lastTwofaAt: clock.now() });
    const cookie = `tf_session=${token}; tf_csrf=${csrfTokenFor(token)}`;
    const headers = { "x-csrf-token": csrfTokenFor(token) };
    const enroll = await app.handle(req("POST", "/auth/2fa/totp/enroll", { cookie, headers }), { ...deps, session: null, idempotency: null });
    const { secret } = await enroll.json() as { secret: string };
    const activated = await app.handle(
      req("POST", "/auth/2fa/totp/activate", { cookie, headers, body: JSON.stringify({ code: totpNow(secret, clock.now()) }) }),
      { ...deps, session: null, idempotency: null },
    );
    expect(activated.status, "the factor must actually enrol").toBe(200);
    // PAST THE ACTIVATED STEP. A TOTP code is single-use within its window, and activation just
    // spent this one — presenting it again at `verify` is refused as a replay, which arrives as a
    // plain 401 and looks exactly like a wrong secret.
    clock.advance(60_000);
    return { accountId: user.accountId, secret };
  }

  const loginToken = async (deps: ApiDeps, email: string): Promise<string> => {
    const res = await app.handle(
      req("POST", "/auth/login", { body: JSON.stringify({ email, password: PW }) }),
      { ...deps, session: null, idempotency: null },
    );
    expect(res.status).toBe(200);
    return (await res.json() as { loginToken: string }).loginToken;
  };

  /**
   * The whole point, end to end: nobody is signed in, a correct second factor is presented, a full
   * session comes back — and the response says whose.
   */
  it("a sessionless TOTP sign-in names the account it signed in", async () => {
    const { db, deps, clock } = await makeDeps();
    const { accountId, secret } = await readyToSignIn(deps, db, clock, "gil@x.example");

    const lt = await loginToken(deps, "gil@x.example");
    const verified = await app.handle(
      req("POST", "/auth/2fa/totp/verify", { body: JSON.stringify({ loginToken: lt, code: totpNow(secret, clock.now()) }) }),
      { ...deps, session: null, idempotency: null },
    );
    expect(verified.status, "the ceremony must succeed for this to mean anything").toBe(200);
    expect(verified.headers.get(ACCOUNT_HEADER)).toBe(accountId);
  });

  /**
   * THE ONE-USE CREDENTIAL MUST SURVIVE A REFUSAL. Round two found the conflict check running
   * inside `establish`, which is AFTER `consumeLoginToken` — so a cross-account attempt answered
   * 409 correctly and burned the login token on its way out, and clearing the session and trying
   * again could never succeed. The retry below is the assertion that matters.
   */
  it("a cross-account second factor is refused and burns nothing", async () => {
    const { db, deps, clock } = await makeDeps();
    const b = await readyToSignIn(deps, db, clock, "b@x.example");
    const a = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });

    const lt = await loginToken(deps, "b@x.example");
    const code = totpNow(b.secret, clock.now());

    const refused = await app.handle(
      req("POST", "/auth/2fa/totp/verify", { bearer: a.token, body: JSON.stringify({ loginToken: lt, code }) }),
      { ...deps, session: null, idempotency: null },
    );
    expect(refused.status, "a session for A completing B's second factor").toBe(409);
    expect((await refused.json() as { error?: { code?: string } }).error?.code).toBe("session_conflict");
    expect(refused.headers.get(ACCOUNT_HEADER)).toBeNull();

    // NOTHING BURNED: the same login token and a fresh code now succeed with no ambient session.
    clock.advance(60_000);
    const retried = await app.handle(
      req("POST", "/auth/2fa/totp/verify", { body: JSON.stringify({ loginToken: lt, code: totpNow(b.secret, clock.now()) }) }),
      { ...deps, session: null, idempotency: null },
    );
    expect(retried.status, "signing out and retrying must work — the credential was not spent").toBe(200);
    expect(retried.headers.get(ACCOUNT_HEADER)).toBe(b.accountId);
  });
});

/**
 * ═══ THE REFUSAL MUST NOT SUPPRESS THE THEFT SWEEP ════════════════════════════════════════════
 *
 * The cross-account pre-check looked the presented token up by HASH ALONE. A refresh token that
 * had already been consumed therefore matched, answered 409, and returned — before the
 * classification below it, whose entire job is to read a re-presented spent token as theft and
 * revoke the family.
 *
 * So anyone holding a stolen, already-spent token of B's could keep B's theft detection from ever
 * firing, indefinitely, by also holding a session for an account of their own. The narrowing read
 * as protective (A cannot revoke B's sessions) and its real effect was the opposite: it took from
 * B the one mechanism that protects them.
 *
 * The pre-check now carries the same liveness predicates as the consuming UPDATE, so it refuses
 * only what would otherwise have been rotated. A spent token falls through to the sweep — which is
 * exactly what it does with no session at all, so a cross-account caller gains nothing a
 * sessionless one lacks.
 */
describe("a spent token still reaches the theft sweep", () => {
  const familyOf = async (db: Awaited<ReturnType<typeof makeDeps>>["db"], s: {
    accountId: string; userId: string; sessionId: string;
  }): Promise<{ live: string; spent: string; familyId: string }> => {
    const familyId = randomUUID();
    const mk = async (): Promise<string> => {
      const raw = generateToken();
      await db.insert(refreshTokens).values({
        accountId: s.accountId, userId: s.userId, sessionId: s.sessionId, familyId,
        tokenHash: hashToken(raw), expiresAt: new Date(FIXED_NOW.getTime() + 3600_000),
      });
      return raw;
    };
    return { live: await mk(), spent: await mk(), familyId };
  };

  const post = (base: ApiDeps, path: string, init: { bearer?: string; body: string }): Promise<Response> =>
    app.handle(req("POST", path, init), { ...base, session: null, idempotency: null });

  it("a CONSUMED token presented cross-account revokes the family instead of answering 409", async () => {
    const { db, deps } = await makeDeps();
    const a = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const b = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const { live, spent } = await familyOf(db, b);

    // Spend it once, legitimately and sessionlessly.
    expect((await post(deps, "/auth/refresh", { body: JSON.stringify({ refreshToken: spent }) })).status).toBe(200);

    // Now re-present the SPENT one while holding A's session. This is theft wearing a second
    // account, and it must be read as theft.
    const res = await post(deps, "/auth/refresh", { bearer: a.token, body: JSON.stringify({ refreshToken: spent }) });
    expect(res.status, "a spent token is evidence, not a conflict").not.toBe(409);

    // THE ASSERTION THAT MATTERS: B's family is revoked, so the sibling no longer spends.
    const after = await post(deps, "/auth/refresh", { body: JSON.stringify({ refreshToken: live }) });
    expect(after.status, "the sweep must have revoked B's family — otherwise it was suppressed").toBe(401);
  });

  /**
   * THE POSITIVE CONTROL for the same rule: a LIVE token of B's presented under A is still the
   * conflict the refusal is for, and it still costs B nothing. Without this, making the pre-check
   * match nothing at all would pass the case above.
   */
  it("a LIVE token presented cross-account is still refused, and still burns nothing", async () => {
    const { db, deps } = await makeDeps();
    const a = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const b = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const { live } = await familyOf(db, b);

    const refused = await post(deps, "/auth/refresh", { bearer: a.token, body: JSON.stringify({ refreshToken: live }) });
    expect(refused.status).toBe(409);

    const retried = await post(deps, "/auth/refresh", { body: JSON.stringify({ refreshToken: live }) });
    expect(retried.status, "the live token survived the refusal").toBe(200);
    expect(retried.headers.get(ACCOUNT_HEADER)).toBe(b.accountId);
  });
});

/**
 * THE ARMS THAT ANSWER A SPENT TOKEN AGAIN — replay, grace, recovery — mint too, so they ask the
 * same question: A's session presenting B's spent token there was handed B's pair (the cookie arms
 * wrote it into A's jar). Refused 409, and the refusal rolls the arm back: B's line is as it was.
 */
describe("no re-answer arm mints across accounts", () => {
  const post = (base: ApiDeps, init: { bearer?: string; cookie?: string; body: string }): Promise<Response> =>
    app.handle(req("POST", "/auth/refresh", init), { ...base, session: null, idempotency: null });
  const refused = async (res: Response): Promise<void> => {
    expect(res.status, "a session for A was answered with B's spent token").toBe(409);
    expect((await res.json() as { error?: { code?: string } }).error?.code).toBe("session_conflict");
    expect(res.headers.get(ACCOUNT_HEADER)).toBeNull();
    expect(res.headers.getSetCookie()).toEqual([]);
  };
  async function twoAccounts(db: Awaited<ReturnType<typeof makeDeps>>["db"]) {
    const a = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const b = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const token = generateToken();
    await db.insert(refreshTokens).values({
      accountId: b.accountId, userId: b.userId, sessionId: b.sessionId, familyId: randomUUID(),
      tokenHash: hashToken(token), expiresAt: new Date(FIXED_NOW.getTime() + 3600_000), createdAt: FIXED_NOW,
    });
    return { a, b, token };
  }

  it("replay: A's presentation under B's attempt is refused; B's own retry still replays", async () => {
    const { db, deps } = await makeDeps();
    const { a, b, token } = await twoAccounts(db);
    const body = JSON.stringify({ refreshToken: token, attemptId: "n1" });
    expect((await post(deps, { body })).status).toBe(200);
    await refused(await post(deps, { bearer: a.token, body }));
    const retry = await post(deps, { body });
    expect(retry.status, "the refusal moved B's line").toBe(200);
    expect(retry.headers.get(ACCOUNT_HEADER)).toBe(b.accountId);
  });

  it("grace: refused inside the window, and B's successor still renews", async () => {
    const { db, deps, clock } = await makeDeps();
    const { a, token } = await twoAccounts(db);
    const first = await post(deps, { cookie: `tf_refresh=${token}`, body: "{}" });
    expect(first.status).toBe(204);
    clock.advance(5_000);
    await refused(await post(deps, { bearer: a.token, cookie: `tf_refresh=${token}`, body: "{}" }));
    const successor = await post(deps, { cookie: `tf_refresh=${setCookieMap(first).tf_refresh}`, body: "{}" });
    expect(successor.status, "the refusal killed B's successor").toBe(204);
  });

  it("recovery: refused past the window; B's own late presentation is still recovered", async () => {
    const { db, deps, clock } = await makeDeps();
    const { a, b, token } = await twoAccounts(db);
    expect((await post(deps, { cookie: `tf_refresh=${token}`, body: "{}" })).status).toBe(204);
    clock.advance(16 * 60_000);
    await refused(await post(deps, { bearer: a.token, cookie: `tf_refresh=${token}`, body: "{}" }));
    expect((await post(deps, { cookie: `tf_refresh=${token}`, body: "{}" })).status).toBe(204);
    const trail = await db.select({ event: authEvents.event }).from(authEvents).where(eq(authEvents.userId, b.userId));
    expect(trail.map((e) => e.event)).toContain("refresh_recovered");
  });
});

/**
 * The enrollment mint is a second door to a session and needed the same refusal. A live session for
 * A submitting B's correct password to `/auth/login` reached the zero-factor arm — which mints
 * through `establishEnrollment`, not `establish` — and walked out with B's enrollment session.
 */
describe("the enrollment mint refuses a cross-account credential", () => {
  const PW = "pw-correct-horse";
  const post = (base: ApiDeps, path: string, init: { bearer?: string; body: string }): Promise<Response> =>
    app.handle(req("POST", path, init), { ...base, session: null, idempotency: null });

  const registerB = async (deps: ApiDeps, email: string): Promise<void> => {
    const res = await post(deps, "/auth/register", {
      body: JSON.stringify({ email, password: PW, displayName: "B", inviteCode: "INVITE-OK" }),
    });
    expect(res.status, "B must exist with NO enrolled factor for this to reach the mint").toBe(201);
  };

  it("A's session may not mint B's enrollment session", async () => {
    const { db, deps } = await makeDeps();
    await registerB(deps, "b@x.example");
    const a = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });

    const res = await post(deps, "/auth/login", {
      bearer: a.token, body: JSON.stringify({ email: "b@x.example", password: PW }),
    });
    expect(res.status, "a live session for A minting B's enrollment session").toBe(409);
    expect((await res.json() as { error?: { code?: string } }).error?.code).toBe("session_conflict");
    expect(res.headers.get(ACCOUNT_HEADER)).toBeNull();
  });

  /** THE POSITIVE CONTROL: the ordinary sessionless re-entry still mints, and names B. */
  it("the same login with no session mints and names B", async () => {
    const { deps } = await makeDeps();
    await registerB(deps, "b@x.example");

    const res = await post(deps, "/auth/login", { body: JSON.stringify({ email: "b@x.example", password: PW }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string; user?: { accountId: string } };
    expect(body.status, "the zero-factor re-entry arm").toBe("enrollment");
    expect(res.headers.get(ACCOUNT_HEADER)).toBe(body.user!.accountId);
  });
});

/**
 * ═══ THE HEADER IS A NEGOTIATED CAPABILITY ════════════════════════════════════════════════════
 *
 * The absence rule — a missing `X-Ohmail-Account` on an authenticated read is a refusal — is
 * correct against a server that sends the header and catastrophic against one that does not. An
 * operator's older self-hosted install has never heard of it, so a client applying the rule
 * unconditionally would refuse every authenticated read from that server and call it a security
 * event.
 *
 * So the client requires the header only from a server that ADVERTISES it, and `GET /hello` — the
 * endpoint that already exists to say what a server is, before any credential — carries the
 * advertisement in the `features` block it already has. An older server simply does not carry the
 * key, which is what makes absence the right signal rather than a second endpoint.
 *
 * These two cases are one claim in two halves, and the second is the one that matters: it is not
 * enough to advertise, the advertisement has to be TRUE of every response the census says carries
 * the header. A server that says `accountHeader: true` and then omits it somewhere has told the
 * client to refuse a response it should have accepted.
 */
describe("the account header is advertised, and the advertisement is true", () => {
  /** A composition descriptor: `/hello` answers 503 without one, by design. */
  const HELLO = {
    flavor: "managed" as const,
    needsSetup: false,
    auth: { password: true, totp: true, webauthn: true, publicSignup: false },
    features: { sse: false, staging: true, ai: true, pairing: false, remoteImages: true },
  };

  const helloOf = async (base: ApiDeps): Promise<{ features: Record<string, unknown> }> => {
    const res = await app.handle(req("GET", "/hello"), { ...base, session: null, idempotency: null, hello: HELLO });
    expect(res.status, "/hello must answer for this to mean anything").toBe(200);
    return await res.json() as { features: Record<string, unknown> };
  };

  it("`/hello` advertises the capability", async () => {
    const { deps } = await makeDeps();
    const body = await helloOf(deps);
    expect(
      body.features.accountHeader,
      "a client cannot know to require the header unless the server says it sends it",
    ).toBe(true);
  });

  /**
   * THE HALF THAT MATTERS. The advertisement is checked against the census's own answer, so the
   * two cannot drift: whatever set of routes this file says carries the header, a server that
   * advertises the capability must actually send it on all of them.
   */
  it("a server that advertises it sends it on every route the census says carries it", async () => {
    const { db, deps } = await makeDeps();
    const body = await helloOf(deps);
    expect(body.features.accountHeader).toBe(true);

    // THE DOMAIN OF THIS SWEEP, stated so the assertion below does not read wider than it is: the
    // session-subject routes. The credential-subject routes are deliberately excluded here and are
    // covered end-to-end above — the TOTP sign-in, the sessionless refresh, the pairing redeem —
    // because driving them from this loop with a nonsense body establishes nothing, and a route
    // that establishes nothing correctly names nobody. Excluding them without saying so would have
    // made this look like a sweep over everything the capability promises.
    const routes = apiRoutes.filter((r) => !r.options?.anonymous && !r.options?.credentialSubject);
    expect(routes.length, "an empty sweep passes vacuously").toBeGreaterThan(100);

    const silent: string[] = [];
    for (const route of routes) {
      const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
      const { status, account } = await headerFor(deps, route, { bearer: s.token });
      if (account !== s.accountId) silent.push(`${route.method} ${route.pattern} → ${status}`);
    }
    expect(
      silent,
      "this server advertises `accountHeader: true`, so a client will REFUSE any authenticated " +
        "response without the header. Every one of these session-subject routes would be refused.",
    ).toEqual([]);
  });
});

/**
 * `/pair/redeem` mints a full bearer session from a token in the body, and it was the one door
 * where the cross-account refusal could not fire at all: the route was `anonymous`, that pipeline
 * omits `withSession`, and `refuseCrossAccountCredential` compares against the session's account.
 * So a browser holding a live session for A could redeem a pairing token belonging to B, spend it,
 * and be handed B's full bearer pair — while every other door answered 409 for the same shape.
 */
describe("the pairing redeem refuses a cross-account token", () => {
  const post = (base: ApiDeps, path: string, init: { bearer?: string; body: string }): Promise<Response> =>
    app.handle(req(path === "/pair" ? "POST" : "POST", path, init), { ...base, session: null, idempotency: null });

  /** Mint a device-pair token as its owner; the mint needs a fresh second factor. */
  const mintFor = async (base: ApiDeps, s: { token: string }): Promise<string> => {
    const res = await post(base, "/pair", { bearer: s.token, body: JSON.stringify({ grant: "device-pair", label: "Kitchen iPad" }) });
    expect(res.status, "the mint must succeed for this to mean anything").toBe(200);
    return (await res.json() as { token: string }).token;
  };

  it("A's session may not redeem B's pairing token, and the token survives", async () => {
    const { db, deps } = await makeDeps();
    const a = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const b = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const token = await mintFor(deps, b);

    const refused = await post(deps, "/pair/redeem", {
      bearer: a.token, body: JSON.stringify({ grant: "device-pair", token }),
    });
    expect(refused.status, "a session for A redeeming B's pairing token").toBe(409);
    expect((await refused.json() as { error?: { code?: string } }).error?.code).toBe("session_conflict");
    expect(refused.headers.get(ACCOUNT_HEADER)).toBeNull();

    // NOT SPENT. The refusal precedes the burn, so the device it was minted for can still pair.
    const retried = await post(deps, "/pair/redeem", { body: JSON.stringify({ grant: "device-pair", token }) });
    expect(retried.status, "the pairing token must survive a refused cross-account redeem").toBe(200);
    expect(retried.headers.get(ACCOUNT_HEADER)).toBe(b.accountId);
  });

  /** THE POSITIVE CONTROL: the ordinary anonymous redeem — a phone with no session — still works. */
  it("a sessionless redeem still pairs and names the token's account", async () => {
    const { db, deps } = await makeDeps();
    const b = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const token = await mintFor(deps, b);

    const res = await post(deps, "/pair/redeem", { body: JSON.stringify({ grant: "device-pair", token }) });
    expect(res.status, "the paired device has no session — this is the normal path").toBe(200);
    expect(res.headers.get(ACCOUNT_HEADER)).toBe(b.accountId);
  });
});
