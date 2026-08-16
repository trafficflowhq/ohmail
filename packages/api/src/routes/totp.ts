import { serviceContext } from "../context.js";
import type { Route } from "../router.js";
import { clientKind, json, noContent, readBody } from "./shared.js";
import { auth, enrollmentResult, webSession } from "./shared-cloud.js";

/**
 * §2.4 — TOTP (fallback 2FA).
 *
 * `enroll` + `activate` are `enrollmentOk` — the TOTP arm of the enrollment
 * surface — and `activate` is where an enrollment session is EXCHANGED for a full one
 * when TOTP is the first factor. Both are also step-up-gated FOR FULL SESSIONS inside
 * `AuthService` (adding a factor must be no easier than removing one); the flag cannot
 * express that, because an enrollment session must pass and can never satisfy step-up.
 *
 * `DELETE /auth/2fa/totp` is NOT `enrollmentOk`. Factor REMOVAL is not part of the
 * "2FA-enrollment + session + logout" surface the scope gate exists to open, and it
 * carried the flag only because it shares a path prefix. It was unreachable in practice
 * (double-gated by `withStepUp` and `AuthService.requireStepUp`), but that made a
 * DESTRUCTIVE route's safety rest entirely on the step-up gate rather than on the scope
 * gate built for exactly this — one relaxed step-up away from reachable.
 */
export const totpRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/auth/2fa/totp/enroll",
    cost: "ceremony",
    options: { enrollmentOk: true },
    handler: async (req, deps) => json(await auth(deps).totpEnroll(serviceContext(deps, req)), 200),
  },
  {
    method: "POST",
    pattern: "/auth/2fa/totp/activate",
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
    cost: "ceremony",
    options: { public: true },
    handler: async (req, deps) => {
      const body = await readBody<{ loginToken: string; code: string }>(req);
      return webSession(deps, await auth(deps).totpVerify(serviceContext(deps, req), body));
    },
  },
  {
    method: "DELETE",
    pattern: "/auth/2fa/totp",
    cost: "ceremony",
    options: { stepUp: true },
    handler: async (req, deps) => {
      await auth(deps).totpRemove(serviceContext(deps, req));
      return noContent();
    },
  },
];
