import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp, apiRoutes, ERASED_ANSWER_HEADER, type ApiDeps } from "@trafficflow/api";
import { totpNow, type AuthConfig, type OAuthTokens } from "@trafficflow/services";
import { clearSessionCookies, enrollmentCookies, sessionCookies } from "../src/cookies.js";
import { makeDeps, req, setCookieMap } from "./helpers.js";

/**
 * `Secure` is a property of the cookie, not of the front door that delivered it.
 *
 * The self-host stack has a second door that serves plain HTTP behind a terminator owning the
 * certificate — the topology in which a server normally starts deriving cookie flags from
 * `X-Forwarded-Proto`, and the one where that is worst: in front of a terminator the header is
 * whatever the caller typed.
 *
 * `boot-smoke.mjs` already asserts `Secure` off real Set-Cookie lines, but it boots ONE door and
 * this one cannot be booted in a unit suite. So the claim is proved at the mint, as two
 * independent conditions: every line of every mint carries `Secure` (with the line count
 * asserted, so an empty mint cannot pass vacuously), and no mint can see a request at all. The
 * last describe asks the doors themselves, with a request that says it arrived over plain HTTP.
 */

const CFG = {
  accessTtlMs: 15 * 60_000,
  refreshTtlMs: 30 * 86_400_000,
  loginTokenTtlMs: 5 * 60_000,
} as unknown as AuthConfig;

const TOKENS = {
  accessToken: "access-abc",
  refreshToken: "refresh-def",
  tokenType: "Bearer",
  expiresIn: 900,
} as OAuthTokens;

const ACCOUNT = "11111111-1111-4111-8111-111111111111";

/** Every mint in the module, with the argument shapes production calls them with. */
const MINTS: ReadonlyArray<{ name: string; lines: string[]; expect: number }> = [
  { name: "sessionCookies, owner named", lines: sessionCookies(TOKENS, "csrf-1", CFG, ACCOUNT), expect: 5 },
  /* `owner: null` is a real production path (an enrollment-less sign-in that cannot name an
     owner), and it returns a SHORTER set — so it is measured separately rather than assumed to
     be the same lines. */
  { name: "sessionCookies, owner absent", lines: sessionCookies(TOKENS, "csrf-1", CFG, null), expect: 4 },
  /* Two set and two expired: the jar's earlier refresh cookie and resume marker go with it. */
  { name: "enrollmentCookies", lines: enrollmentCookies("enroll-ghi", "csrf-2", CFG), expect: 4 },
  /* The CLEAR is in scope and it is not pedantry: a browser only replaces a cookie when the
     replacement matches on the attributes that scope it, so a clear that dropped `Secure` would
     leave the live cookie in the jar on the one door where it matters. */
  { name: "clearSessionCookies", lines: clearSessionCookies(), expect: 5 },
];

describe("condition 1 — every cookie the API mints is Secure, on every path", () => {
  for (const mint of MINTS) {
    it(`${mint.name}: all ${mint.expect} lines carry Secure`, () => {
      /* THE POSITIVE CONTROL, and it is why the count is here. A mint that returned an empty
         array would satisfy "every line is Secure" perfectly, and a suite of nothing but
         refusals cannot tell that apart from a mint that works. */
      expect(mint.lines, `${mint.name} minted nothing — the assertion below would be vacuous`)
        .toHaveLength(mint.expect);
      for (const line of mint.lines) {
        const name = line.split("=")[0];
        expect(/;\s*Secure(;|\s|$)/.test(line), `${name} from ${mint.name} is not Secure`).toBe(true);
      }
    });
  }

  it("and none of them is host-widened, which is the other half of the same posture", () => {
    for (const mint of MINTS) {
      for (const line of mint.lines) {
        expect(/Domain=/i.test(line), `${line.split("=")[0]} carries a Domain=`).toBe(false);
      }
    }
  });
});

