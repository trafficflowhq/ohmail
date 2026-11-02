import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AuthConfig, OAuthTokens } from "@trafficflow/services";
import { clearSessionCookies, enrollmentCookies, sessionCookies } from "../src/cookies.js";

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
 * asserted, so an empty mint cannot pass vacuously), and no mint can see a request at all.
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
  { name: "sessionCookies, owner named", lines: sessionCookies(TOKENS, "csrf-1", CFG, ACCOUNT), expect: 10 },
  /* `owner: null` is a real production path (an enrollment-less sign-in that cannot name an
     owner), and it returns a SHORTER set — so it is measured separately rather than assumed to
     be the same lines. */
  { name: "sessionCookies, owner absent", lines: sessionCookies(TOKENS, "csrf-1", CFG, null), expect: 8 },
  /* Two set, their bare spellings expired, and the jar's earlier refresh cookie and resume marker
     expired in both spellings. Every set line is matched by its bare spelling's clear. */
  { name: "enrollmentCookies", lines: enrollmentCookies("enroll-ghi", "csrf-2", CFG), expect: 8 },
  /* The CLEAR is in scope and it is not pedantry: a browser only replaces a cookie when the
     replacement matches on the attributes that scope it, so a clear that dropped `Secure` would
     leave the live cookie in the jar on the one door where it matters. */
  { name: "clearSessionCookies", lines: clearSessionCookies(), expect: 10 },
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
    const templates = code.match(/[`"](?:\$\{HOST_PREFIX\})?(?:tf_[a-z]+|\$\{(?:RESUME_COOKIE|OWNER_COOKIE)\})=[^`"]*[`"]/g) ?? [];
    expect(templates.length, "no cookie templates found — the census has lost its subject")
      .toBeGreaterThanOrEqual(9);
    for (const t of templates) {
      expect(/;\s*Secure(;|\s|`|$)/.test(t), `a cookie template without a literal Secure: ${t}`).toBe(true);
    }
  });
});
