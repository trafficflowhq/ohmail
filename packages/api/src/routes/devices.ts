import { serviceContext } from "../context.js";
import type { Route } from "../router.js";
import { json, noContent, readBody } from "./shared.js";
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
    relay: true,
    cost: "read",
    handler: async (req, deps) =>
      json(await sessionLifecycle(deps).listDevices(serviceContext(deps, req)), 200),
  },
  {
    method: "DELETE",
    pattern: "/devices/:id",
    relay: true,
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
    relay: true,
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
 * The bulk web-session take-back — "sign out all other web sessions", one verb over the
 * device-less remainder (`revokeWebSessions`: device_id IS NULL, scope 'full', never the caller's
 * own session or a named device). A separate array from {@link deviceRoutes}, and the separation
 * is load-bearing: `desktop-host.ts` spreads `deviceRoutes` whole, and on that door the
 * device-less non-current session IS the host's launch session — a remote viewer holding this
 * verb could kill the engine serving it. Spread into `authRoutes` only; `desktop-host.test.ts`
 * censuses its absence. `stepUp: true`: mass sign-out is device revocation in effect.
 */
export const webSessionRevokeRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/devices/revoke-web-sessions",
    relay: true,
    cost: "ceremony",
    options: { stepUp: true },
    handler: async (req, deps) => {
      const raw = (await readBody<{ olderThanDays?: unknown }>(req)).olderThanDays;
      // PRESENCE is the only thing decided here; the VALUE is the verb's to refuse. The cast is
      // what carries an arbitrary wire value to `assertWebSessionAge`, which is typed for the
      // caller it is protecting and shape-checks at runtime for this one — so a string, a
      // fraction, a `null` or an out-of-range integer all leave as one 400.
      const opts = raw === undefined ? {} : { olderThanDays: raw as number };
      return json(await sessionLifecycle(deps).revokeWebSessions(serviceContext(deps, req), opts), 200);
    },
  },
];
