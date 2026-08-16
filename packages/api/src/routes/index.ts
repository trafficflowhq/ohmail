import type { Route } from "../router.js";
import { coreRoutes } from "./core.js";
import { webauthnRoutes } from "./webauthn.js";
import { totpRoutes } from "./totp.js";
import { recoveryRoutes } from "./recovery.js";
import { oauthRoutes } from "./oauth.js";
import { deviceRoutes } from "./devices.js";
import { syncRoutes } from "./sync.js";
import { eventsRoutes } from "./events.js";
import { pushRoutes } from "./push.js";
import { mailboxRoutes } from "./mailboxes.js";
import { rulesRoutes } from "./rules.js";
import { messageRoutes } from "./messages.js";
import { threadRoutes } from "./threads.js";
import { screenerRoutes } from "./screener.js";
import { approvalRoutes } from "./approvals.js";
import { triageRoutes } from "./triage.js";
import { searchRoutes } from "./search.js";
import { privacyRoutes } from "./privacy.js";
import { unsubscribeRoutes } from "./unsubscribe.js";
import { contactsRoutes } from "./contacts.js";
import { snippetsRoutes } from "./snippets.js";
import { notifyRoutes } from "./notify.js";
import { awayRoutes } from "./away.js";
import { attachmentRoutes } from "./attachments.js";
/* The hosted send's direct-upload transport. HOSTED ONLY, and not by convention: it mints a signed
 * upload grant against object storage this deployment owns, and `routes/local.ts` deliberately does
 * not name it — a standalone install has no request body between its compose form and its own SMTP
 * dial, so it has nothing to stage around and no business writing into Cloud storage. */
import { attachmentStagingRoutes } from "./attachment-staging.js";
import { kbRoutes } from "./kb.js";
import { tagsRoutes } from "./tags.js";
import { draftsRoutes } from "./drafts.js";
import { workflowsRoutes } from "./workflows.js";
import { proposalsRoutes } from "./proposals.js";
import { billingRoutes } from "./billing.js";
import { waitlistRoutes } from "./waitlist.js";
import { accountRoutes } from "./account.js";
import { aiSettingsRoutes } from "./ai-settings.js";
import { screeningRoutes } from "./screening.js";
import { consentRoutes } from "./consent.js";
import { healthRoutes } from "./health.js";
// SIDE-EFFECT IMPORT, and the side effect is the point: it registers the both-halves schema
// census that `/health` probes with. The local route table deliberately omits this line — see
// `health-census.ts` — so the Cloud table names stay out of the shipped desktop engine.
import "./health-cloud.js";
import { internalRoutes } from "./internal.js";
import { adminRoutes } from "./admin.js";
import { adminStaffRoutes } from "./admin-staff.js";
import { adminActionRoutes } from "./admin-actions.js";
/* Cloud 0009 — the Entra application registration the operator manages from the console. HOSTED
 * ONLY, and not merely by convention: it reads `oauth_provider_config`, a CLOUD table, and its
 * authority is a `staff_users` session. `routes/local.ts` deliberately does not name it. */
import { adminOAuthRoutes } from "./admin-oauth.js";
/* Cloud 0009 — Exchange Online / Microsoft 365 web onboarding: start, the redirect bounce, and complete. Three routes
 * and not two; `mailbox-oauth.ts`'s header states why the callback cannot do the work (the
 * `SameSite=Strict` session cookie is withheld on a cross-site top-level navigation). */
import { mailboxOAuthRoutes } from "./mailbox-oauth.js";

/**
 * The 20 auth/2FA/OAuth endpoints (contract §2), each wired to an AuthService
 * method. Route `options` drive the middleware pipeline: `public` (no session),
 * `stepUp` (recent-2FA gate), `raw` (no envelope/CSRF/idempotency).
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
];

/** Sync, SSE, push, mailboxes (read), rules. */
export const syncRoutesGroup: Route[] = syncRoutes;
export const eventsRoutesGroup: Route[] = eventsRoutes;
export const pushRoutesGroup: Route[] = pushRoutes;
export const mailboxRoutesGroup: Route[] = mailboxRoutes;
/**
 * Cloud 0009 — the Microsoft consent ceremony (start / bounce / complete). A SEPARATE group from
 * `mailboxRoutesGroup` because the three do not share its pipeline shape: one is a `public + raw`
 * bounce that resolves no session, and none of the three is step-up gated. See
 * `mailbox-oauth.ts`'s header.
 */
export const mailboxOAuthRoutesGroup: Route[] = mailboxOAuthRoutes;
export const rulesRoutesGroup: Route[] = rulesRoutes;