describe("condition 2 — the mint cannot see the request, so no door can talk it out of Secure", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/cookies.ts", import.meta.url)), "utf8");

  /* Comment text is stripped before the source is questioned. Every sentence above and in
     `cookies.ts` itself discusses `X-Forwarded-Proto` at length, so a census that read the file
     raw would fail on its own explanation — the class of guard that fires on innocent content,
     which is the same defect as one that cannot fire. Block and line comments both. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  it("no forwarded header is read anywhere in the cookie module", () => {
    const hits = code
      .split("\n")
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /forwarded|x-forwarded|proto\b/i.test(l));
    expect(hits.map(([n, l]) => `${n}: ${l.trim()}`), "a cookie flag derived from a header").toEqual([]);
  });

  it("no minting function takes a Request, a Headers or a URL", () => {
    /* By TYPE rather than by parameter name: a parameter called `ctx` or `r` is the same hazard,
       and a rename would walk past a name-matching census. */
    const hits = code
      .split("\n")
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /:\s*(Request|Headers|URL)\b/.test(l));
    expect(hits.map(([n, l]) => `${n}: ${l.trim()}`), "the mint has been handed the request").toEqual([]);
  });

  it("Secure is a literal in every cookie template in the module", () => {
    /* The templates are the `name=...; attrs` string literals. Each one that names a cookie must
       spell Secure inline — not compose it, not interpolate it. Counted, so a template deleted
       from the module cannot make this pass by leaving nothing to check. */
    const templates = code.match(/`(?:tf_|\$\{(?:RESUME_COOKIE|OWNER_COOKIE)\})[^`]*`/g) ?? [];
    expect(templates.length, "no cookie templates found — the census has lost its subject")
      .toBeGreaterThanOrEqual(9);
    for (const t of templates) {
      expect(/;\s*Secure(;|\s|`|$)/.test(t), `a cookie template without a literal Secure: ${t}`).toBe(true);
    }
  });
});

