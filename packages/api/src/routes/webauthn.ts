import { serviceContext } from "../context.js";
import type { Route } from "../router.js";
import { clientKind, json, readBody } from "./shared.js";
import { auth, enrollmentResult, webSession } from "./shared-cloud.js";

/**
 * §2.3 — WebAuthn / passkeys (primary 2FA).
 *
 * The two REGISTRATION legs are `enrollmentOk`: they are the enrollment
 * surface an enrollment-scoped session exists to reach. `register/verify` is where
 * the first factor lands, so it is also where that session is EXCHANGED for a full
 * one — `enrollmentResult` moves the new tokens into cookies (web) or leaves them in
 * the body (bearer).
 *
 * They carry no `stepUp` flag because an enrollment session must pass and can never
 * satisfy step-up; the conditional rule ("enrollment scope may enroll its first
 * factor; a FULL session needs a recent 2FA") is enforced in
 * `AuthService.requireEnrollmentOrStepUp`, which reads the scope from the session row.
 */
export const webauthnRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/auth/2fa/webauthn/register/options",
    cost: "ceremony",
    options: { enrollmentOk: true },
    handler: async (req, deps) => json(await auth(deps).webauthnRegisterOptions(serviceContext(deps, req)), 200),
  },
  {
    method: "POST",
    pattern: "/auth/2fa/webauthn/register/verify",
    cost: "ceremony",
    options: { enrollmentOk: true },
    handler: async (req, deps) => {
      const body = await readBody<{ credential: unknown; label: string }>(req);
      const result = await auth(deps).webauthnRegisterVerify(
        serviceContext(deps, req), body, { client: clientKind(deps) },
      );
      return enrollmentResult(deps, result);
    },
  },
  {
    method: "POST",
    pattern: "/auth/2fa/webauthn/assert/options",
    cost: "ceremony",
    options: { public: true },
    handler: async (req, deps) => {
      const body = await readBody<{ loginToken: string }>(req);
      return json(await auth(deps).webauthnAssertOptions(serviceContext(deps, req), body), 200);
    },
  },
  {
    // Public step-two: verifies the assertion and establishes the web session.
    method: "POST",
    pattern: "/auth/2fa/webauthn/assert/verify",
    cost: "ceremony",
    options: { public: true },
    handler: async (req, deps) => {
      const body = await readBody<{ loginToken: string; credential: unknown }>(req);
      return webSession(deps, await auth(deps).webauthnAssertVerify(serviceContext(deps, req), body));
    },
  },
];