/** Messages (5) + threads (4). */
export const messageRoutesGroup: Route[] = messageRoutes;
export const threadRoutesGroup: Route[] = threadRoutes;

/** Screener (2) + Approvals (2) + Triage & views (4) — the whole Screener/Approvals/Triage surface. */
export const screenerRoutesGroup: Route[] = screenerRoutes;
export const approvalRoutesGroup: Route[] = approvalRoutes;
export const triageRoutesGroup: Route[] = triageRoutes;

/** Hybrid search (1). */
export const searchRoutesGroup: Route[] = searchRoutes;

/** Privacy: image proxy + load-remote + tracker-event feeds (4). */
export const privacyRoutesGroup: Route[] = privacyRoutes;

/** `POST /messages/:id/unsubscribe` (1): RFC 8058 one-click, server-side. */
export const unsubscribeRoutesGroup: Route[] = unsubscribeRoutes;

/** Reference & compose niceties: contacts+notes (9) · snippets (5) · notify-rules (3) · away-responder (2) = 19. */
export const contactsRoutesGroup: Route[] = contactsRoutes;
export const snippetsRoutesGroup: Route[] = snippetsRoutes;
export const notifyRoutesGroup: Route[] = notifyRoutes;
export const awayRoutesGroup: Route[] = awayRoutes;

/** Attachments & files: on-demand fetch + download-all (6). */
export const attachmentRoutesGroup: Route[] = attachmentRoutes;

/** Knowledge Base (5) + manual drafts (4). */
export const kbRoutesGroup: Route[] = kbRoutes;
export const draftsRoutesGroup: Route[] = draftsRoutes;

/** `GET /health` (1): public + raw, one round trip, KEK ring identity. */
export const healthRoutesGroup: Route[] = healthRoutes;

/**
 * The alert driver (2): `POST /internal/alerts` runs a pass and notifies;
 * `GET /internal/alerts` reads what is open without touching anything. Both are
 * shared-secret guarded and answer 404 on a host with no `deps.alerts`.
 */
export const internalRoutesGroup: Route[] = internalRoutes;

/**
 * The six admin READS (6): overview · accounts · accounts/:id · billing ·
 * worker · actions. All `public + anonymous + raw`, all shared-secret gated, all 404 on a host
 * with no `deps.admin`. There is deliberately no write route; see `admin.ts`.
 */
export const adminRoutesGroup: Route[] = adminRoutes;

/**
 * Staff IDENTITY for the console (5): `POST /admin/staff/session` · `/totp/begin` ·
 * `/totp/confirm` · `/whoami` · `/sign-out`.
 *
 * A separate group from the reads on purpose. The reads are authorised by a shared secret and
 * nothing else, and `admin.ts` §2 says so in terms that stay true only while that file holds no
 * POST. These five are the layer that turns "somebody with the secret" into a NAMED person, so
 * that an audit row can blame one; they verify against `staff_users`, which the console's own
 * content-blind role cannot read. See `admin-staff.ts`.
 */
export const adminStaffRoutesGroup: Route[] = adminStaffRoutes;

/**
 * The admin WRITES (3): `POST /admin/accounts/suspend` · `/admin/accounts/resume` ·
 * `/admin/mailboxes/resync`.
 *
 * A separate group from the reads AND from the staff sign-in, because it is the only surface
 * authorised by the shared secret PLUS a live staff session together: the secret proves the
 * proxy, the session names the actor an `audit_log` row blames. `admin-actions.ts` is the file
 * `admin.ts` §2's ceiling paragraph is amended to point at. All `unauthenticated` (ANONYMOUS_
 * PIPELINE resolves no customer session); all idempotent.
 *
 * The third (mail 0039) clears a quarantined mailbox's durable retry backoff. It is the first one
 * here that targets a MAILBOX rather than an account, and its body id is `mailboxId` for that
 * reason — the id a write validates is not interchangeable between them.
 */
export const adminActionRoutesGroup: Route[] = adminActionRoutes;

/** Workflows CRUD + run enqueue + run undo (9): GET /workflows · /workflows/proposals · POST /workflows · GET/PATCH/DELETE /workflows/:id · POST /workflows/:id/run · GET /workflow-runs · POST /workflow-runs/:id/undo. */
export const workflowsRoutesGroup: Route[] = workflowsRoutes;
/** The two AI-proposal reads. Hosted only: a local install has no proposer to read from. */
export const proposalsRoutesGroup: Route[] = proposalsRoutes;

/**
 * Billing (4): `POST /billing/checkout` · `POST /billing/portal` (step-up) ·
 * `GET /billing/subscription` · `POST /billing/webhook` (public + raw). See `billing.ts` for
 * why each carries the options it does.
 */
