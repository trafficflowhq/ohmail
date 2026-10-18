import { serviceContext } from "../context.js";
import type { Route } from "../router.js";
import { json, readBody } from "./shared.js";
import { auth } from "./shared-cloud.js";

/**
 * Changing the password (`AuthService.changePassword`): the current password in the body, a
 * second factor inside the step-up window, and every other session signed out. Relayed for
 * `POST /auth/step-up/totp`'s reason: the session is the subject and the body a re-assertion.
 * `ceremony`, because rotating a password somebody else knows must not wait on a verified
 * address. No Set-Cookie: the caller's session is neither rotated nor re-stamped. `authRoutes`
 * only — the desktop-host door keeps no password to change.
 */
export const passwordRoutes: Route[] = [
  {
    method: "POST",
    pattern: "/auth/password",
    relay: true,
    cost: "ceremony",
    options: { stepUp: true },
    handler: async (req, deps) => {
      const body = await readBody<{ currentPassword?: unknown; newPassword?: unknown } | null>(req);
      return json(await auth(deps).changePassword(serviceContext(deps, req), body ?? {}), 200);
    },
  },
];
