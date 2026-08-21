import { serviceContext } from "../context.js";
import type { Route } from "../router.js";
import { json, readBody } from "./shared.js";
import { auth } from "./shared-cloud.js";

/**
 * §2.8 — STEP-UP RE-VERIFICATION: refresh a session's 5-minute factor window IN PLACE.
 *
 * `withStepUp` answers 403 `step_up_required` the moment `last_twofa_at` is stale, and until
 * these routes existed the only remedy a client could offer was a full sign-out/sign-in round
 * trip — a dead end dressed as a ceremony, hit by anyone who opened Settings → Devices more
 * than five minutes after signing in. Each route re-runs the sign-in second factor against
 * the SESSION THE CALLER ALREADY HOLDS and re-stamps that session's `last_twofa_at`
 * (`AuthService.stepUpTotp` / `stepUpWebauthnOptions` / `stepUpWebauthnVerify`, where every
 * guard is argued: same throttle key and lockout as sign-in, same single-use TOTP-timestep and
 * challenge-claim semantics, a guarded re-stamp that refuses a revoked or enrollment-scoped
 * session in the write itself).
 *
 * Route options, each deliberate:
 *  · **NOT `public`** — the session under re-verification is the credential; an anonymous
 *    caller has nothing to re-stamp and gets `withSession`'s 401.
 *  · **NOT `enrollmentOk`** — an enrollment session is password-only and must never acquire
 *    step-up standing; `withSession` 403s it here, and the service's stamp predicate
 *    (`scope = 'full'`) refuses it a second time.
 *  · **NOT `stepUp`** — these routes are how step-up standing is EARNED; gating them on it
 *    would be the dead end again, spelled in middleware.
 *  · **`cost: "ceremony"`** — identity lifecycle: no work, no socket, no model. The spend
 *    gate's frozen censuses (`spend-gate.test.ts`) carry all three by name.
 *  · **No Set-Cookie, no tokens** — the response is `{ok: true}` (options: the challenge).
 *    Zero new cookie surface; `step-up-reverify.test.ts` censuses every response.
 *
 * Spread into `authRoutes` ONLY. The desktop-host door must never mount these: its
 * `services.auth` is the bare `SessionLifecycle` (no factors — probing the ceremony accessor
 * would 500 the door), and its sessions earn nothing here. `desktop-host.test.ts` censuses
 * the absence.
 */
export const stepUpRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/auth/step-up/totp",
    cost: "ceremony",
    handler: async (req, deps) => {
      const body = await readBody<{ code: string }>(req);
      return json(await auth(deps).stepUpTotp(serviceContext(deps, req), body), 200);
    },
  },
  {
    method: "POST",
    pattern: "/auth/step-up/webauthn/options",
    cost: "ceremony",
    handler: async (req, deps) =>
      json(await auth(deps).stepUpWebauthnOptions(serviceContext(deps, req)), 200),
  },
  {
    method: "POST",
    pattern: "/auth/step-up/webauthn/verify",
    cost: "ceremony",
    handler: async (req, deps) => {
      const body = await readBody<{ credential: unknown }>(req);
      return json(await auth(deps).stepUpWebauthnVerify(serviceContext(deps, req), body), 200);
    },
  },
];
