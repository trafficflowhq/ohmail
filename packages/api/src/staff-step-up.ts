import { STAFF_STEP_UP_WINDOW_SECONDS } from "@trafficflow/services";
import { resolveStaffSession, staffTokenOf } from "./routes/admin-staff.js";
import { presentsSecret, secretRouteJson } from "./secret-auth.js";
import type { Middleware } from "./middleware.js";

/**
 * THE STAFF WRITE STEP-UP — CARRIED BY THE ROUTES IT GUARDS.
 *
 * The console's Actions page has always said that "a staff session without a recent step-up gets
 * 403 before any of it runs", and nothing enforced it: the staff writes are `anonymous` routes,
 * so `withStepUp` — which judges a CUSTOMER session — never ran on them. One control and not
 * two: the window is {@link STAFF_STEP_UP_WINDOW_SECONDS}, the API puts it on the wire, and the
 * console's prompt mirrors that value rather than deciding anything.
 */
/**
 * NOT A PIPELINE MEMBER. This judges a managed-service credential and reaches the staff route
 * module and the cloud schema; `app.ts` is compiled into the standalone desktop door, so a
 * membership there put `staff_users` into the published engine bundle and the census refused it.
 * The write routes carry it in `options.middleware` instead, so it is mounted exactly where they
 * are — in the managed composition, and nowhere a local door can reach.
 */
/**
 * It only ever ADDS one refusal. An unarmed host still answers 404, a caller with no shared
 * secret still hears 401, and one with the secret but no live staff session still hears 401
 * `staff_session_required` — the mutation-watched property of the write handlers. So it passes
 * through in all three and refuses only what it can positively establish: a live staff session
 * whose last second factor is older than the window. The body is read from a CLONE, because the
 * session token rides in the body here and the handler reads the original stream after it.
 */
export const withStaffStepUp: Middleware = (next, route) => async (req, deps, params) => {
  const cfg = deps.admin;
  if (!cfg || cfg.secret.trim().length === 0) return next(req, deps, params);
  if (!presentsSecret(req, cfg.secret)) return next(req, deps, params);

  let body: Record<string, unknown>;
  try {
    body = (await req.clone().json()) as Record<string, unknown>;
  } catch {
    return next(req, deps, params);
  }

  const now = deps.now();
  const staff = await resolveStaffSession(deps.db, staffTokenOf(body), now);
  if (!staff) return next(req, deps, params);
  if (now.getTime() - staff.lastTwofaAt.getTime() <= STAFF_STEP_UP_WINDOW_SECONDS * 1000) {
    return next(req, deps, params);
  }

  (deps.logger ?? undefined)?.warn("admin_write_step_up_required", { route: route.pattern });
  // `no-store` and the admin surface's own envelope: these routes are `raw`, so nothing above
  // this shapes a response, and the console reads `error.code` exactly as it does for the other
  // refusals. The window travels with it so the prompt can say how long the code buys.
  return secretRouteJson(403, {
    error: { code: "step_up_required" },
    stepUpWindowSeconds: STAFF_STEP_UP_WINDOW_SECONDS,
  });
};
