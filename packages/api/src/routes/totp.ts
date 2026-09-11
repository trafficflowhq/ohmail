import { serviceContext } from "../context.js";
import type { Route } from "../router.js";
import { clientKind, json, noContent, readBody } from "./shared.js";
import { auth, enrollmentResult, webSession } from "./shared-cloud.js";

/**
 * TOTP (fallback 2FA). `enroll` + `activate` are `enrollmentOk` — the TOTP arm of the enrollment
 * surface — and `activate` is where an enrollment session is exchanged for a full one when TOTP
 * is the first factor. Both are also step-up-gated for full sessions inside `AuthService` (adding
 * a factor must be no easier than removing one); the flag cannot express that, because an
 * enrollment session must pass and can never satisfy step-up. `DELETE /auth/2fa/totp` is not
 * `enrollmentOk`: factor removal is not part of the surface the scope gate exists to open, and it
 * carried the flag only because it shares a path prefix — leaving a destructive route's safety
 * resting entirely on the step-up gate, one relaxed gate away from reachable.
 */
export const totpRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/auth/2fa/totp/enroll",
    relay: true,
    cost: "ceremony",
    options: { enrollmentOk: true },
    handler: async (req, deps) => json(await auth(deps).totpEnroll(serviceContext(deps, req)), 200),
  },
  {
    method: "POST",
    pattern: "/auth/2fa/totp/activate",
    relay: true,
    cost: "ceremony",
    options: { enrollmentOk: true },
    handler: async (req, deps) => {
      const body = await readBody<{ code: string }>(req);
      const result = await auth(deps).totpActivate(serviceContext(deps, req), body, { client: clientKind(deps) });
      return enrollmentResult(deps, result);
    },
  },
  {
    // Public step-two: verifies the code and establishes the web session.
    method: "POST",
    pattern: "/auth/2fa/totp/verify",
    relay: false,  /* resolves a credential from the request body */
    cost: "ceremony",
    options: { public: true, credentialSubject: true },
    handler: async (req, deps) => {
      // `kind` is the caller's own device declaration — the desktop's cloud-door sign-in names
      // its platform here so the session gets a device row the staleness alarm can attribute.
      // Whitelist-gated in the service (desktop kinds only; none can reach the native window).
      const body = await readBody<{ loginToken: string; code: string; kind?: unknown }>(req);
      return webSession(deps, await auth(deps).totpVerify(serviceContext(deps, req), body));
    },
  },
  {
    method: "DELETE",
    pattern: "/auth/2fa/totp",
    relay: true,
    cost: "ceremony",
    options: { stepUp: true },
    handler: async (req, deps) => {
      await auth(deps).totpRemove(serviceContext(deps, req));
      return noContent();
    },
  },
];
