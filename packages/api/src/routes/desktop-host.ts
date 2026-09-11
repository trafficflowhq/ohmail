import type { Route } from "../router.js";
// The entire single-user product surface, health and `/hello` included. Imported as the ARRAY
// rather than re-listed module by module, so a route added to the mail product set joins this
// table in the same edit — a re-listed copy would silently miss it. `routes/local.ts` imports
// only mail-half modules, so this brings none of what the header below promises to leave out.
import { localRoutes } from "./local.js";
// The session lifecycle pair — `/auth/refresh` + `/auth/logout` — carved out of the ceremony
// module precisely so this table could mount rotation and sign-out WITHOUT registration,
// passwords, factors or the desktop-link mint entering the graph. See that module's header.
import { sessionLifecycleRoutes } from "./session-lifecycle.js";
// The device list, its revoke, and the audit read — the surface that makes a pairing visible
// and takable-back, which is what makes offering one safe at all.
import { deviceRoutes } from "./devices.js";
// The anonymous redeem ALONE — never `pairRoutes`, whose mint/list/revoke belong to the
// standalone server (and, on a desktop, to the window's own door). See `pair.ts`.
import { pairRedeemRoutes } from "./pair.js";

/**
 * The desktop-host route table — what a desktop install serves to its owner's other devices: a
 * paired phone is a viewer of the one engine, with a bearer pair from the device-pair redeem. A
 * separate array, not a filter — a filter still imports every route module into the shipped
 * artifact. Absent: the sign-in ceremony, the pairing mint/list/revoke (a remote device must not
 * mint the credential that admits remote devices), everything server-only. Present: `localRoutes`
 * plus the redeem, refresh/logout (`allDevices` step-up-gated), device list/revoke/audit.
 * Obligations: `allowCookieAuth: false` (the zero-Set-Cookie census sweeps the table),
 * `services.auth` with no `inviteRedeem`, `hello.features.pairing: true`.
 */
export const desktopHostRoutes: Route[] = [
  ...localRoutes,
  ...sessionLifecycleRoutes,
  ...deviceRoutes,
  ...pairRedeemRoutes,
];
