import type { Route } from "../router.js";
// SIDE-EFFECT IMPORT, exactly as `routes/index.ts` carries it: it registers the both-halves
// schema census that `GET /health` probes with. A standalone server runs BOTH migration journals
// against its own Postgres — it has real sign-in, so it has the identity tables — and a health
// probe that checked the mail half alone would certify a half-migrated database as healthy.
import "./health-cloud.js";
// The entire single-user product surface, health and `/hello` included. Imported as the ARRAY
// rather than re-listed module by module, so a route added to the mail product set joins this
// table in the same edit — a re-listed copy would silently miss it. `routes/local.ts` imports
// only mail-half modules, so this brings none of what the header below promises to leave out.
import { localRoutes } from "./local.js";
// The auth surface, whole — registration, password login, WebAuthn, TOTP, recovery, OAuth
// tokens, and the device list (`GET /devices` / `DELETE /devices/:id`). One import; see
// `auth.ts` for why it lives in its own module.
import { authRoutes } from "./auth.js";
// Exchange Online / Microsoft 365 onboarding (start / bounce / complete / availability). The
// callback's shape is dictated by the `SameSite=Strict` session cookie; see `mailbox-oauth.ts`.
import { mailboxOAuthRoutes } from "./mailbox-oauth.js";
// The DEVICE-CODE door (RFC 8628) — start + poll. HERE AND NOWHERE ELSE, because this is the only
// composition whose operator can be told to register a public client of their own and because the
// hosted deployment already has a redirect URI registered. The hosted table not importing this
// module is what keeps both handlers out of its artifact; see the header's absence rule.
import { mailboxDeviceOAuthRoutes } from "./mailbox-oauth-device.js";
// The send's direct-upload transport. This composition is in the hosted deployment's exact
// position — a browser on one machine, the SMTP dial on the server, a request body between
// them — and it owns its object storage, so it mints upload grants against its own bucket.
import { attachmentStagingRoutes } from "./attachment-staging.js";
// `DELETE /account` — erasure as a route, because on a multi-user server "delete the data
// directory" is not an answer any one user can be given.
import { accountRoutes } from "./account.js";
// `GET/PATCH /account/ai` — the account-level AI off switch. Meaningful here: the operator
// supplies the model key, and each user still decides whether their own mail reaches it.
import { aiSettingsRoutes } from "./ai-settings.js";
// The two AI-proposal reads. This composition runs the same organizer that generates them.
import { proposalsRoutes } from "./proposals.js";
// The alert driver. Both routes are shared-secret guarded and answer 404 on a host that
// injects no `deps.alerts`, which is every install until its operator arms one.
import { internalRoutes } from "./internal.js";
// The pairing ceremony — mint/list/revoke (session + step-up) and the anonymous redeem. The
// hosted table mounts the same array since the managed device-pairing slice (device-pair only
// in effect there — its bag wires no invite bridge); this table alone keeps BOTH grants,
// because `apps/server` wires `inviteRedeem`. See `pair.ts` for the whole mount map.
import { pairRoutes } from "./pair.js";

/**
 * The self-host route table — a standalone, operator-run server; a separate array (a filter keeps
 * every module in the graph). Absent: `billing`/`waitlist`; every `admin` group — account
 * isolation here is absolute, and "the operator is trusted" is not a reason to build the surface
 * a family server must not have. Present: `localRoutes` plus the full auth surface, Microsoft 365
 * onboarding, staging, erasure, consent, the AI switch, the proposal reads, the alert driver, the
 * pairing ceremony. Obligations: an explicit unmetered mailbox `allowance:`;
 * `hello.features.pairing: true`; the first account is a boot mint printed once to stdout — no
 * `TF_INVITE_CODES` ever; `requireVerifiedForProduct: false`, said out loud.
 */
export const selfHostRoutes: Route[] = [
  ...localRoutes,
  ...authRoutes,
  ...mailboxOAuthRoutes,
  /*
   * The device-code door, mounted ONLY here. Both routes are `cost: "work"` — they end in a stored
   * credential and a full sync — and both answer 503 until this server's composition root supplies
   * `deps.msDevice`, which it does from `MS_DEVICE_CLIENT_ID`. `GET …/availability` (above) reports
   * the same predicate as `device`, so the settings pane never offers a door that would refuse.
   */
  ...mailboxDeviceOAuthRoutes,
  ...attachmentStagingRoutes,
  ...accountRoutes,
  /**
   * `consentRoutes` used to be spread here, and since mail 0083 that was a double mount:
   * `localRoutes` gained the consent group when the screening window was extended to the
   * standalone door, and this table spreads `localRoutes` whole. The router matches the first, so
   * nothing behaved differently; what it broke is every census that counts this table, and the
   * hello census caught it exactly as built. Removed rather than made conditional: the self-host
   * door serves consent because it serves `localRoutes`, and stating that once keeps the groups
   * disjoint. A future table wanting consent without the local group spreads it explicitly, and
   * the census will say so.
   */
  ...aiSettingsRoutes,
  ...proposalsRoutes,
  ...internalRoutes,
  // Pairing tokens (`POST /pair`, `GET /pair`, `DELETE /pair/:id`, `POST /pair/redeem`) — HERE
  // and only here, replacing the typed empty seam that held this position while the module was
  // unbuilt. The hello census flipped to the positive assertion in the same edit.
  ...pairRoutes,
];
