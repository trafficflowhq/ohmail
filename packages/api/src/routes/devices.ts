import { serviceContext } from "../context.js";
import type { Route } from "../router.js";
import { json, noContent } from "./shared.js";
// The LIFECYCLE accessor, not `shared-cloud.ts#auth` (Phase 3): all three routes here are
// session MACHINERY — the device list, its revoke, the audit read — which `SessionLifecycle`
// carries whole, so probing the bag for the ceremony would 500 the desktop-host door, whose
// `services.auth` is deliberately the bare lifecycle. The hosted `AuthService` extends it, so
// nothing hosted changes shape through this accessor.
import { sessionLifecycle } from "./session-lifecycle.js";

/** §2.7 — sessions, devices & audit. */
export const deviceRoutes: Route[] = [
  {
    method: "GET",
    pattern: "/devices",
    cost: "read",
    handler: async (req, deps) =>
      json(await sessionLifecycle(deps).listDevices(serviceContext(deps, req)), 200),
  },
  {
    method: "DELETE",
    pattern: "/devices/:id",
    // `ceremony` for the reason `DELETE /account` is: revoking a credential is part of the
    // identity lifecycle, it costs nothing, and it can only reduce risk. A verification gate in
    // front of a revocation would keep a compromised session alive.
    cost: "ceremony",
    options: { stepUp: true },
    handler: async (req, deps, params) => {
      await sessionLifecycle(deps).revokeDevice(serviceContext(deps, req), params.id!);
      return noContent();
    },
  },
  {
    method: "GET",
    pattern: "/auth/audit",
    cost: "read",
    handler: async (req, deps) => {
      const p = new URL(req.url).searchParams;
      const limitRaw = p.get("limit");
      const limit = limitRaw != null && limitRaw !== "" ? Number(limitRaw) : undefined;
      const opts: { cursor?: string; limit?: number } = {
        ...(p.get("cursor") ? { cursor: p.get("cursor")! } : {}),
        ...(limit != null && Number.isFinite(limit) ? { limit } : {}),
      };
      return json(await sessionLifecycle(deps).listAudit(serviceContext(deps, req), opts), 200);
    },
  },
];

/**
 * The BULK web-session take-back — "sign out all other web sessions", one verb over the whole
 * device-less remainder (`revokeWebSessions`: device_id IS NULL, scope 'full', never the
 * caller's own session or family, never a named device).
 *
 * A SEPARATE array from {@link deviceRoutes}, and the separation is load-bearing:
 * `routes/desktop-host.ts` spreads `deviceRoutes` whole, and on that door the device-less
 * non-current session IS the host's LAUNCH session — a remote viewer holding this verb could
 * kill the very engine serving it. So this array is spread into `authRoutes` only (the hosted
 * and self-host tables), and `desktop-host.test.ts` censuses its absence from that door.
 *
 * `stepUp: true` for `logout {allDevices}`'s exact reason: mass sign-out is device revocation
 * in effect. `ceremony` because it is identity lifecycle that can only reduce risk.
 */
export const webSessionRevokeRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/devices/revoke-web-sessions",
    cost: "ceremony",
    options: { stepUp: true },
    handler: async (req, deps) =>
      json(await sessionLifecycle(deps).revokeWebSessions(serviceContext(deps, req)), 200),
  },
];
