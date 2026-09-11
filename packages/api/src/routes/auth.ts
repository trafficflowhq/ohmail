import type { Route } from "../router.js";
import { coreRoutes } from "./core.js";
import { webauthnRoutes } from "./webauthn.js";
import { totpRoutes } from "./totp.js";
import { recoveryRoutes } from "./recovery.js";
import { oauthRoutes } from "./oauth.js";
import { deviceRoutes, webSessionRevokeRoutes } from "./devices.js";
import { stepUpRoutes } from "./step-up.js";

/**
 * The auth/2FA/OAuth endpoints, each wired to an AuthService method. Route `options` drive the
 * pipeline: `public`, `stepUp`, `raw`; the count lives in `spend-gate.test.ts`'s census — a
 * literal here drifted once. Its own module because of which tables can mount it: a table that
 * wants real sign-in and none of the hosted surfaces (`routes/self-host.ts`) must not import the
 * whole graph or re-list six groups, where a copy silently misses the seventh. No throttle
 * middleware: AuthService's per-key lockout limits credentials (`serviceContext` threads
 * `ip`/`userAgent`); a per-IP network limit belongs to the deployment's edge.
 */
export const authRoutes: Route[] = [
  ...coreRoutes,
  ...webauthnRoutes,
  ...totpRoutes,
  ...recoveryRoutes,
  ...oauthRoutes,
  ...deviceRoutes,
  // The step-up RE-verification ceremony and the bulk web-session take-back. Both belong to
  // the sign-in surface (`shared-cloud.ts#auth` / the lifecycle) and NEITHER may reach the
  // desktop-host door: the ceremony would 500 on its bare `SessionLifecycle` bag, and the bulk
  // verb's device-less sweep would include that door's own launch session. They ride
  // `authRoutes` — a table the desktop-host composition never imports — and
  // `desktop-host.test.ts` censuses the absence.
  ...stepUpRoutes,
  ...webSessionRevokeRoutes,
];
