import { serviceContext } from "../context.js";
import type { Route } from "../router.js";
import { json, readBody } from "./shared.js";
import { auth } from "./shared-cloud.js";

/**
 * Step-up re-verification: refresh a session's factor window in place — the remedy for a stale
 * `last_twofa_at` used to be a full sign-out/sign-in. Each route re-runs the sign-in second
 * factor against the session the caller holds and re-stamps it (`stepUpTotp` /
 * `stepUpWebauthnOptions` / `stepUpWebauthnVerify`: same throttle and lockout as sign-in, same
 * single-use semantics, a guarded re-stamp refusing a revoked or enrollment-scoped session in the
 * write). Not `public` (the session is the credential); not `enrollmentOk`; not `stepUp` (these
 * are how standing is earned); `ceremony`; no Set-Cookie, no tokens. `authRoutes` only — the
 * desktop-host door must never mount these.
 */
export const stepUpRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/auth/step-up/totp",
    relay: true,
    cost: "ceremony",
    handler: async (req, deps) => {
      const body = await readBody<{ code: string }>(req);
      return json(await auth(deps).stepUpTotp(serviceContext(deps, req), body), 200);
    },
  },
  {
    method: "POST",
    pattern: "/auth/step-up/webauthn/options",
    relay: true,
    cost: "ceremony",
    handler: async (req, deps) =>
      json(await auth(deps).stepUpWebauthnOptions(serviceContext(deps, req)), 200),
  },
  {
    method: "POST",
    pattern: "/auth/step-up/webauthn/verify",
    relay: true,
    cost: "ceremony",
    handler: async (req, deps) => {
      const body = await readBody<{ credential: unknown }>(req);
      return json(await auth(deps).stepUpWebauthnVerify(serviceContext(deps, req), body), 200);
    },
  },
];
