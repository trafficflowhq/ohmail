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
 * THE DESKTOP-HOST ROUTE TABLE — what a desktop install serves to its owner's OTHER devices
 * when it is acting as their always-on host.
 *
 * A phone that paired with this machine is a VIEWER of the one engine: it reads and writes
 * through the same handler pipeline the desktop's own window uses, against the same store, with
 * a bearer pair the device-pair redeem minted. This table is that door's whole surface.
 *
 * A SEPARATE ARRAY rather than a filter over any wider table, for the reason `routes/local.ts`
 * states: a filter would still `import` every route module to build the list it then discards,
 * so the shipped artifact would carry the sign-in ceremony and the server-only surfaces whether
 * or not anything could route to them. Only a distinct import list actually leaves them out of
 * the module graph — and this table ships in a public artifact, where that difference is the
 * whole point.
 *
 * ── WHAT IS ABSENT, AND WHY EACH ONE ──────────────────────────────────────────────────────
 *
 *  · the sign-in CEREMONY — registration, password login, email verification, TOTP, WebAuthn,
 *    recovery, OAuth, the desktop-link mint. There is nobody to register: the machine's own
 *    login is the boundary, and a remote device becomes a session through the pairing redeem,
 *    never through a password typed at a phone.
 *  · the pairing MINT, LIST and REVOKE — handing out a credential that can open this engine
 *    belongs to the desktop window, over its private door. A remote device must not be able
 *    to mint the very credential that admits remote devices.
 *  · everything a SERVER has and a desktop does not — attachment staging (the compose form and
 *    the SMTP dial are one process here; there is no request body between them), account
 *    erasure (deleting the data directory IS the erasure), consent, the per-account AI switch,
 *    the proposal reads, operator alerting, admin, billing, the funnel. Not refused: not built.
 *
 * ── WHAT IS PRESENT, OVER THE SINGLE-USER TABLE ───────────────────────────────────────────
 *
 * The whole of `localRoutes` (the mail product plus `/health` and `/hello`), and on top of it
 * exactly what a REMOTE session needs and nothing more:
 *
 *  · `POST /pair/redeem` — how a device becomes a session. Device-pair grants only, in effect:
 *    the invite arm asks the dependency bag for an invite bridge this composition never wires,
 *    so it answers `validation_failed` — a refusal the redeemer can act on, not a 500 about a
 *    table this store does not have.
 *  · `POST /auth/refresh` + `POST /auth/logout` — the paired session's own lifecycle: the
 *    bearer pair rotates (with reuse detection) and signs ITSELF out. The `allDevices` arm is
 *    step-up-gated in the service — mass logout is device revocation in effect — so a paired
 *    session cannot sign the window or its sibling devices out either.
 *  · `GET /devices` / `DELETE /devices/:id` / `GET /auth/audit` — what is paired, and the
 *    take-back. The revoke keeps its step-up gate, which a just-paired session's NULL factor
 *    stamp fails closed: a credential that may have crossed a room on paper cannot sign other
 *    devices out. Revocation is the desktop window's, over its private door.
 *
 * `GET /hello` answers `flavor: "desktop-host"` from the descriptor the engine injects, so a
 * client's server picker knows this door pairs devices and runs no sign-in ceremony.
 *
 * ── THE OBLIGATIONS THIS TABLE PUTS ON ITS COMPOSITION ROOT ───────────────────────────────
 *
 *  1. **Bearer-only, structurally: `allowCookieAuth: false`.** This door NEVER mints, reads or
 *     clears a cookie — a `Set-Cookie` here would turn a token shown on a screen into a browser
 *     credential on whatever origin proxied the request. The refresh/logout handlers gate every
 *     cookie touch on `cookieSurface`, and the composition must compose the gate closed. The
 *     zero-Set-Cookie census in `desktop-host.test.ts` sweeps the whole table on exactly this.
 *  2. **`services.auth` = the session lifecycle** (the redeem's establish, the rotation, the
 *     device reads live on it) and **no `services.inviteRedeem`** — its absence is what keeps
 *     the invite arm's refusal honest.
 *  3. **`hello.features.pairing: true`** — the redeem is mounted, so the descriptor announces
 *     it; the local (window) door's descriptor answers for its own mounts separately.
 */
export const desktopHostRoutes: Route[] = [
  ...localRoutes,
  ...sessionLifecycleRoutes,
  ...deviceRoutes,
  ...pairRedeemRoutes,
];
