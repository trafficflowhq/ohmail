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
// The send's direct-upload transport. This composition is in the hosted deployment's exact
// position — a browser on one machine, the SMTP dial on the server, a request body between
// them — and it owns its object storage, so it mints upload grants against its own bucket.
import { attachmentStagingRoutes } from "./attachment-staging.js";
// `DELETE /account` — erasure as a route, because on a multi-user server "delete the data
// directory" is not an answer any one user can be given.
import { accountRoutes } from "./account.js";
// Onboarding consent: the seed review, the dormancy dial, reset.
import { consentRoutes } from "./consent.js";
// `GET/PATCH /account/ai` — the account-level AI off switch. Meaningful here: the operator
// supplies the model key, and each user still decides whether their own mail reaches it.
import { aiSettingsRoutes } from "./ai-settings.js";
// The two AI-proposal reads. This composition runs the same organizer that generates them.
import { proposalsRoutes } from "./proposals.js";
// The alert driver. Both routes are shared-secret guarded and answer 404 on a host that
// injects no `deps.alerts`, which is every install until its operator arms one.
import { internalRoutes } from "./internal.js";
// The pairing ceremony — mint/list/revoke (session + step-up) and the anonymous redeem. This
// table is its ONLY mount; see `pair.ts` for why the hosted and local tables must not carry it.
import { pairRoutes } from "./pair.js";

/**
 * THE SELF-HOST ROUTE TABLE — what a standalone, operator-run server serves.
 *
 * A SEPARATE ARRAY rather than a filter over the hosted table, for the reason `routes/local.ts`
 * states: a filter would still `import` every route module to build the list it then discards,
 * so the artifact would carry the billing handler, the payment webhook and the cross-account
 * admin reads whether or not anything could route to them. Only a distinct import list actually
 * leaves them out of the module graph.
 *
 * ── WHAT IS ABSENT, AND WHY EACH ONE ──────────────────────────────────────────────────────
 *
 *  · `billing`, `waitlist` — there is nothing to buy and no funnel to join on a server you run
 *    yourself. Not refused: not built.
 *  · every `admin` group — the reads, the staff sign-in, the writes, the provider registration.
 *    Deliberate, and not an economy: account isolation on this server is absolute. The operator
 *    owns the disk and can read anything with `psql`, but the API never crosses accounts — an
 *    endpoint that projects every account is exactly the surface a multi-user family server must
 *    not have, and "the operator is trusted" is not a reason to build it. Operator observability
 *    is `/health` (liveness, schema, key identity) and `/internal/alerts` (shared-secret,
 *    content-free), both mounted here.
 *
 * ── WHAT IS PRESENT, OVER THE SINGLE-USER TABLE ───────────────────────────────────────────
 *
 * The whole of `localRoutes` (the mail product plus `/health` and `/hello`), and on top of it
 * everything a multi-user server with real sign-in needs: the full auth surface including the
 * device list, Microsoft 365 onboarding, attachment staging (this deployment owns object
 * storage), account erasure, consent, the per-account AI switch, the AI-proposal reads, the
 * alert driver, and the pairing ceremony (`/pair*` — its ONLY mount; see `pair.ts` for why the
 * hosted and local tables must not carry it). `GET /hello` answers `flavor: "selfhost"` from
 * the descriptor this server's composition root injects, and computes `needsSetup` from whether
 * any user exists yet.
 *
 * ── THE OBLIGATIONS THIS TABLE PUTS ON ITS COMPOSITION ROOT (apps/server) ─────────────────
 *
 *  1. **An explicit unmetered mailbox allowance.** The auth and erasure modules here import the
 *     full `@trafficflow/services` barrel, and loading that barrel registers the PAID mailbox
 *     allowance as the process-wide default (`packages/services/src/index.ts` — loading it is
 *     what makes a process a hosted one). A server mounting this table therefore MUST construct
 *     its mailbox service with an explicit unmetered `allowance:` argument, or `POST /mailboxes`
 *     refuses every mailbox with a subscription error on a server that has no subscriptions.
 *     The absence rule above is about ROUTE surfaces — nothing can route to billing here — and
 *     this note is the other half: a registry default is not a route, and only the composition
 *     root can override it.
 *
 *  2. **`deps.hello.features.pairing: true`.** The pairing routes are mounted, so the
 *     descriptor this server injects must announce them — a descriptor still saying `false`
 *     makes a client's server picker hide a ceremony that answers, which is the inverse of the
 *     honest-404 contract `/hello` exists to keep. The managed and local descriptors keep
 *     `pairing: false`, truthfully: their tables do not carry these routes.
 *
 *  3. **The first-account ceremony is a BOOT MINT into the pairing service, not open signup.**
 *     At boot with zero users, the composition root calls
 *     `mintPairingToken(bootCtx, { grant: "invite", label: "first-run setup" })` (with
 *     `bootCtx.userId === null` — the one legitimate ownerless mint) and prints the raw token
 *     ONCE to stdout; `/hello` reports `needsSetup: true` until the setup page redeems it and
 *     registers. No `TF_INVITE_CODES` bootstrap in this composition, ever.
 */
export const selfHostRoutes: Route[] = [
  ...localRoutes,
  ...authRoutes,
  ...mailboxOAuthRoutes,
  ...attachmentStagingRoutes,
  ...accountRoutes,
  ...consentRoutes,
  ...aiSettingsRoutes,
  ...proposalsRoutes,
  ...internalRoutes,
  // Pairing tokens (`POST /pair`, `GET /pair`, `DELETE /pair/:id`, `POST /pair/redeem`) — HERE
  // and only here, replacing the typed empty seam that held this position while the module was
  // unbuilt. The hello census flipped to the positive assertion in the same edit.
  ...pairRoutes,
];