export const billingRoutesGroup: Route[] = billingRoutes;

/**
 * Art. 17 erasure (1): `DELETE /account`, step-up gated. Blocking precondition for
 * the "delete your account anytime" sentence the landing page now makes.
 */
export const accountRoutesGroup: Route[] = accountRoutes;
/** The managed-AI off switch (`GET/PATCH /account/ai`). */
export const aiSettingsRoutesGroup: Route[] = aiSettingsRoutes;
/** The editable Ohbox preference (`GET/PATCH /account/screening`). */
export const screeningRoutesGroup: Route[] = screeningRoutes;

/**
 * Onboarding consent (5): `GET /consent` · `GET/POST /consent/seed` ·
 * `GET/POST /consent/reset`. The sent-mail seed, the dormancy dial and putting an account
 * back to never-screened. `POST /consent/reset` is the only step-up-gated one; see
 * `consent.ts` for why it is neither operator-secret-gated nor left on a bare session.
 */
export const consentRoutesGroup: Route[] = consentRoutes;

/**
 * The funnel's one public endpoint (1): `POST /waitlist`. The landing form's
 * only server call; the invite MINT that follows it is an operator script, not a
 * route. See `waitlist.ts` for why the options are exactly `{ public: true }`.
 */
export const waitlistRoutesGroup: Route[] = waitlistRoutes;

/**
 * The full route table. `apps/web` and tests mount
 * this into `createApp`. Route `options` (public/stepUp/raw/idempotent) drive the pipeline.
 *
 * Served now: auth 20 · sync/push 4 · mailboxes 6 (read+resync + create/update/
 * delete) · messages 5 · threads 4 · rules 5 · screener 2 · approvals 2 · triage&views 4 ·
 * search 1 · privacy 4 · contacts&notes 9 · snippets 5 · notify-rules 3 · away-responder 2 ·
 * attachments&files 6 · kb 5 · drafts 4 · workflows 9,
 * plus `GET /health`, billing 4, the 3 internal alert routes, the public
 * `POST /waitlist`, and the 6 admin reads.
 *
 * **The MEASURED length of this array is 143** (141 + the two admin WRITE routes,
 * `POST /admin/accounts/{suspend,resume}`) at the time that sentence was written; it is 159 now.
 * Cloud 0009 added five: three for the Microsoft consent ceremony (`POST …/oauth/microsoft/start`,
 * `GET …/callback`, `POST …/complete`) and two for the admin registration surface
 * (`POST /admin/oauth/microsoft`, `…/save`).
 * It is stated here as a number somebody has
 * actually read, because the previous version of this sentence claimed **117** and was wrong —
 * and two binding project documents quoted **122** from it, so one stale comment became three
 * stale claims. The per-group tally above is the original DESIGN count and
 * has drifted from every one of those groups; trust `apiRoutes.length`, which the enrollment
 * sweep and the `test/spend-gate.test.ts` census both assert against directly rather than restating.
 *
 * Every entry declares `cost` ({@link CostClass}), which is a REQUIRED field: adding a
 * route without saying what it causes does not compile, and `withSpendGate` refuses an
 * undeclared one at runtime for an unverified account. The 3 mailbox mutations are additionally
 * step-up-gated and write envelope-encrypted credentials into `mailbox_credentials`.
 */
export const apiRoutes: Route[] = [
  ...healthRoutes,
  ...internalRoutes,
  ...adminRoutes,
  ...adminStaffRoutes,
  ...adminActionRoutes,
  ...adminOAuthRoutes,
  ...authRoutes,
  ...syncRoutes,
  ...eventsRoutes,
  ...pushRoutes,
  ...mailboxRoutes,
  ...mailboxOAuthRoutes,
  ...rulesRoutes,
  ...messageRoutes,
  ...threadRoutes,
  ...screenerRoutes,
  ...approvalRoutes,
  ...triageRoutes,
  ...searchRoutes,
  ...privacyRoutes,
  ...unsubscribeRoutes,
  ...contactsRoutes,
  ...snippetsRoutes,
  ...notifyRoutes,
  ...awayRoutes,
  ...attachmentRoutes,
  ...attachmentStagingRoutes,
  ...kbRoutes,
  ...tagsRoutes,
  ...draftsRoutes,
  ...workflowsRoutes,
  ...proposalsRoutes,
  ...billingRoutes,
  ...accountRoutes,
  ...aiSettingsRoutes,
  ...screeningRoutes,
  ...consentRoutes,
  ...waitlistRoutes,
];
