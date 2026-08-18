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