describe("condition 2 at the doors — a request that says it arrived over plain HTTP still gets Secure", () => {
  const app = createApp(apiRoutes);
  const PW = "pw-correct-horse";
  const EMAIL = "tls@x.example";
  /* The spellings of "this came over http" that proxy layers commonly read. In front of the terminator
     each is whatever the caller typed, so every request below carries all of them, over an http:// URL. */
  const PLAIN_HTTP: Record<string, string> = {
    "x-forwarded-proto": "http",
    "x-forwarded-protocol": "http",
    "x-forwarded-scheme": "http",
    "x-forwarded-ssl": "off",
    "front-end-https": "off",
    "x-url-scheme": "http",
    forwarded: "proto=http",
  };
  const H = (
    deps: ApiDeps, method: string, path: string,
    init: { cookie?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<Response> =>
    app.handle(req(method, path, { ...init, headers: { ...PLAIN_HTTP, ...init.headers } }), { ...deps, session: null, idempotency: null });

  /** Every line the door set carries Secure; the count keeps a door that set nothing from passing. Names only, never values. */
  function allSecure(res: Response, door: string, lines: number): Record<string, string> {
    const set = res.headers.getSetCookie();
    expect(set.map((l) => l.split("=")[0]), `${door}: the cookies it set`).toHaveLength(lines);
    for (const line of set) {
      expect(/;\s*Secure(;|\s|$)/.test(line), `${line.split("=")[0]} from ${door} is not Secure`).toBe(true);
    }
    return setCookieMap(res);
  }

  it("register, the re-entry, the first factor's exchange, renewals, sign-ins, sign-outs and the erase", async () => {
    const { deps, clock } = await makeDeps();
    const login = async (): Promise<string> => {
      const res = await H(deps, "POST", "/auth/login", { body: JSON.stringify({ email: EMAIL, password: PW }) });
      expect(res.status).toBe(200);
      return (await res.json()).loginToken;
    };

    const reg = await H(deps, "POST", "/auth/register", {
      body: JSON.stringify({ email: EMAIL, password: PW, displayName: "T", inviteCode: "INVITE-OK" }),
    });
    expect(reg.status).toBe(201);
    allSecure(reg, "POST /auth/register", 4);

    // No factor yet: the password alone re-enters enrollment.
    const reentry = await H(deps, "POST", "/auth/login", { body: JSON.stringify({ email: EMAIL, password: PW }) });
    expect(reentry.status).toBe(200);
    expect((await reentry.clone().json()).status).toBe("enrollment");
    const enrolling = allSecure(reentry, "POST /auth/login (enrollment)", 4);

    const enrollJar = { cookie: `tf_session=${enrolling.tf_session}; tf_csrf=${enrolling.tf_csrf}`, headers: { "x-csrf-token": enrolling.tf_csrf! } };
    const enroll = await H(deps, "POST", "/auth/2fa/totp/enroll", enrollJar);
    expect(enroll.status).toBe(200);
    const { secret } = await enroll.json();
    const activate = await H(deps, "POST", "/auth/2fa/totp/activate", {
      ...enrollJar, body: JSON.stringify({ code: totpNow(secret, clock.now()) }),
    });
    expect(activate.status).toBe(200);
    const full = allSecure(activate, "POST /auth/2fa/totp/activate (the exchange)", 5);

    const fullJar = { cookie: `tf_session=${full.tf_session}; tf_csrf=${full.tf_csrf}`, headers: { "x-csrf-token": full.tf_csrf! } };
    const codes = await H(deps, "POST", "/auth/2fa/recovery-codes", fullJar);
    expect(codes.status).toBe(200);
    const [code] = (await codes.json()).codes as string[];

    const renewed = await H(deps, "POST", "/auth/refresh", { cookie: `tf_refresh=${full.tf_refresh}` });
    expect(renewed.status).toBe(204);
    const renewal = allSecure(renewed, "POST /auth/refresh", 4);

    const markerOnly = await H(deps, "POST", "/auth/refresh", { cookie: `tf_resume=${renewal.tf_resume}` });
    expect(markerOnly.status).toBe(401);
    allSecure(markerOnly, "POST /auth/refresh (the marker alone)", 1);

    const refused = await H(deps, "POST", "/auth/refresh", { cookie: "tf_refresh=never-minted" });
    expect(refused.status).toBe(401);
    allSecure(refused, "POST /auth/refresh (refused)", 5);

    const signOut = await H(deps, "POST", "/auth/refresh/logout", { cookie: `tf_refresh=${renewal.tf_refresh}` });
    expect(signOut.status).toBe(204);
    allSecure(signOut, "POST /auth/refresh/logout", 5);

    clock.advance(30_000); // past the step the activation spent
    const viaTotp = await H(deps, "POST", "/auth/2fa/totp/verify", {
      body: JSON.stringify({ loginToken: await login(), code: totpNow(secret, clock.now()) }),
    });
    expect(viaTotp.status).toBe(200);
    const signedIn = allSecure(viaTotp, "POST /auth/2fa/totp/verify", 5);

    const out = await H(deps, "POST", "/auth/logout", {
      cookie: `tf_session=${signedIn.tf_session}; tf_csrf=${signedIn.tf_csrf}`, headers: { "x-csrf-token": signedIn.tf_csrf! },
    });
    expect(out.status).toBe(204);
    allSecure(out, "POST /auth/logout", 5);

    const viaCode = await H(deps, "POST", "/auth/2fa/recovery-codes/verify", {
      body: JSON.stringify({ loginToken: await login(), code }),
    });
    expect(viaCode.status).toBe(200);
    const last = allSecure(viaCode, "POST /auth/2fa/recovery-codes/verify", 5);

    const unknown = await H(deps, "POST", "/auth/refresh/logout", { cookie: "tf_refresh=never-minted" });
    expect(unknown.status).toBe(401);
    allSecure(unknown, "POST /auth/refresh/logout (refused)", 5);

    const erase = await H(deps, "DELETE", "/account", {
      cookie: `tf_session=${last.tf_session}; tf_csrf=${last.tf_csrf}`, headers: { "x-csrf-token": last.tf_csrf! },
    });
    expect(erase.status).toBe(200);
    allSecure(erase, "DELETE /account", 5);

    const erased = await H(deps, "POST", "/auth/refresh", {
      cookie: `tf_refresh=${last.tf_refresh}`, headers: { [ERASED_ANSWER_HEADER]: "account_erased" },
    });
    expect(erased.status).toBe(410);
    allSecure(erased, "POST /auth/refresh (an erased account)", 5);
  });
});
