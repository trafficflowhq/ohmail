import type { Route } from "../router.js";
/* The auth surface, whole, from its own mail-safe module — see `auth.ts` for why it moved out of
 * this file. Re-exported below so every consumer of this barrel sees exactly what it did. */
import { authRoutes } from "./auth.js";
import { syncRoutes } from "./sync.js";
import { eventsRoutes } from "./events.js";
import { pushRoutes } from "./push.js";
import { mailboxRoutes } from "./mailboxes.js";
import { rulesRoutes } from "./rules.js";
import { messageRoutes } from "./messages.js";
import { threadRoutes } from "./threads.js";
import { screenerRoutes } from "./screener.js";
import { trashRoutes } from "./trash.js";
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
/* The send's direct-upload transport, for SERVER compositions that own object storage — this
 * hosted table and the standalone server's (`routes/self-host.ts`), each minting signed upload
 * grants against its own bucket. `routes/local.ts` deliberately does not name it, and not by
 * convention: a desktop engine runs its send in the same process as its own SMTP dial, so there
 * is no request body between the compose form and the wire — nothing to stage around, and no
 * business writing somebody's attachment bytes into a server's storage. */
import { attachmentStagingRoutes } from "./attachment-staging.js";
import { kbRoutes } from "./kb.js";
import { tagsRoutes } from "./tags.js";
/* The folder VERBS (FOLDERS-SPEC.md stage 2) — create / rename / delete as recorded user
 * commands the WORKER executes. Hosted-table only in effect: the standalone local door wires no
 * `folderOps` service, and its settings surface withholds the pane (§17). */
import { foldersRoutes } from "./folders.js";
import { draftsRoutes } from "./drafts.js";
import { workflowsRoutes } from "./workflows.js";
import { proposalsRoutes } from "./proposals.js";
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
import { helloRoutes } from "./hello.js";
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
/* THE PAIRING CEREMONY — mint/list/revoke (session + step-up) and the anonymous redeem. On this
 * table it is DEVICE PAIRING and nothing else, enforced by the dependency bag rather than by a
 * variant handler: the hosted deployment wires no `services.inviteRedeem`, so both invite arms
 * refuse `validation_failed` (mint and redeem alike — see `pair.ts`'s header for why the two
 * refusals are one fact). This mount is what lights the managed card in the mobile picker: the
 * webapp's Devices pane mints a QR, the phone redeems `${origin}/pair#<token>` for a bearer
 * pair, and `apps/api-vercel` flips `hello.features.pairing` to `true` in the same change. The
 * redeem answers tokens in the BODY with zero `Set-Cookie` — a token shown on a screen must not
 * be spendable into a browser session — pinned by the census in `pair-hosted.test.ts`. */
import { pairRoutes } from "./pair.js";

export { authRoutes } from "./auth.js";

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
 * The admin writes (3): suspend, resume, and the mailbox resync release. A separate group from
 * the reads and the staff sign-in because it is the only surface authorised by the shared secret
 * plus a live staff session together: the secret proves the proxy, the session names the actor an
 * `audit_log` row blames. All `unauthenticated` (the anonymous pipeline resolves no customer
 * session); all idempotent. The third (mail 0039) clears a quarantined mailbox's durable retry
 * backoff and is the first to target a mailbox rather than an account — its body id is
 * `mailboxId` for that reason.
 */
export const adminActionRoutesGroup: Route[] = adminActionRoutes;

/** Workflows CRUD + run enqueue + run undo (9): GET /workflows · /workflows/proposals · POST /workflows · GET/PATCH/DELETE /workflows/:id · POST /workflows/:id/run · GET /workflow-runs · POST /workflow-runs/:id/undo. */
export const workflowsRoutesGroup: Route[] = workflowsRoutes;
/** The two AI-proposal reads. Hosted only: a local install has no proposer to read from. */
export const proposalsRoutesGroup: Route[] = proposalsRoutes;

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
 * The full route table; `apps/web` and tests mount it into `createApp`, and route `options` drive
 * the pipeline. No count is written here: an earlier sentence claimed one, was wrong, and two
 * documents quoted it — trust `apiRoutes.length`, which the enrollment sweep and the
 * `test/spend-gate.test.ts` census assert against directly. Every entry declares `cost` ({@link
 * CostClass}), a required field: adding a route without saying what it causes does not compile,
 * and `withSpendGate` refuses an undeclared one at runtime. The three mailbox mutations are
 * additionally step-up-gated and write envelope-encrypted credentials.
 */
export const apiRoutes: Route[] = [
  ...healthRoutes,
  ...helloRoutes,
  ...internalRoutes,
  ...adminRoutes,
  ...adminStaffRoutes,
  ...adminActionRoutes,
  ...adminOAuthRoutes,
  ...authRoutes,
  // The pairing ceremony, directly after the auth surface it extends: `POST /pair` (ceremony,
  // step-up), `GET /pair` (read), `DELETE /pair/:id` (ceremony, step-up), `POST /pair/redeem`
  // (anonymous). Device-pair only in effect — the bag wires no invite bridge; see the import.
  ...pairRoutes,
  ...syncRoutes,
  ...eventsRoutes,
  ...pushRoutes,
  ...mailboxRoutes,
  ...mailboxOAuthRoutes,
  ...rulesRoutes,
  ...messageRoutes,
  ...threadRoutes,
  ...screenerRoutes,
  ...trashRoutes,
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
  ...foldersRoutes,
  ...draftsRoutes,
  ...workflowsRoutes,
  ...proposalsRoutes,
  ...accountRoutes,
  ...aiSettingsRoutes,
  ...screeningRoutes,
  ...consentRoutes,
  ...waitlistRoutes,
];
