import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { apiRoutes, type Route } from "@trafficflow/api";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * EVERY SESSION-HELD DOOR THAT GRANTS A CREDENTIAL CARRIES `stepUp: true`.
 *
 * `step-up-pipeline-census.test.ts` proves a declared flag is enforced; this proves the flag is
 * DECLARED where it must be. The grant methods are derived from the auth service's own source (a
 * body that mints a session, writes a credential row, or stamps an approval), each route's calls
 * from its handler. A route reaching one is admitted by `stepUp: true`, by the frozen public list
 * below (the body's credential is the authority), or by the service asserting the step-up itself.
 */

const root = fileURLToPath(new URL("../../../", import.meta.url));
const SERVICE_FILES = [
  "packages/services/src/auth/auth-service.ts",
  "packages/services/src/auth/session-lifecycle.ts",
];

/** What makes a method body a grant. `approvedAt:` is the desktop approval's confirm. */
const GRANT = new RegExp([
  String.raw`this\.establish(?:Enrollment|PairedDevice)?\(`,
  String.raw`\.insert\((?:loginTokens|oauthAuthCodes|webauthnCredentials|totpSecrets|recoveryCodes)\)`,
  String.raw`approvedAt:`,
].join("|"));

/** Method bodies by name, split at the class's two-space member indent. */
function methodBodies(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of SERVICE_FILES) {
    const src = withoutComments(readFileSync(`${root}${f}`, "utf8"));
    const re = /\n {2}(?:(?:private|protected|override|public|static) )*(?:async )?([A-Za-z_]\w*)\s*[(<]/g;
    const heads: { name: string; at: number }[] = [];
    for (let m = re.exec(src); m; m = re.exec(src)) {
      if (!["if", "for", "while", "switch", "return", "catch"].includes(m[1]!)) heads.push({ name: m[1]!, at: m.index });
    }
    heads.forEach((h, i) => out.set(h.name, src.slice(h.at, heads[i + 1]?.at ?? src.length)));
  }
  return out;
}

/** The public doors that grant, each with the credential that is its authority. Frozen. */
const PUBLIC_GRANTS: Readonly<Record<string, string>> = {
  "POST /auth/register": "the invite and the password mint an ENROLLMENT session only",
  "POST /auth/verify-email": "the mailed token plus the password",
  "POST /auth/login": "the password; the answer is a first-factor token, not a session",
  "POST /auth/desktop-claim": "the one-use code a step-up-gated browser minted",
  "POST /auth/desktop-approval": "an unbound request — nothing is granted until a stepped-up confirm",
  "POST /auth/desktop-approval/claim": "the PKCE verifier, spendable only after a stepped-up confirm",
  "POST /auth/2fa/webauthn/assert/verify": "the passkey assertion over the login token",
  "POST /auth/2fa/totp/verify": "the six digits over the login token",
  "POST /oauth/token": "the PKCE code a stepped-up confirm minted, or a refresh token",
};

/** Session-held doors whose SERVICE asserts the step-up — enrollment is how a factor first exists. */
const SERVICE_GATED: Readonly<Record<string, string>> = {
  "POST /auth/2fa/webauthn/register/verify": "webauthnRegisterVerify",
  "POST /auth/2fa/totp/enroll": "totpEnroll",
};

/**
 * THE PAIRING SERVICE'S MINTS, module-level functions: each one that writes a pairing code grants one (a QR code's
 * device pairing, an invite, a phone app's handoff). A route reaching one is step-up gated, or named here with the
 * check its service makes in its place. Frozen.
 */
const PAIRING_FILE = "packages/services/src/pairing.ts";
const PHONE_GATED: Readonly<Record<string, { grant: string; check: RegExp }>> = {
  // The handoff costs a phone's own refresh token (the route rotates it first), from a full session of a named phone
  // device; the code is bound to the sibling app's challenge.
  "POST /pair/handoff": { grant: "mintAppHandoff", check: /session\.scope !== "full"[\s\S]*MOBILE_KINDS\.has\(device\.kind\)/ },
};
function functionBodies(file: string): Map<string, string> {
  const src = withoutComments(readFileSync(`${root}${file}`, "utf8"));
  const heads = [...src.matchAll(/\nexport (?:async )?function (\w+)/g)].map((m) => ({ name: m[1]!, at: m.index! }));
  return new Map(heads.map((h, i) => [h.name, src.slice(h.at, heads[i + 1]?.at ?? src.length)]));
}

const keyOf = (r: Route): string => `${r.method} ${r.pattern}`;
const callsOf = (r: Route): string[] =>
  [...String(r.handler).matchAll(/\bauth\([^)]*\)\s*\.\s*(\w+)\s*\(/g)].map((m) => m[1]!);

describe("every door that grants a credential is step-up gated or named", () => {
  const bodies = methodBodies();
  const grants = new Set([...bodies].filter(([, body]) => GRANT.test(body)).map(([name]) => name));
  const granting = apiRoutes.filter((r) => callsOf(r).some((c) => grants.has(c)));

  it("derives a real set: the grant methods and the routes reaching them", () => {
    for (const m of ["issueDesktopLink", "confirmDesktopApproval", "approveAuthorize", "claimDesktopApproval"]) {
      expect(grants, `the derivation lost ${m}`).toContain(m);
    }
    expect(granting.map(keyOf)).toContain("POST /auth/desktop-approval/:id/confirm");
    expect(granting.length).toBeGreaterThanOrEqual(12);
  });

  it("each granting route is stepUp, a frozen public door, or service-gated — nothing else", () => {
    const ungated: string[] = [];
    for (const r of granting) {
      const k = keyOf(r);
      if (r.options?.stepUp === true) continue;
      if (r.options?.public === true && Object.hasOwn(PUBLIC_GRANTS, k)) continue;
      const method = SERVICE_GATED[k];
      if (method && /requireEnrollmentOrStepUp\(|requireStepUp\(/.test(bodies.get(method) ?? "")) continue;
      ungated.push(`${k} → ${callsOf(r).filter((c) => grants.has(c)).join(",")}`);
    }
    expect(ungated, "a door that grants a credential without a recent factor").toEqual([]);
  });

  it("every route that reaches a pairing mint is step-up gated, or named with the check its service makes", () => {
    const pairing = functionBodies(PAIRING_FILE);
    const mints = [...pairing].filter(([, body]) => /writePairingToken\(/.test(body)).map(([name]) => name);
    expect(mints).toEqual(expect.arrayContaining(["mintPairingToken", "mintAppHandoff"]));
    const reaching = apiRoutes.filter((r) => mints.some((m) => String(r.handler).includes(`${m}(`)));
    expect(reaching.map(keyOf).sort()).toEqual(["POST /pair", "POST /pair/handoff"]);
    const ungated = reaching.filter((r) => {
      if (r.options?.stepUp === true) return false;
      const named = PHONE_GATED[keyOf(r)];
      return !(named && String(r.handler).includes(`${named.grant}(`) && named.check.test(pairing.get(named.grant) ?? ""));
    }).map(keyOf);
    expect(ungated, "a door that mints a pairing code without a recent factor or its named check").toEqual([]);
  });

  it("the named lists name only routes that exist and still grant", () => {
    const live = new Set(granting.map(keyOf));
    for (const k of [...Object.keys(PUBLIC_GRANTS), ...Object.keys(SERVICE_GATED)]) {
      expect(live, `${k} is named but no longer grants`).toContain(k);
    }
  });
});
