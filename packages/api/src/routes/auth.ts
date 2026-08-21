import type { Route } from "../router.js";
import { coreRoutes } from "./core.js";
import { webauthnRoutes } from "./webauthn.js";
import { totpRoutes } from "./totp.js";
import { recoveryRoutes } from "./recovery.js";
import { oauthRoutes } from "./oauth.js";
import { deviceRoutes, webSessionRevokeRoutes } from "./devices.js";
import { stepUpRoutes } from "./step-up.js";

/**
 * The auth/2FA/OAuth endpoints (contract §2), each wired to an AuthService
 * method. Route `options` drive the middleware pipeline: `public` (no session),
 * `stepUp` (recent-2FA gate), `raw` (no envelope/CSRF/idempotency). The count lives in
 * `spend-gate.test.ts`'s table census, not here — a literal in this comment drifted once.
 *
 * ITS OWN MODULE, deliberately, and the reason is which tables can mount it. This composition
 * used to live in `routes/index.ts`, whose module graph carries every route there is — billing,
 * the waitlist, the cross-account admin reads. A route table that wants real sign-in and
 * NONE of those (see `routes/self-host.ts`) could then only choose between importing the whole
 * graph and re-listing these six groups, and a re-listed copy silently misses the seventh group
 * the day one is added. Here, "the auth surface, whole" is one import with no hosted baggage;
 * `routes/index.ts` re-exports it unchanged, so its own consumers see exactly what they did.
 *
 * NOTE (rate limit): there is deliberately no throttle middleware here. AuthService's
 * built-in per-key lockout enforces credential rate-limiting; `serviceContext`
 * threads the client `ip`/`userAgent` it keys on. A per-IP *network* rate-limit
 * is deliberately left to the deployment's edge or proxy.
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
