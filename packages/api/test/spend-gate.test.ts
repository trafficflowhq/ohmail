import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import {
  createApp, apiRoutes, UNVERIFIED_MAY_REACH, unverifiedMayReach,
  type ApiDeps, type CostClass, type Route,
} from "@trafficflow/api";
import { makeDeps, seedSession, req, sweepPath, FIXED_NOW } from "./helpers.js";

/**
 * the "An unverified account must not be able to generate meaningful cost" invariant — **AN UNVERIFIED ACCOUNT MUST NOT BE ABLE TO GENERATE MEANINGFUL COST.**
 *
 * Acceptance, verbatim from the gap list: *anything that does work, holds a connection, or calls
 * a paid API refuses an unverified account.*
 *
 * ## What was wrong, and why the shape of the fix is the fix
 *
 * An earlier change shipped an opt-IN route flag, `verifiedEmail: true`. **Two of 124 routes carried it.** The
 * count is the symptom; the shape is the defect. A flag a route has to REMEMBER is a flag the
 * next route will not have, and the two that had it were the two somebody happened to be thinking
 * about. Left open, among others: `POST /messages/:id/draft` (model inference),
 * `POST /drafts/:id/send` (SMTP), `POST /mailboxes/:id/resync` (a full re-walk of a real
 * mailbox), `POST /billing/portal` (a live Stripe call) and every attachment fetch (IMAP).
 *
 * Worse, and invisible from the route table: **`withVerifiedEmail` was only in FULL_PIPELINE.**
 * The five costliest routes in the product are `raw`, and `RAW_PIPELINE` did not contain the
 * gate — so setting the flag on `GET /attachments/:id` would have done nothing while looking
 * like it did something.
 *
 * So the declaration is now `Route.cost`, REQUIRED, and the permissive answer is the one a route
 * has to ask for. This file is the census that keeps it honest.
 *
 * ## What each guard is for
 *
 *  1. **The union sweep** — every route declares a class this file recognises.
 *  2. **The frozen census** — the literal set of every route an unverified account may reach.
 *     Widening the exemption means editing an explicit list, which is the whole point: the
 *     exempt set is DECLARED PER ROUTE and matched by identity, never by a `/auth/*` prefix.
 *  3. **The anonymous cross-invariants** — ANONYMOUS_PIPELINE resolves no session, so the
 *     middleware *cannot* fire there and a pipeline-membership assertion over it would be false
 *     comfort. The table is the fence instead, asserted in both directions.
 *  4. **The whole-table HTTP sweep** — every gated route, driven for real, over HTTP.
 *  5. **Route 125** — a route that declares NOTHING is refused. This is the one that protects
 *     the routes nobody has written yet, and it is asserted through `createApp`, at runtime,
 *     because a type is not a guarantee against a cast, a JavaScript caller, or a test file
 *     (gap no test file in this repository is typechecked).
 *  6. **`raw` is not an escape hatch** — asserted behaviourally on a synthetic raw route, which
 *     is strictly stronger than asserting the middleware appears in an array.
 *  7. **The old flag cannot come back** — over the source text, because deleting a field from an
 *     interface does not stop anyone re-adding it.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> =>
  app.handle(r, { ...d, session: null, idempotency: null });

const key = (r: Route): string => `${r.method} ${r.pattern}`;
const of = (cost: CostClass): string[] =>
  apiRoutes.filter((r) => r.cost === cost).map(key).sort();

const ALL_CLASSES: CostClass[] =
  ["unauthenticated", "ceremony", "read", "work", "connection", "paid"];

/* ── The frozen census ────────────────────────────────────────────────────────────────────
   These three lists ARE the exempt set. Every other route in the table refuses an account
   whose address is unproven. */

/** Authority is a shared secret, a provider signature, or nothing: no account is being served. */
const UNAUTHENTICATED = [
  "GET /admin/accounts",
  "GET /admin/accounts/:id",
  // Cloud 0047: an account's staff activity, admin search and the sync roster, on their siblings'
  // exact terms — ANONYMOUS_PIPELINE, the shared secret plus a live staff session.
  "GET /admin/accounts/:id/staff-activity",
  // The credit drill-down (cloud 0028) — one account, one day, the raw ledger rows, on press.
  // `unauthenticated` on its seven siblings' exact terms: the whole `/admin/*` table resolves no
  // customer session, so `withSpendGate` has no account to judge and the shared secret plus a
  // live staff session is the authority.
  "GET /admin/actions",
  // The console's cross-account reads (resolved alerts, active-account counts, the staff audit,
  // stored bytes), on their siblings' exact terms: ANONYMOUS_PIPELINE, no customer session, the
  // shared secret plus a live staff session.
  "GET /admin/alerts/history",
  "GET /admin/engagement",
  // The COST BOARD (cloud 0029), on the eight `/admin/*` reads' exact terms: the whole table
  // selects ANONYMOUS_PIPELINE and resolves no customer session, so `withSpendGate` has no
  // account whose verification state it could judge, and the authority is a shared secret plus a
  // live `staff_sessions` row past the TOTP wall.
  // Inherited omission: `GET /admin/funnel` (admin.ts) shipped as `cost: COST` — the same
  // `unauthenticated` class as its siblings `admin/worker`/`admin/billing`, resolved by
  // ANONYMOUS_PIPELINE with no customer session — but its route commit did not add it here, so this
  // census was already red before the screening slice. Recorded to match committed reality; the
  // classification is its siblings' exactly, so it needs no independent judgement.
  "GET /admin/funnel",
  "GET /admin/overview",
  "GET /admin/search",
  "GET /admin/staff-activity",
  "GET /admin/storage",
  "GET /admin/sync-roster",
  "GET /admin/worker",
  "GET /health",
  // The capability-negotiation endpoint (`routes/hello.ts`), mounted in every composition.
  // `unauthenticated` on `GET /health`'s exact reasoning: its authority is nothing at all — a
  // client asking "what kind of server is this?" has no credential yet, that being the point —
  // and it is `anonymous`, so ANONYMOUS_PIPELINE resolves no session and no other class is
  // representable. It reads the injected descriptor and one optional host capability, touches no
  // account row, opens no socket and calls no model; what it must never carry is anything
  // per-account, which its contract test pins by key census.
  "GET /hello",
  /**
   * THE WALL'S NIGHTLY LIFECYCLE PASS (cloud 0040). `unauthenticated` on the away clock's exact
   * terms: the caller is the worker's api-cron holding a shared secret, ANONYMOUS_PIPELINE
   * resolves no session, so there is no verified address for the verification gate to be about.
   * What one call may cause is bounded inside the pass — one plane read per live account at
   * bounded concurrency, at most one mail per (account, kind, anchor) by the notices PK, and an
   * erasure only where the plane's own `erasureAt` plus a day of slack has passed — never by
   * anything on the wire. Sorted `account-lifecycle` < `alerts`. Its ERASE door is the same
   * scheduler's, one named account per call, the program re-asked there before anything erases.
   */
  "GET /internal/account-lifecycle/erase",
  "GET /internal/account-lifecycle/run",
  "GET /internal/alerts",
  /**
   * THE ALERT DRILLS (cloud 0051). The list and the ack page are `unauthenticated` on `GET
   * /internal/alerts`' terms: ANONYMOUS_PIPELINE, no session to judge. The list's authority is the
   * alert secret; the ack page's is the token in its link, and it reads one indexed row set and
   * writes nothing. Sorted `alerts` < `alerts/drill` < `alerts/drill/ack` < `alerts/run`.
   */
  "GET /internal/alerts/drill",
  "GET /internal/alerts/drill/ack",
  "GET /internal/alerts/run",
  /**
   * THE AWAY RESPONDER'S CLOCK (mail 0087). `unauthenticated` on `GET /internal/sends/scheduled/run`'s
   * exact terms, which is the sibling it most resembles: the caller is the worker's api-cron holding
   * a shared secret, ANONYMOUS_PIPELINE resolves no session, so there is no verified address for
   * the verification gate to be about — and like that sibling it DOES open sockets (SMTP plus the
   * Sent append, on the mailbox owner's own credentials), so the bound on what one call may cause is
   * the pass's own constants (`AWAY_SENDS_PER_RUN` of five, one bounded candidate page per account,
   * `AWAY_ACCOUNTS_PER_RUN`), never anything on the wire.
   *
   * The CONSENT question is answered where the responder was configured: `PUT /away-responder` is in
   * the gated remainder, so this clock can only ever act on a standing instruction somebody already
   * wrote. The route itself decides nothing about who is answered.
   *
   * Sorted `alerts` < `away` < `billing`.
   */
  "GET /internal/away/run",
  // The billing reconciler's two doors (2026-08-23's reconciliation slice) — the dry-run probe
  // and the platform-cron apply entry. `GET /internal/alerts/run`'s exact class and reasoning:
  // the caller is a scheduler holding a shared secret, ANONYMOUS_PIPELINE resolves no session,
  // and an unauthenticated GET is a 401 that reconciles nothing. What one call may cause is
  // bounded inside the reconciler (a fixed page of subscriptions per pass), never by the wire.
  // Their route commit did not move this census — both were watched red here (177 with three
  // routes mounted) before these literals landed, which is this census doing its job late.
  // The INVOICE mirror's heal (cloud 0029), on the two below's exact terms — a scheduler's door
  // authorised by a shared secret, resolving no session. What one call may cause is bounded
  // inside the pass and never by the wire: a page count, a page size and a deadline, both
  // constants in `reconcile-invoices.ts`. Its ONE query parameter (`?since=all`, the backfill)
  // widens the LISTING and nothing else — no page count, no deadline, no write the default pass
  // could not make — so it does not put the cost in a caller's hands, which is the property this
  // list is about. It sits ABOVE its two siblings because this list is compared sorted.
  /**
   * The `SIZE` back-fill's clock. `unauthenticated` on its two siblings' terms: a scheduler's
   * shared secret is the whole gate and no user session is ever resolved, so there is no verified
   * address for the verification gate to be about.
   *
   * It DOES open sockets to third-party submission servers, which is the one way it is unlike the
   * reaper below it — so the bound on what one call may cause is a pair of constants in
   * `smtp-size.ts` (a batch of eight and a 40-second deadline) rather than anything a caller can
   * choose. An unauthenticated route whose cost a caller could pick would not belong in this list.
   */
  "GET /internal/mailboxes/smtp-size",
  // The PLATFORM COST clock (cloud 0029), on the three reconciliation doors' exact terms — a
  // scheduler's door authorised by a shared secret, resolving no session. What one call may
  // cause is three bounded GETs to vendors WE pay, with a per-request deadline inside the port
  // and nothing a caller can choose; on the hosted service today every one of them answers `unconfigured`
  // and the pass writes nothing at all.
  // The PLATFORM SIGNAL clock (cloud 0030), on the cost clock's exact terms one line up — a
  // scheduler's door authorised by a shared secret, resolving no session. What one call may cause
  // is a bounded walk of one vendor's log endpoint (`SIGNAL_PAGE_BUDGET` pages per project, a
  // per-request deadline in the port) with nothing a caller can choose; on the hosted service today the
  // port answers `unconfigured` and the pass writes nothing at all.
  "GET /internal/platform-signals/run",
  /**
   * THE SIGN-IN THROTTLE'S SECURITY NOTICES — `unauthenticated` on the lifecycle pass's exact
   * terms: the worker's api-cron with a shared secret, no session, no verified address for the
   * gate to be about. One run claims at most fifty owed rows and mails each account's own address.
   */
  "GET /internal/security-notices/run",
  /**
   * The RECONCILER for stranded send reservations. `unauthenticated` on its neighbour's exact
   * terms — the caller is the worker's api-cron holding a shared secret, no user session is ever
   * resolved — and it opens sockets on the same footing, bounded by the pass's own constants
   * (`SEND_RECONCILE_BATCH` of three, one connection per distinct mailbox, dialled only for a
   * `connected` mailbox and only through this host's IMAP admission counter) and by nothing on
   * the wire.
   *
   * What it may CAUSE is strictly less than its neighbour, and that is the reason it belongs here
   * rather than in a gated class: the adapter it probes through cannot send — `send` throws — so
   * the whole surface is one Sent-folder search per stale reservation and a terminal state
   * written by compare-and-swap. The VERIFICATION question was answered where the reservation was
   * made: `POST /drafts/:id/send` is gated, so an unverified account has nothing here to
   * reconcile. Sorted `reconcile` < `scheduled`.
   */
  "GET /internal/sends/reconcile/run",
  /**
   * SEND LATER's scheduler clock. `unauthenticated` on the SIZE back-fill's exact
   * terms one entry up: the caller is the worker's api-cron holding a shared secret, no user
   * session is ever resolved, so there is no verified address for the verification gate to be
   * about — and like that sibling it DOES open sockets (SMTP + the Sent append, on the
   * appointment owner's own credentials), so the bound on what one call may cause is the
   * pass's own constants (`SCHEDULED_SEND_BATCH` of three, `FOR UPDATE SKIP LOCKED`), never
   * anything on the wire. The VERIFICATION question was answered where the appointment was
   * made: `POST /drafts/:id/schedule` is `work`, in the gated remainder, so an unverified
   * account cannot park mail for this clock to send. Sorted `mailboxes` < `sends` < `sessions`.
   */
  "GET /internal/sends/scheduled/run",
  // The web-session reaper's platform-cron entry (DEVICES hygiene). `GET /internal/alerts/run`'s
  // exact class and exact reasoning: the caller is a scheduler holding a shared secret, not an
  // account — ANONYMOUS_PIPELINE resolves no session, so no other class is representable — and
  // an unauthenticated GET is a 401 that reaps nothing. What it revokes is bounded structurally
  // inside `reapStaleWebSessions` (device-less, full-scope, >60d idle), never by anything on
  // the wire. Sorted after `alerts/run` (`alerts` < `sessions`).
  "GET /internal/sessions/reap",
  // The screened-out unsubscribe DRAIN, on the away clock's and the send reconciler's exact
  // terms: a scheduler's door behind a shared secret, no session resolved. What one call may
  // cause is bounded by the service's own constants — accounts, targets per account, a wall
  // clock and the window it looks back over — and by nothing on the wire, since the request
  // carries no body, no query and no path parameter at all.
  "GET /internal/unsubscribe/drain",
  // Cloud 0009 — THE OAuth REDIRECT BOUNCE, and the one entry on this list that is
  // `unauthenticated` because it CANNOT be anything else rather than because its authority is a
  // shared secret. `tf_session` is `SameSite=Strict`, so the browser withholds it on the cross-site
  // top-level navigation back from `login.microsoftonline.com`; a handler that resolved a session
  // here would 401 every consent this product runs. It therefore reads nothing, writes nothing,
  // consumes nothing and decides nothing about any account: its whole output is a 303 to an origin
  // taken from CONFIG, carrying two shape-validated opaque parameters. The authorization happens on
  // `POST /mailboxes/oauth/microsoft/complete`, which is `work` and in the gated remainder, and
  // which is where the session's account is asserted to be the ceremony's account.
  // Sorted here by the whole string: `GET /internal/…` < `GET /mailboxes/…`.
  "GET /mailboxes/oauth/microsoft/callback",
  // The billing link: a staff member mails an account's owner the app's billing door. The same
  // two credentials in series as the release below; no customer session, so no verified address.
  "POST /admin/accounts/:id/billing-link",
  // the admin console's ONE write pair (suspend/resume). `unauthenticated` for the same
  // reason as the reads: ANONYMOUS_PIPELINE resolves no customer session. Their authority is the
  // shared secret PLUS a live staff session inside the handler; the gate cookie / secret alone is
  // refused (admin-actions.ts). Sorted here before the staff routes (`accounts` < `staff`).
  // Mail 0039 — releasing a quarantined mailbox. Same class and same authority as the pair above
  // it: ANONYMOUS_PIPELINE resolves no customer session, and the shared secret alone is refused
  // inside the handler without a live staff session. It is a WRITE against an account's mailbox
  // performed by somebody who holds no session for that account, which is exactly why it belongs
  // in this frozen list rather than passing unremarked — the exemption is from the VERIFIED-EMAIL
  // gate, and it is bought by the two credentials in series, not by the route being administrative.
  // Sorted after `accounts` and before `staff` (`accounts` < `mailboxes` < `staff`).
  "POST /admin/mailboxes/resync",
  // Cloud 0009 — the ENTRA APPLICATION REGISTRATION surface. Same class and same authority as the
  // three writes above: ANONYMOUS_PIPELINE resolves no customer session, and the shared secret alone
  // is refused inside the handler without a live `staff_users` session.
  //
  // THE READ IS A POST AND IS ON THIS LIST TOO, which is worth a sentence because it looks like an
  // omission the other way round: the staff session token rides in the BODY (the console's proxy
  // forwards the HttpOnly cookie there, as `/admin/staff/totp/begin` already does), and a GET has no
  // body to put it in — the alternative puts a live session credential in access logs. So both
  // halves of this surface are POSTs and both are exempt from the VERIFIED-EMAIL gate, bought by the
  // two credentials in series rather than by the routes being administrative.
  //
  // Sorted between `mailboxes` and `staff` (`accounts` < `mailboxes` < `oauth` < `staff`).
  "POST /admin/oauth/microsoft",
  "POST /admin/oauth/microsoft/save",
  // The MANUAL cost entry (cloud 0029) — the fourth admin write, and the first whose subject is
  // not an account. `unauthenticated` on the other three writes' exact terms: the whole
  // `/admin/*` table selects ANONYMOUS_PIPELINE and resolves no customer session, so
  // `withSpendGate` has no account whose verification state it could judge. Its authority is the
  // shared secret PLUS a live `staff_sessions` row past the TOTP wall — the same two credentials
  // in series that suspend an account.
  // the admin console's staff sign-in. `unauthenticated` is the honest class and not a
  // convenience: these five run on ANONYMOUS_PIPELINE, so no customer session is ever resolved
  // and there is no account whose verification state could be judged. Their authority is the
  // shared secret plus, inside the handler, `staff_users`.
  //
  // The cost bound for the pre-session ones is the throttle, not the gate: `/session` and
  // `/totp/confirm` lock on `staff:email:<addr>` and `staff:ip:<hashed>` after five failures.
  // Cloud 0047: the assertion mint and the roles change, on the staff routes' terms; both verify
  // their own factor inside the handler.
  "POST /admin/staff/assertion",
  // The staff list (owner only), a read on the staff routes' terms: the session rides in the header.
  "POST /admin/staff/list",
  "POST /admin/staff/roles",
  "POST /admin/staff/session",
  "POST /admin/staff/sign-out",
  /**
   * The step-up and the second-factor recovery (cloud 0036), on the other five staff routes'
   * exact terms: `unauthenticated`, anonymous, gated by the shared secret, resolving no customer
   * session. One proves a factor for a staff session that already exists; the other is the
   * operator command that returns a locked-out staff member to "not enrolled". Neither can be
   * behind the spend gate, which judges a session this pipeline never resolves.
   */
  "POST /admin/staff/step-up",
  "POST /admin/staff/totp/begin",
  "POST /admin/staff/totp/confirm",
  "POST /admin/staff/totp/reset",
  "POST /admin/staff/whoami",
  "POST /internal/alerts",
  /**
   * THE ALERT DRILLS' TWO WRITES (cloud 0051), on `POST /internal/alerts`' terms. A run is the alert
   * secret alone, at most one an hour, and one call costs at most every alert kind times two drivers
   * times the sinks in rows and one message per (driver, sink). The ack's authority is its token: one
   * indexed UPDATE, once.
   */
  "POST /internal/alerts/drill",
  "POST /internal/alerts/drill/ack",
  /**
   * THE FAULT PROBE (cloud 0033). `unauthenticated`, on the two alert entries' exact terms: the
   * caller is whoever holds the internal shared secret, there is no session for the verification
   * gate to be about, and the whole request is the credential — no query, no body, no path param.
   *
   * It is the one route here that is NOT `anonymous`, deliberately: the recording seam under test
   * is `withErrorEnvelope`, which is in FULL_PIPELINE only, so an `anonymous` or `raw` route
   * could not exercise it at all. What it CAUSES is one row and one thrown error; it opens no
   * socket, reads no account and calls no model.
   */
  "POST /internal/fault",
  // The pairing redeem (managed device pairing). `unauthenticated` is the honest class: it runs
  // on ANONYMOUS_PIPELINE — the single-use 256-bit token IS the credential, and the redeemer by
  // definition has no session yet. What it mints meets this gate everywhere it matters: the
  // paired session belongs to the token's CREATOR, so its verification state is the creator's.
  // Sorted between `internal` and `waitlist` (`internal` < `pair` < `waitlist`).
  "POST /pair/redeem",
  "POST /waitlist",
];

/** The identity lifecycle: entering, proving, extending and LEAVING. */
const CEREMONY = [
  "DELETE /account",
  "DELETE /auth/2fa/totp",
  "DELETE /devices/:id",
  // Revoking a pairing token (managed device pairing) — `DELETE /devices/:id`'s exact
  // reasoning: credential lifecycle, costs nothing, can only reduce risk, and a verification
  // gate in front of it would keep a leaked token alive. Step-up-gated besides.
  "DELETE /pair/:id",
  "GET /auth/session",
  "GET /oauth/authorize",
  "POST /auth/2fa/recovery-codes",
  "POST /auth/2fa/recovery-codes/verify",
  "POST /auth/2fa/totp/activate",
  "POST /auth/2fa/totp/enroll",
  "POST /auth/2fa/totp/verify",
  "POST /auth/2fa/webauthn/assert/options",
  "POST /auth/2fa/webauthn/assert/verify",
  "POST /auth/2fa/webauthn/register/options",
  "POST /auth/2fa/webauthn/register/verify",
  // The desktop handoff pair. Both `ceremony`, and the two halves earn it differently, which
  // is why they are named separately rather than as "the desktop routes".
  //
  // `desktop-claim` is UNAUTHENTICATED in fact — the code is the credential — and it is
  // nevertheless `ceremony` and not `unauthenticated`, because it RESOLVES A SESSION: it ends
  // with a live `sessions` row for a real account, which is the identity lifecycle and not "no
  // account is being served". `POST /auth/login` is on this list for the same reason.
  //
  // `desktop-link` is authenticated AND step-up gated, so being on this list buys it nothing
  // an unverified account can use: it can mint a code, and the session that code produces meets
  // the same gate on every route that matters. Exempting it is the same decision `POST
  // /auth/logout` and `DELETE /devices/:id` already carry — credential lifecycle stays reachable
  // while an address is unproven, because the paths OUT of that state must not depend on it.
  // The one-confirm desktop sign-in, `desktop-claim`'s and `desktop-link`'s positions: the
  // request and the claim resolve a session from what the desktop holds, and the confirm is
  // step-up gated — credential lifecycle, reachable while an address is unproven.
  "POST /auth/desktop-approval",
  "POST /auth/desktop-approval/:id/confirm",
  "POST /auth/desktop-approval/:id/deny",
  "POST /auth/desktop-approval/claim",
  "POST /auth/desktop-claim",
  "POST /auth/desktop-link",
  "POST /auth/login",
  "POST /auth/logout",
  // Changing the password, on `POST /auth/logout`'s terms: rotating a credential somebody else
  // knows must not wait on a verified address. One scrypt per attempt, bounded by the sign-in
  // lockout, and step-up gated besides.
  "POST /auth/password",
  "POST /auth/refresh",
  // The web's sign-out door, `POST /auth/logout`'s class and reasoning: leaving, one lookup and two
  // updates and an audit row, no work. Sorted after `refresh` (`refresh` < `refresh/logout`).
  "POST /auth/refresh/logout",
  "POST /auth/register",
  // The step-up RE-verification ceremony (DEVICES) — the sign-in second factor, re-run against
  // the session the caller already holds so a stale five-minute window stops being a dead end.
  // `ceremony` on `POST /auth/2fa/totp/verify`'s exact reasoning: identity lifecycle, no work,
  // no socket, no model — and the exemption buys an unverified account nothing it can spend:
  // every re-stamped session meets this same gate on every route that matters. Sorted between
  // `register` and `verify-email` (`r` < `s` < `v`).
  "POST /auth/step-up/totp",
  "POST /auth/step-up/webauthn/options",
  "POST /auth/step-up/webauthn/verify",
  "POST /auth/verify-email",
  "POST /auth/verify-email/resend",
  // The bulk web-session take-back (DEVICES) — `DELETE /devices/:id`'s exact reasoning, over
  // the device-less remainder at once: credential lifecycle, costs nothing, can only reduce
  // risk, and a verification gate in front of a revocation would keep compromised sessions
  // alive. Step-up-gated besides. Sorted between `auth` and `oauth` (`a` < `d` < `o`).
  "POST /devices/revoke-web-sessions",
  // The confirming half of the native authorize ceremony — `GET /oauth/authorize` two entries up
  // is now only the bounce that opens it, and this is the press that mints. Same class for the
  // same reason: a credential ceremony costs nothing to serve and must stay reachable while an
  // address is unproven, or a desktop sign-in would wait on an email.
  "POST /oauth/authorize",
  "POST /oauth/token",
  // The pairing mint (managed device pairing). Authenticated AND step-up gated, so the
  // exemption buys an unverified account nothing it can spend: `POST /auth/desktop-link`'s
  // exact position, argued above — it can mint a token, and the session that token produces
  // meets the same gate on every route that matters. Credential lifecycle stays reachable
  // while an address is unproven. Sorted after `/oauth/token` (`oauth` < `pair`).
  "POST /pair",
  // A pairing link's state by its token's HASH — `DELETE /pair/:id`'s class: the credential
  // lifecycle, one read, no write, nothing a caller can spend. Public: the asker holds a link, not
  // a session. Sorted after `POST /pair` (`/pair` < `/pair/state`).
  "POST /pair/state",
];

/** Reads rows already stored for the caller's own account, and writes nothing. */
const READ = [
  // The mailbox pane's pre-flight on the entitlements port: may this account add another, and
  // how many does the plan hold. `read` because it selects the port's verdict for the caller's
  // own account and writes nothing, opens no socket and calls no model.
  "GET /account/access",
  "GET /account/ai",
  // THE WALL'S EXPORT DOOR (cloud 0040's slice). `read`: it selects the caller's own rows —
  // the organizer profile per mailbox and the settings knobs — and writes nothing, opens no
  // socket and calls no model. It also sits on `ACCESS_REFUSED_MAY_REACH_ROUTES`: the way out
  // with your configuration cannot be behind the wall, and an unverified account reading its
  // own configuration costs the invocation the refusal would cost.
  "GET /account/export",
  // SCR — reading the editable Ohbox preference. `read`: it selects the caller's own
  // `account_settings` row and writes nothing, reaches no mailbox and calls no model. Its PATCH
  // sibling is `work` and is deliberately in the gated remainder, not here.
  "GET /account/screening",
  "GET /approvals",
  "GET /attachments/:id/meta",
  "GET /auth/audit",
  // The approval page's read of the request it is about to confirm — writes nothing.
  "GET /auth/desktop-approval/:id",
  "GET /away-responder",
  // The onboarding-consent reads. All three are `read` and therefore reachable unverified,
  // which is a decision rather than an oversight: this is the flow an account meets in its
  // FIRST five minutes, and verification and onboarding overlap by construction — a person
  // who has connected a mailbox and not yet clicked the link in their signup mail is exactly
  // who is looking at the seed review. None of them writes, opens a socket or reaches a model.
  // `GET /consent/seed` is the most expensive read in the table (up to `SEED_SCAN_LIMIT` rows
  // joined to `message_bodies`) and is still `read`, because `cost` classifies what a handler
  // CAUSES and not how much of the caller's own data it reads. Both POSTs are `work` and
  // deliberately absent from this list.
  "GET /consent",
  "GET /consent/reset",
  "GET /consent/seed",
  "GET /contacts",
  "GET /contacts/:id",
  "GET /contacts/:id/notes",
  "GET /devices",
  "GET /drafts/:id",
  // What happened under this idempotency key: one equality read of the caller's own
  // `outbound_sends` row. It writes nothing, reserves nothing and cannot send.
  "GET /drafts/:id/send-attempt",
  "GET /files",
  // The folder delete confirm's server-truth numbers (stage 2): "N messages across M folders
  // move to Trash" has to be counted where the whole subtree is visible, and the mirror is
  // windowed. `read` because it selects the caller's own rows and nothing else — no socket, no
  // model, no write. The four folder VERBS (`POST /folders`, `PATCH`/`DELETE /folders/:id`,
  // `DELETE /folders/:id/op`) are `work` and deliberately in the gated remainder: each records
  // a command the worker executes against the caller's own mail server.
  "GET /folders/:id/summary",
  "GET /kb",
  "GET /kb/:id",
  "GET /mailboxes",
  "GET /mailboxes/:id",
  // The waiting filings of the caller's own mailbox: one grouped read of stored rows, no dial.
  "GET /mailboxes/:id/filings",
  /* Mail 0094 — the mirrored settings of a mailbox another install organizes. `read` on
     `GET /mailboxes/:id`'s exact terms, and NOT on `GET /mailboxes/:id/organizer`'s: that one is
     `connection` because it opens an IMAP socket to the user's provider, and the argument stated
     there is that `read` would have put a mail-server dial inside the set an account with an
     unproven address may reach. This one dials nothing — one indexed row out of
     `mailbox_profile_mirror` — and its own suite proves it by answering 200 for a mailbox with no
     stored credential, which cannot be dialled at all. It returns the account's own configuration
     and spends nothing. */
  "GET /mailboxes/:id/profile",
  /* Is there a settings document to offer: the organizer's found-marker and the local store, never
     a dial — the organizer read the mailbox on its own connection. Was `connection` while this read
     re-dialled the folder inside the request, which on a slow provider meant no card at all. */
  "GET /mailboxes/:id/profile-import",
  /* Where a press of Import settings the organizer is finishing stands (mail 0129): one
     primary-key read of the mailbox row and, once, the resolution row. It dials nothing — the
     organizer does the read — and returns the account's own answer. `read`, like the profile read
     above it. */
  "GET /mailboxes/:id/profile-import/status",
  // Cloud 0009 — the Outlook-door CAPABILITY READ, and the one member of the OAuth surface that is
  // `read` rather than `work`/`unauthenticated`. It is behind a session like every other mailbox
  // read (it 401s unauthenticated), so it is NOT on the `unauthenticated` list beside its
  // `…/callback` sibling — a `SameSite=Strict` cookie reaches it fine. It reads no account row and
  // instead answers a single deployment fact (is the Entra registration armed), opening no socket
  // and calling no model, which is why it is `read` and not `connection`/`work`. Reachable
  // unverified deliberately: the settings pane reads it on mount to decide whether to offer the
  // sign-in, and an account mid-verification connecting its first mailbox is exactly who is looking.
  // Sorted between `/mailboxes/:id` and `/messages` (':' < 'o'; 'mailboxes' < 'messages').
  "GET /mailboxes/oauth/microsoft/availability",
  "GET /messages",
  "GET /messages/:id",
  "GET /messages/:id/attachments",
  "GET /messages/:id/body",
  "GET /messages/:id/tracker-events",
  // The batch message-bodies read — the many-at-once equivalent of `GET /messages/:id/body`
  // above it: the caller's own stored, already-redacted bodies, no model and no socket, so it
  // is `read` and reachable unverified exactly as the single-body route is. Added with the
  // desktop Cloud-mirror's bulk text pull, which reads bodies a page at a time.
  "GET /messages/bodies",

  // The History rail's counts — one grouped read of the caller's own messages, `read` and
  // reachable unverified exactly as the list it jumps within.
  "GET /messages/timeline",
  // What the confirmation page is about to authorize, read without spending it. `read` because it
  // is one SELECT against a row the caller's own session opened; exempt for `GET /oauth/authorize`'s
  // reason verbatim — the page it feeds is the ceremony, and gating it would gate the ceremony.
  // Sorted between `/notify-rules` and `/pair` (`n` < `o` < `p`).
  "GET /notify-rules",
  "GET /oauth/authorize/request",
  // What waits on the organizer: this account's own request rows, projected, never a payload. A
  // read, exempt on `GET /rules`'s reasoning — it is the state the rules page owes its reader.
  "GET /organizer-requests",
  // The caller's own pairing mints (managed device pairing) — metadata only, never the token
  // or a hash (the projection names its columns), creator-scoped in the service. `read` on
  // `GET /devices`' exact reasoning, four lines up: seeing your own credential surface is what
  // makes the ceremony revocable, so it must not hide behind a verification.
  "GET /pair",
  /**
   * This DEPLOYMENT's VAPID public key, so a UnifiedPush connector can register with it. `read`,
   * and exempt, on `GET …/oauth/microsoft/availability`'s exact reasoning: it is a DEPLOYMENT FACT,
   * not account data. It selects no row, opens no socket, reaches no model, and returns the same
   * one value to every caller — so there is nothing here an unproven address could learn about
   * anybody, including itself.
   *
   * It is also not a secret in any degree: the key is handed to every device that registers and
   * travels in the clear in the `k=` field of every wake this deployment sends. It is authenticated
   * at all only because no caller needs it before pairing, not because the value is protected.
   */
  "GET /push/vapid-key",
  "GET /rules",
  "GET /rules/:id",
  "GET /screener",
  // What the Screener filed on its own, still in place: `read`, one bounded read of the caller's
  // own audit rows and folder state. The put-back beside it is `work` and is not here.
  "GET /screener/auto-filed",
  // mail 0104 — the held-release summary. `read`, so it joins this list: it is a grouped
  // count over the caller's own rules and their own held mail, spends nothing and opens no
  // socket. The PRESS beside it is `work` and is not here.
  "GET /screener/held-releases",
  // The one-time sweep offer's DRY RUN (FOLDERS-SPEC.md §16.1): how much still sits in
  // ohmail/Quarantine per mailbox. `read` because it is one GROUP BY over the caller's own rows —
  // no socket, no model, no write. Its sibling `POST /screener/junk/sweep` is `work` (it records
  // the command the worker executes) and the window's list/body/rescue/search are `connection`
  // (they dial), so all five siblings sit in the gated remainder.
  "GET /screener/junk/sweep",
  // Why a sender's rows stayed: `read`, one bounded read of the caller's own named messages.
  "GET /screener/stayed",
  // the undecided-sender summary, and the same reading as the held-release one above:
  // `read`, a grouped count over the caller's own Ohbox against their own rules, spending nothing
  // and opening no socket. The PRESS beside it is `work` and is not here.
  "GET /screener/unscreened",
  // What agreeing will screen: the same walk over one mailbox and a window, a read for the same reason.
  "GET /screener/unscreened/count",
  // The decide step's count of one mailbox's waiting senders: the queue's total, a read.
  "GET /screener/waiting/count",
  "GET /search",
  "GET /snippets",
  "GET /snippets/:id",
  "GET /sync",
  // The bootstrap reader. `read` for exactly the reason its `/sync` sibling above it is:
  // rows already stored for the caller's own account, no write, no socket, no model. It returns
  // MORE of them than any other read in the table — the live rule/state/approval/draft set plus a
  // 90-day message window — and that is deliberately not what decides the class: `cost`
  // classifies what a handler CAUSES, and `GET /consent/seed` is already on this list under the
  // same reading. Reachable unverified matters here rather than being a technicality: bootstrapping
  // the mirror is what a client does in its first seconds, which is precisely when the address in
  // the signup mail has not been clicked yet.
  "GET /sync/snapshot",
  // reading your own tag list spends nothing and reaches no mailbox. `read`, like
  // `GET /kb` above it, and NOT `work`: an unverified account seeing an empty tag rail is
  // correct, while a 403 there would break the rail for an account mid-verification. Every
  // tag WRITE (`POST /tags`, `PATCH`/`DELETE /tags/:id`, `POST /messages/:id/tags`) is
  // `work` and therefore gated — deliberately absent from this list.
  "GET /tags",
  "GET /threads/:id",
  "GET /threads/:id/notes",
  "GET /tracker-events",
  "GET /triage",
  "GET /views/focus-reply",
  "GET /views/power-through",
  "GET /workflow-runs",
  "GET /workflows",
  "GET /workflows/:id",
  "GET /workflows/proposals",
];

describe("the route table declares what every handler causes", () => {
  // No count in the name: the literal inside is the census, and a second copy in a string
  // drifted (it read "154" while the assertion held 170).
  it("every route declares a recognised cost class, and the table length is pinned", () => {
    // The count is stated because two binding documents quoted a stale one (the "An unverified account must not be able to generate meaningful cost" invariant and
    // The project's design notes both said 122, from a `routes/index.ts` comment that said 117). If the table
    // grows, this number and the census below are edited together, deliberately.
    // 124 → 123 on 2026-08-04: UNMOUNTED `GET /img`, the only `cost: "connection"` route
    // that fetched a caller-supplied URL. It was a live SSRF with body exfiltration and had
    // no consumer. Putting it back is a decision that has to move this number again.
    // 123 → 124 on 2026-08-04: `POST /messages/:id/unsubscribe` was mounted, which is
    // `cost: "connection"` and DOES open a socket to a sender — but it is not `GET /img`
    // returning. The url is read from the message's stored headers, so no caller can name a
    // host; the SSRF gate runs on it anyway; and the response carries a status and no bytes,
    // so there is no exfiltration channel to defeat the gate through.
    // 124 → 129 in the same working tree: 5 `/tags` routes were mounted concurrently. One of them
    // is `cost: "read"`, so the READ census below is owed by THAT slice, not this one — the
    // number here is a measurement of the whole table and belongs to whoever measures it last.
    // 129 → 130: `POST /screener/suggest` was mounted. It is `cost: "work"` and therefore does
    // NOT join the READ census below — deliberately, and it is the whole point of the slice:
    // generating a suggestion is the only screener path that reaches a model, and `GET /screener`
    // stays in READ because it stopped doing so. No route MOVED between classes; one was added.
    // 130 → 131: `GET /img` was REMOUNTED — the same route an earlier line above removed, so
    // this is that decision being taken, not a new one. What changed is the reason that line
    // gave: it had no consumer, and now it has exactly one (`apps/webapp/app/shell/
    // remote-images.ts` → `MessageBody`'s `imageProxy`), which is what makes the reading path
    // block a tracking pixel by default and load a picture only on a press. It is
    // `cost: "connection"` — an unverified account may not reach it — and it re-enters with
    // the SSRF gate that was built for its absence plus a response allow-list the gate cannot
    // speak about: `image/svg+xml` is refused rather than relayed, there is no
    // `application/octet-stream` fallback, and the bytes carry `nosniff` and
    // `default-src 'none'; sandbox`. See `privacy.test.ts`.
    // 136 → 141: the onboarding-consent surface mounted five routes — three `read` (which join
    // the READ census above) and two `work` (`POST /consent/seed`, `POST /consent/reset`). The
    // split is the point: reading who you have written to costs nothing and is reachable
    // unverified; writing the rules that consent produces, and wiping every rule an account
    // has, are not.
    // 141 → 143: the two admin WRITE routes were mounted (`POST /admin/accounts/{suspend,resume}`),
    // both `unauthenticated`, so they join `UNAUTHENTICATED` and the total together.
    // 143 → 144: mail 0039 mounted `POST /admin/mailboxes/resync`, the third admin write —
    // releasing a mailbox the sync worker has quarantined. `unauthenticated` like the other two,
    // so it joins `UNAUTHENTICATED` and this total in the same diff.
    // 146 → 147: mail 0040 mounted `PATCH /consent/settings`, the auto-suggest opt-in and the
    // FIRST write any account setting has had. `cost: "work"`, so it joins the gated remainder
    // and neither `READ` nor `CEREMONY` — and the reason is not that it writes a row, which is
    // cheap, but that the row it writes AUTHORISES METERED SPEND. An unverified account arming a
    // spender is the "An unverified account must not be able to generate meaningful cost" invariant reached one indirection later than this gate usually looks, so the
    // class is chosen for what the flag causes rather than for what the handler costs.
    // 147 → 149: SCR mounted `GET/PATCH /account/screening`, the editable Ohbox preference. The GET
    // is `read` and joins the READ census above (its own `account_settings` row, no model, no
    // socket); the PATCH is `work` and joins the gated remainder — a settings write is not metered,
    // but `work` is the class for "an authenticated mutation that is not a read", and an unverified
    // account has no business changing account state. One route to each side, in the same diff.
    // (The base was 148, not the 147 the literal read: `GET /admin/funnel` had been committed to the
    // table without joining `UNAUTHENTICATED`, so this census was already red — corrected above.)
    // 150 → 151: the batch bodies read `GET /messages/bodies` — the many-at-once equivalent of
    // `GET /messages/:id/body`; it joins READ and the total, and the gated remainder is unchanged
    // because a read is exempt.
    // 151 → 152: `GET /sync/snapshot` was mounted, the bootstrap reader beside `GET /sync`. It is
    // `cost: "read"`, so it joins the READ census above and this total, and the gated remainder is
    // unchanged. Moved here at the old count first: with the route mounted and this literal still
    // reading 151, this file failed twice — once on the length and once on the READ set naming
    // `GET /sync/snapshot` — which is the evidence that both numbers below are measurements and
    // not decoration.
    // 152 → 154: the desktop handoff pair (`POST /auth/desktop-link`, `POST /auth/desktop-claim`).
    // BOTH are `ceremony`, so they enter `CEREMONY` and this total together and the gated
    // remainder is arithmetically unchanged — which is the check worth having on a pair whose
    // second half is reachable with no session at all. A handoff that had slipped into a gated
    // class would have been a desktop sign-in that works for a verified account and 403s for
    // everybody else; a handoff that had slipped into `unauthenticated` would have been a
    // session-minting route claiming no account is being served.
    // 154 → 159: cloud 0009 mounted FIVE. Three for the Microsoft consent ceremony
    // (`POST …/oauth/microsoft/start` and `POST …/complete`, both `work`; `GET …/callback`,
    // `unauthenticated`) and two for the admin registration surface (`POST /admin/oauth/microsoft`
    // and `…/save`, both `unauthenticated`). The exempt list gains THREE and the gated remainder
    // gains TWO, and that split is the check worth having on this slice: the two routes that spend —
    // minting state and POSTing to a third party, then storing a credential and starting a full sync
    // — are gated, while the one that is exempt is exempt because a `SameSite=Strict` cookie cannot
    // reach it and it therefore has no account to judge. A ceremony that had landed the other way
    // round would be an unverified address able to make this process dial Microsoft and then IMAP.
    // 159 → 160: cloud 0009's SIXTH route, mounted after the five above — the Outlook-door capability
    // read (`GET …/oauth/microsoft/availability`, `cost: "read"`). ONLY the left-hand literal moves:
    // it is `read`, so it enters `READ` and this total together and the gated remainder is unchanged.
    // 160 → 161: `POST /attachments/staging` — the hosted send's upload-ticket mint. It is
    // `cost: "work"`, so it joins the GATED REMAINDER and none of the three exempt lists, and BOTH
    // numbers below move by one. That split is the whole check on this route: it writes a row and
    // creates OBJECT-STORAGE cost, which is the "An unverified account must not be able to generate meaningful cost" invariant's subject reached through a bill rather
    // than through a model, and an exempt mint would be an account with an unproven address able
    // to fill a bucket somebody pays for. Not `paid` (nothing metered is debited, no third party
    // bills per call) and not `connection` (it opens no socket to the user's mail server and holds
    // nothing open). HOSTED ONLY — `routes/local.ts` does not name the module, so this total is
    // the hosted table's and `localRoutes` is unchanged.
    // 161 → 162: `GET /hello`, the capability-negotiation endpoint, mounted in every composition
    // (this table, `localRoutes`, `selfHostRoutes`). It is `unauthenticated`, so it enters
    // `UNAUTHENTICATED` and this total together and the gated remainder is arithmetically
    // unchanged — the check worth having on an endpoint whose whole job is to answer strangers.
    // 162 → 165: the portable profile's confirm-import surface, three routes in the mailbox
    // group (so every composition that mounts mailboxes carries them). `GET
    // /mailboxes/:id/profile-import` and `POST /mailboxes/:id/profile-import` are `connection`
    // — the candidate's interesting branch and the apply's re-verification both open an IMAP
    // socket to the user's provider, the organizer-peek argument verbatim — and
    // `POST …/profile-import/decline` is `work` (one marker row, and it must stay answerable
    // when the mailbox itself is unreachable). All three join the gated remainder: an unproven
    // address must not be able to make this process dial a mail server, nor to rewrite an
    // account's rules from a document it cannot even have been shown.
    // 165 → 169: the managed device-pairing mount put the whole pairing ceremony on this table
    // (`routes/index.ts` now spreads `pairRoutes`; device-pair only in effect — the hosted bag
    // wires no invite bridge, so both invite arms refuse). All four enter EXEMPT classes and the
    // gated remainder is arithmetically unchanged: `POST /pair` and `DELETE /pair/:id` are
    // `ceremony` (credential lifecycle — the desktop-link precedent verbatim: an unverified
    // account can mint a token, and the session its redeem produces meets this same gate on
    // every route that matters), `GET /pair` is `read` (the caller's own rows, hashless), and
    // `POST /pair/redeem` is `unauthenticated` (the token is the credential; `raw` rather than
    // `anonymous` since the cross-account refusal needs the session resolved — see routes/pair.ts).
    // Watched red at 165 with the routes mounted before this literal moved.
    // 169 → 170: `GET /push/vapid-key` — this deployment's VAPID public key, which a UnifiedPush
    // connector must register with before it can render a wake. It is `read`, so it enters `READ`
    // and this total together and the GATED REMAINDER IS ARITHMETICALLY UNCHANGED, which is the
    // check worth having here: the question is whether a per-deployment constant slipped into a
    // class that implies account data or spend, and the answer is that it is the same class as
    // `GET …/oauth/microsoft/availability`, the other deployment-fact read in this table. It
    // selects no row, opens no socket, reaches no model, and answers every caller identically.
    // Not `unauthenticated`: nothing needs the key before pairing, so there is no reason to serve
    // it to strangers even though the value itself is public.
    // 170 → 175: the DEVICES slice mounted five, all in EXEMPT classes, so the gated remainder
    // is arithmetically unchanged. Three `ceremony` step-up re-verifies (`POST
    // /auth/step-up/{totp,webauthn/options,webauthn/verify}` — the sign-in second factor re-run
    // against the caller's own session; identity lifecycle end to end), one `ceremony` bulk
    // revocation (`POST /devices/revoke-web-sessions` — `DELETE /devices/:id` over the
    // device-less remainder), and one `unauthenticated` platform-cron entry (`GET
    // /internal/sessions/reap` — a scheduler's shared secret, no session ever resolved).
    // Watched red at 170 with the routes mounted before this literal moved.
    // 175 → 176: `POST /billing/addons` (the +10 GB / +1 mailbox purchase, 2026-08-22). It is
    // `paid` + stepUp — a money mutation against the card on file — so it enters the GATED
    // remainder and that remainder's arithmetic moves by one below, deliberately: the whole
    // point of this census is that a new spending route cannot ship exempt by accident, and
    // this one showed up here red before its literal moved, exactly as the gate intends.
    // 176 → 177: `GET /internal/mailboxes/smtp-size` (the RFC 1870 SIZE back-fill's clock,
    // 2026-08-22). `unauthenticated`, so it joins the EXEMPT set and the gated remainder below is
    // arithmetically unchanged — the same shape the session reaper had. Watched red at 176 with
    // the route mounted before this literal moved.
    // 177 → 180: the billing reconciler's two `unauthenticated` cron doors (`GET
    // /internal/billing/self-check` dry-run + `…/run` apply — see their UNAUTHENTICATED entries)
    // and `DELETE /messages/:id` (`work` + idempotent — the junk/trash delete, a mutation on the
    // caller's own mailbox, correctly in the GATED remainder). Their commits (2026-08-23/24) did
    // not move this literal, so the census sat red for a day — watched red at 177 with all three
    // mounted before it moved, which is the census working, late.
    // 180 → 183: the Junk window's three routes (2026-08-24) — `GET /screener/junk`,
    // `GET /screener/junk/body`, `POST /screener/junk/rescue`, all `connection` class (they
    // open an admission-capped IMAP socket to the caller's own provider), so all three join
    // the GATED remainder below: an unverified account cannot make this service dial a mail
    // server. Watched red at 180 with the routes mounted before this literal moved.
    // 183 → 184: `POST /sync/pull` (2026-08-26) — the worker doorbell behind the "Pull new
    // mail" affordance. `work`, so it moves the gated identity below by one as well.
    // 184 → 189: the folder VERBS (FOLDERS-SPEC.md stage 2, 2026-08-26) — `POST /folders`,
    // `PATCH /folders/:id`, `DELETE /folders/:id`, `DELETE /folders/:id/op` (all `work`: each
    // records a user command in `folder_ops` that the worker executes against the caller's own
    // mail server) and `GET /folders/:id/summary` (`read` — see its READ entry). Four join the
    // gated remainder, one the exempt set. Watched red at 184 with the routes mounted before
    // this literal moved.
    // 189 → 192: the Junk window's §16.2 extras (2026-08-27) — `GET /screener/junk/search`
    // (`connection`: one server-side SEARCH per junk folder, the list's dial discipline),
    // `GET /screener/junk/sweep` (`read` — see its READ entry) and `POST /screener/junk/sweep`
    // (`work`: it records the one-time sweep command the worker executes). Two join the gated
    // remainder, one the exempt set. Watched red at 189 with the routes mounted before this
    // literal moved.
    // 192 → 195: Send later (mail 0077, 2026-08-28) — `POST /drafts/:id/schedule` and
    // `DELETE /drafts/:id/schedule` (both `work`: draft-state transitions that emit a change,
    // no socket, no spend) join the gated remainder; `GET /internal/sends/scheduled/run` (the
    // scheduler's clock, `unauthenticated` — see its entry) joins the exempt set. Watched red
    // at 192 with the routes mounted before this literal moved.
    // 195 → 196: `POST /mailboxes/:id/inbound-quiet/dismiss` (the forwarding-detection notice's
    // dismissal, mail 0078, 2026-08-29) — `work`: one timestamp on the caller's own mailbox row,
    // no socket, no spend, so it joins the GATED remainder below: an unverified account has no
    // notice to dismiss and no business writing rows. Watched red at 195 with the route mounted
    // before this literal moved.
    // 196 → 197: `POST /mailboxes/probe` (the mailbox forms' test action) — `connection`: it
    // opens one IMAP socket to a host the caller typed and writes nothing at all. Not `read`,
    // which would put a mail-server dial inside the set an unproven address may reach, and not
    // `work`, which would claim it stores something. It joins the GATED remainder below. Watched
    // red at 196 with the route mounted before this literal moved.
    // 197 → 198: `GET /internal/sends/reconcile/run` (the reconciler for stranded send
    // reservations) — `unauthenticated`, so it joins the EXEMPT set and the gated remainder below
    // is arithmetically unchanged, the same shape the session reaper and the SIZE back-fill had.
    // Watched red at 197 with the route mounted before this literal moved.
    // 198 → 199: `GET /internal/away/run` (the away responder's clock, mail 0087) —
    // `unauthenticated`: a scheduler's door authorised by a shared secret, resolving no session,
    // on `GET /internal/sends/scheduled/run`'s exact terms. It joins the EXEMPT list above rather
    // than the gated remainder, so this total and `UNAUTHENTICATED.length` move together.
    // 199 → 200: `GET /admin/accounts/:id/ledger` (the credit drill-down, cloud 0028) —
    // `unauthenticated`, so it joins the EXEMPT list above and this total together and the gated
    // remainder below is arithmetically unchanged. That is the check worth having on it: the
    // `/admin/*` table resolves no customer session at all, so a route there landing in a GATED
    // class would mean the gate had an account to judge, which would be the surprise.
    // 200 → 202 is the 0.14.1 pair on `mailboxes`: `POST /mailboxes/:id/organizer-notice/dismiss`
    // and `POST /mailboxes/:id/release`, both `work`. BOTH numbers move by two, and that is the
    // whole report on them: neither is exempt, so the gated remainder grows exactly as the table
    // does.
    //
    // `work` and NOT `connection` for the release, which is the classification worth stating
    // because the reflex is to mirror `POST /mailboxes/:id/organize` beside it. That route is
    // `connection` because it MAY DIAL — the ceremony can carry a mailbox password and proves it
    // against the customer's provider. This one opens no socket and can open none: the claim it
    // asks to give up lives in the customer's IMAP folder, and expunging it is the organizer's own
    // next pass rather than this request's. Neither route reads a body, a query or anything but
    // the id, which is what puts both of them in `PATH_PARAMS_ONLY` next door.
    //
    // NEITHER CARRIES STEP-UP, and the release's absence is the deliberate asymmetry. A second
    // factor guards the direction that TAKES CONTROL of somebody's mail; this direction gives it
    // up, keeps every credential and every message, and is reversible with one press of the button
    // beside it. Gating it would mean a person who has lost their second factor cannot stop a
    // machine from filing their mail — a lockout of exactly the shape 0.14.1 exists to remove.
    //
    // 202 → 203: `GET /internal/billing/invoices/reconcile/run` (the invoice mirror's heal, cloud
    // 0029) — `unauthenticated` on the two reconciliation doors' exact terms, so it joins the
    // EXEMPT list above and this total together and the gated remainder is arithmetically
    // unchanged. Watched red here before the literal landed.
    //
    // 203 → 205: `GET /internal/platform-costs/run` (the cost clock) and
    // `POST /admin/platform-costs` (the manual entry), both `unauthenticated` — so they join the
    // EXEMPT list above and this total together, and the gated remainder is arithmetically
    // unchanged. That is the check worth having on the second one: it is a WRITE reached with a
    // shared secret, and the number confirming the gated side did not move is the arithmetic
    // saying its authority is a staff session rather than an account this gate could judge.
    // 205 → 206: `GET /admin/costs` (the cost board, cloud 0029) — `unauthenticated` on the
    // other eight admin reads' terms, so it joins the EXEMPT list above and this total together
    // and the gated remainder is arithmetically unchanged.
    //
    // The three slices met in one window, so the total moves by SIX across them and the halves
    // move independently: two gated routes (0.14.1), then four exempt ones (the invoice heal,
    // the cost clock, the manual entry, the cost board). The remainder below is what says so.
    //
    // 206 → 207: `GET /internal/platform-signals/run` (the 5xx poll, cloud 0030) —
    // `unauthenticated` on the cost clock's exact terms, so it joins the EXEMPT list above and
    // this total together and the gated remainder is arithmetically unchanged. The "An unverified account must not be able to generate meaningful cost" invariant's count
    // of unauthenticated internal routes moves with it. Watched red here before the literal
    // landed.
    // 207 → 208: `GET /mailboxes/:id/profile` (mail 0094, the mirrored-settings read). It is
    // `read`, so it enters `READ` and this total TOGETHER and the gated remainder below is
    // arithmetically unchanged — the check worth having on a route that returns an account's own
    // configuration: the question is whether a settings read slipped into a gated class or, worse,
    // whether something gated slipped out, and the two numbers moving by different amounts is what
    // would say so. Watched red here before the literal landed.
    // 208 → 209: `POST /drafts/:id/resolve` (mail 0095, the answer a person gives for a send this
    // server could not confirm). It is `work`, so it enters the GATED REMAINDER and none of the
    // three exempt lists — BOTH this literal and the remainder below move by one, which is the
    // reading worth having on a route that settles a message's fate: the question is whether a
    // write slipped into an exempt class, and two numbers moving by different amounts is what
    // would say so. Watched red here before the literal landed.
    
    //
    // 209 → 210: `POST /messages/:id/restore` (mail 0099) — put a deleted message back where it
    // was. `cost: "work"`, the class every desired-state write here already carries: it writes
    // rows for the caller's own account and queues an IMAP move for the organizer, opening no
    // socket and calling no metered third party. It is neither unauthenticated nor a ceremony
    // route, so the GATED remainder below moves with this total rather than staying put.
    // 210 → 211: `POST /account/manage-link` — the way back to paying from an account the
    // entitlements seam has refused. `cost: "paid"`, so it is not exempt and the gated remainder
    // below moves with this total rather than staying put.
    // 211 → 212: `GET /account/access` — the client-facing read of the entitlements verdict, so
    // the mailbox pane can refuse a connect it knows will be refused. `cost: "read"`, so it is
    // exempt: this literal and the READ list both move by one and the GATED remainder below
    // STAYS PUT, which is the arithmetic that says the route did not slip into a gated class.
    // 212 -> 197 AT THE BOUNDARY: fifteen routes left with the money — the plan read and its
    // webhook, three admin money reads, the two account-standing writes, the cost recorder and
    // its clock, and the reconcile arms. RE-DERIVED from the table at this tip, and EVERY ONE of
    // the fifteen is also gone from an exempt list below, which is the reading: a route that had
    // left the table while staying on an exempt list would be a name nothing serves, and one that
    // left a list while staying in the table would be a door this gate no longer covers.
    // 197 -> 200 WITH THE TRASH WINDOW's three READS (`GET /trash/window`, `/window/body`,
    // `/window/search`) — a live, un-mirrored view of the provider's own \Trash, the shape the
    // Junk window already has. All three are `cost: "connection"`, which is what a route that
    // DIALS the user's mail server declares, and none of them is unauthenticated, a ceremony or
    // `read` — so this total and the GATED remainder below move by THREE together. The lane wrote
    // this as 210 -> 213; the base it landed on had already gone 210 -> 212 -> 197 with the money
    // routes, so the number is RE-DERIVED from the table at this tip rather than carried over.
    // 200 -> 201: `POST /internal/fault` (cloud 0033) — the deliberate-5xx probe. It enters the
    // UNAUTHENTICATED class above, so the GATED REMAINDER below is arithmetically unchanged: the
    // total and that list move by one together. RE-DERIVED from the table at this tip (the lane
    // wrote 209 -> 210 over a base the money routes had not yet left).
    // 201 -> 203: the native authorize ceremony became two gestures instead of one acting GET —
    // `GET /oauth/authorize/request` (`read`) and `POST /oauth/authorize` (`ceremony`). Both enter
    // permissive classes, so the GATED REMAINDER below is arithmetically unchanged and only this
    // total and the two exempt lists move.
    // 203 -> 205 with mail 0107: the held-release pair. The GET is `read` and joins the exempt
    // list below; the POST is `work` and joins the gated remainder, so the two move by one each.
    // RE-DERIVED from the table at this tip — both pairs are in it.
    // 205 -> 206: `GET /internal/unsubscribe/drain` — `unauthenticated`
    // on the away clock's and the send reconciler's exact terms, a scheduler's door behind a
    // shared secret that resolves no session, so it joins the EXEMPT list above and this total
    // together and the gated remainder below is arithmetically unchanged.
    // 206 -> 208 with cloud 0036: `POST /admin/staff/step-up` and `POST /admin/staff/totp/reset`.
    // Both are `unauthenticated` staff-identity routes and both join the EXEMPT list above, so
    // this total and that list move by two together and the gated remainder is unchanged.
    // 208 -> 209 is `POST /screener/held-releases/dismiss` (FIX-021, `work`), and BOTH numbers
    // move by one: it writes the account's own dismissal record, so it grows the gated remainder
    // exactly as the table grows — the arithmetic saying "not now" did not slip into an exempt
    // class.
    // 209 -> 211 with the wall (cloud 0040): `GET /internal/account-lifecycle/run`
    // (`unauthenticated` on the away clock's exact terms, a scheduler's door behind a shared
    // secret resolving no session) and `GET /account/export` (`read`, the export door open under
    // the wall). Both join the EXEMPT lists above and this total together, and the gated
    // remainder below is arithmetically unchanged.
    // 211 -> 213 with the undecided-sender pair: the GET is `read` and joins the exempt list
    // above, the POST is `work` and joins the gated remainder, so the two move by one each.
    // 213 -> 214: `GET /drafts/:id/send-attempt`, a `read`. 214 -> 219 with cloud 0042's desktop
    // approval: four `ceremony` routes and one `read`, all on the exempt lists above, so the gated
    // remainder is arithmetically unchanged.

    // 219 -> 220: `GET /messages/timeline`, a `read`, on the exempt list above.
    // 220 -> 221: `POST /mailboxes/:id/profile-import/replace`, a `work` route, gated like the
    // decline beside it — no exempt list moves.
    // 221 -> 222: `GET /internal/account-lifecycle/erase`, the sweep's erase door, `unauthenticated`
    // on the run route's terms and on the exempt list above; the gated remainder is unchanged.
    // 222 -> 223: `GET /internal/security-notices/run`, `unauthenticated`, on the exempt list above.
    // 223 -> 224: `GET /mailboxes/:id/profile-import/status`, a `read`, on the exempt list above.
    // 224 -> 225: `POST /pair/state`, a link's state read by its token's hash. `ceremony`, so it
    // joins `CEREMONY` and this total together and the gated remainder is unchanged.
    // 225 -> 226: `GET /mailboxes/:id/self-check`, a `connection` route, gated — no exempt list moves.
    // 226 -> 227: `POST /account/checkout/confirm` (mail 0135's reopening), `paid`, gated — no exempt
    // list moves; it is on the lock's own exemption, which is a different gate.
    // 227 -> 228: `DELETE /screener/junk/rescue/:id`, clearing a refused "Not junk", a `work`
    // route, gated like the rescue beside it — no exempt list moves.
    // 228 -> 233: cloud 0047's three staff reads and two staff routes, all `unauthenticated` and
    // on the exempt list above; the gated remainder is unchanged.
    // 233 -> 235 with mail 0138: the Screener's automatic filing and its put-back. The GET is
    // `read` and joins the exempt list above, the POST is `work` and joins the gated remainder,
    // so the two move by one each.
    // 235 -> 236: `POST /auth/refresh/logout`, the web's sign-out door, a `ceremony`, so it joins
    // `CEREMONY` and this total together and the gated remainder is unchanged.
    // 236 -> 237: `GET /screener/stayed`, the sender sheet's "why did these stay", a `read`, so it
    // joins the exempt list above and this total together.
    // 237 -> 238: `GET /organizer-requests`, what waits on the organizer, a `read`, so it joins the
    // exempt list above and this total together.
    // 238 -> 239: `POST /sends/withdraw`, Cancel asking the server, a `connection` (its stale arm
    // verifies by Sent); gated — no exempt list moves.
    // 239 -> 240: `POST /mailboxes/:id/gap-letters`, the answer to the gap offer, `work`; gated —
    // no exempt list moves.
    // 240 -> 241: `GET /screener/unscreened/count`, what agreeing will screen, a `read`, so it joins
    // the exempt list above and this total together.
    // 241 -> 246: the console's five reads (four GETs and the staff list), each
    // `unauthenticated` on the `/admin/*` table's terms, so they join the exempt list and this
    // total together and the gated remainder is unchanged.
    // 246 -> 247: the billing link, `unauthenticated` like the release; the remainder is unchanged.
    // 247 -> 248: `POST /auth/password`, a `ceremony`, so it joins `CEREMONY` and this total
    // together and the gated remainder is unchanged.
    // 248 -> 252: the alert drills' four routes (cloud 0051), each `unauthenticated`, so they join
    // `UNAUTHENTICATED` and this total together and the gated remainder is unchanged.
    // 252 -> 253: `GET /screener/waiting/count`, the decide step's count, a `read`, so it joins
    // the exempt list above and this total together.
    // 253 -> 256: the waiting filings — the GET is `read` and joins the exempt list above, the two
    // presses are `work` and join the gated remainder.
    // 256 -> 257: `POST /mailboxes/discover`, a `connection` (it makes this process query DNS about
    // a name the caller chose), so it joins the gated remainder.
    expect(apiRoutes).toHaveLength(257);

    for (const r of apiRoutes) {
      expect(ALL_CLASSES, `${key(r)} declares an unrecognised cost ${JSON.stringify(r.cost)}`)
        .toContain(r.cost);
    }
  });

  it("THE EXEMPT SET IS FROZEN — these and only these are reachable unverified", () => {
    // Declared per route and compared by IDENTITY. Never a prefix: `/auth/*` matching is how an
    // unrelated route quietly inherits an exemption, and `POST /auth/verify-email/resend` is on
    // this list for a reason `POST /auth/2fa/totp/verify` would not automatically share.
    expect(of("unauthenticated")).toEqual(UNAUTHENTICATED);
    expect(of("ceremony")).toEqual(CEREMONY);
    expect(of("read")).toEqual(READ);

    // …and the permissive classes are exactly these three. A seventh class added to the union
    // without a decision about this gate fails here rather than defaulting either way.
    expect([...UNVERIFIED_MAY_REACH].sort()).toEqual(["ceremony", "read", "unauthenticated"]);

    // The gated remainder is the complement, and it is not a rounding error.
    const gated = apiRoutes.filter((r) => !unverifiedMayReach(r.cost));
    // 123 → 129 → 130 → 131 → 136 → 141 → 143, and the arithmetic is the whole table, not any one
    // change's routes. `GET /img` was unmounted, five `/tags` routes were mounted (one `read`, four
    // `work`), `POST /screener/suggest` was mounted (`work`), and so were the five
    // `/admin/staff/*` sign-in routes AND the two `/admin/accounts/{suspend,resume}` writes (all
    // seven `unauthenticated`). The number is a measurement of `apiRoutes` and must agree with the
    // `toHaveLength` above it — a literal that drifts from that one makes this a tautology.
    //
    // 144 → 146: the organizer handoff mounted `GET /mailboxes/:id/organizer` (`connection`) and
    // `POST /mailboxes/:id/takeover` (`work`). BOTH numbers move by two, and that is the whole
    // report on this pair: neither is exempt, so the gated remainder grows exactly as the table
    // does. The GET is `connection` and not `read` deliberately — it opens an IMAP socket to the
    // user's provider, and `read` would have put a mail-server dial inside the set an account with
    // an unproven address may reach.
    // Note the gated count is UNCHANGED by that change, and unchanged again by mail 0039's
    // `POST /admin/mailboxes/resync`: every new route is exempt, so it enters the left-hand
    // literal and `UNAUTHENTICATED` together. A slice that moved the two numbers by different
    // amounts would be mounting something this gate has an opinion about — which is exactly the
    // question worth asking of an admin write that touches a customer's mailbox, and the answer
    // is that its authority is a shared secret plus a live staff session, never an account.
    // 146 → 147 is `PATCH /consent/settings`, and BOTH numbers move by one: it is `work`, so the
    // gated remainder grows exactly as the table does. That is the arithmetic saying the opt-in
    // did not slip into an exempt class — the check worth having, since the whole feature is a
    // permission to spend and an exempt spender-arming route is the shape the "An unverified account must not be able to generate meaningful cost" invariant forbids.
    // 147 → 150: `GET /admin/funnel` (the inherited omission, `unauthenticated`) plus the screening
    // pair (`GET` read, `PATCH` work). The gated remainder grows by exactly one — the PATCH — which
    // is the arithmetic confirming the settings write did NOT slip into an exempt class.
    // 151 → 152 is the bootstrap reader's `GET /sync/snapshot`, and ONLY the left-hand literal moves: it is `read`,
    // so it enters `READ` and the total together and the gated remainder is arithmetically
    // unchanged. That is the check worth having on a route which, of everything in this table,
    // returns the most of an account's own data in one response — the question is whether a
    // bootstrap slipped into an exempt class by accident, and the answer is that it is the same
    // class as the `/sync` it bootstraps for.
    // 154 → 159 (cloud 0009's five). The gated remainder grows by exactly TWO — `start` and
    // `complete` — because the other three are `unauthenticated` and enter the left-hand literal and
    // `UNAUTHENTICATED` together. Both numbers moving by different amounts is the arithmetic saying
    // the consent ceremony did not slip into an exempt class.
    // 159 → 160 is the capability read `GET …/oauth/microsoft/availability` (`read`), and ONLY the
    // left-hand literal moves: it enters `READ` and the total together, so the gated remainder is
    // arithmetically unchanged — the check confirming a deployment-fact read did not become gated.
    // 160 → 161 is `POST /attachments/staging` (`work`), and BOTH literals move by one — the
    // arithmetic saying the upload mint did not slip into an exempt class. It is the shape this
    // gate exists for: a route whose cost is not a query or a socket but an object in a bucket,
    // which no amount of reading the verb or the path would reveal.
    // 161 → 162 is `GET /hello` (`unauthenticated`), entering the left-hand literal and
    // `UNAUTHENTICATED` together; the gated remainder is arithmetically unchanged.
    // 162 → 165 are the three profile-import routes (two `connection`, one `work`), and BOTH
    // numbers move by three: none is exempt, so the gated remainder grows exactly as the table
    // does — the arithmetic saying the import surface did not slip a mail-server dial or a
    // rules-rewriting write into the set an unverified account may reach.
    // 165 → 169 is the pairing ceremony (managed device pairing), and ONLY the left-hand
    // literal moves: all four routes enter exempt classes (two `ceremony`, one `read`, one
    // `unauthenticated`), so the gated remainder is arithmetically unchanged. That is the
    // check worth having on this mount: nothing in the ceremony does work, opens a socket or
    // calls a model — it is identity lifecycle end to end — and a pairing route that had
    // landed in a gated class would be a sign it started spending.
    // 169 → 170 is `GET /push/vapid-key` (`read`), and ONLY the left-hand literal moves: it enters
    // `READ` and the table total together, so this identity's right-hand side is unchanged and the
    // gated remainder is too. That is the arithmetic making the claim rather than a comment making
    // it — the deployment-fact read did not become gated, and nothing gated became exempt.
    // 170 → 175 is the DEVICES slice (three step-up re-verifies + the bulk web-session revoke,
    // all `ceremony`; the reaper cron, `unauthenticated`), and ONLY the left-hand literal moves:
    // all five enter exempt classes and their lists together, so the gated remainder is
    // arithmetically unchanged. That is the check worth having on this mount: nothing in it
    // does work, opens a socket or calls a model — it is credential lifecycle end to end — and
    // a step-up or revocation route that had landed in a gated class would be an unproven
    // address locked OUT of taking its own credentials back, the inverse of what this gate is
    // for.
    // 175 → 176 is `POST /billing/addons`, and this time the GATED side moves: `paid` is the
    // right class for a card-on-file mutation, so the left-hand literal and the remainder move
    // together and the exempt lists do not.
    // 176 → 177 is `GET /internal/mailboxes/smtp-size`, and the gated side does NOT move: the
    // route is `unauthenticated`, so the total and the exempt list step together and the
    // remainder is arithmetically unchanged — the session reaper's shape exactly.
    // 177 → 180 is the reconciler's two `unauthenticated` cron doors (total and exempt step
    // together) plus `DELETE /messages/:id` (`work`), which moves the GATED remainder by one —
    // the correct side for a mailbox mutation, exactly like `POST /billing/addons` before it.
    // 180 → 183 is the Junk window's three `connection` routes — the gated side moves by
    // three and the exempt lists do not: a live-IMAP read is exactly what an unverified
    // account must not be able to trigger.
    // 183 → 184 is `POST /sync/pull` (`work`), and BOTH sides move by one: it rings the worker's
    // doorbell (`sync_requested_at`), i.e. it CAUSES a worker-side IMAP scan, which is precisely
    // the paid shape the gate exists to keep away from an unproven address — one bounded batch,
    // but on the paid side of the boundary exactly as its heavier `resync` sibling is.
    // 192 → 195 is Send later: the two schedule verbs (`work`) move the GATED side by two — an
    // unverified account may not park mail for the sender's clock — and the scheduler's cron door
    // is `unauthenticated`, so for it the total and the exempt list step together, the SIZE
    // back-fill's shape exactly.
    // 195 → 196 is `POST /mailboxes/:id/inbound-quiet/dismiss` (`work`), and the GATED side
    // moves by one — the correct side for a mailbox-row mutation, `DELETE /messages/:id`'s shape
    // exactly; the exempt lists do not move.
    // 196 → 197 is `POST /mailboxes/probe` (`connection`), and the GATED side moves by one —
    // the correct side: an account whose address is unproven must not be able to make this
    // service dial a mail server, which is the same argument `GET /mailboxes/:id/organizer`
    // settled. The exempt lists do not move.
    // 197 → 198 is `GET /internal/sends/reconcile/run` (`unauthenticated`), and ONLY the total
    // and `UNAUTHENTICATED` move: the gated remainder is arithmetically unchanged, which is the
    // check worth having on a route that dials a person's mail server on a shared secret — the
    // question is whether it slipped into a class an account could reach, and the answer is that
    // it is a scheduler's door like the two clocks either side of it.
    // 198 → 199 is `GET /internal/away/run` (mail 0087), and BOTH the total and the exempt list
    // step together — the SIZE back-fill's and the send clock's shape exactly. The GATED side does
    // not move, which is the correct answer: the route is a scheduler's door holding a shared
    // secret, and the thing an unverified account must not be able to do (configure a responder
    // that sends mail in their name) is `PUT /away-responder`, which was already gated.
    // 199 → 200 is `GET /admin/accounts/:id/ledger`, and ONLY the total and `UNAUTHENTICATED`
    // move: the gated remainder is arithmetically unchanged, which is the whole report on this
    // mount. Every `/admin/*` route is on the exempt side because none of them resolves a
    // customer session — their authority is a shared secret plus a live staff session — so the
    // number worth watching here is that the gated side did NOT move.
    // 200 → 202: the 0.14.1 dismiss/release pair, both `work` — see the note above the table
    // total. The GATED side moves by two with it, which is the arithmetic saying neither slipped
    // into an exempt class: an unverified address must not be able to decide who organizes a
    // mailbox, in either direction.
    // 202 → 203 is `GET /internal/billing/invoices/reconcile/run` (cloud 0029), and ONLY the
    // total and `UNAUTHENTICATED` move: the gated remainder is arithmetically unchanged. That is
    // the check worth having on a route that reaches the private billing plane on a shared secret
    // — the question is whether a pass that writes the revenue mirror slipped into a class an
    // account could reach, and the answer is that it is a scheduler's door like the subscription
    // reconciler beside it.
    // 203 → 205 is the cost clock plus the manual cost entry (cloud 0029), and ONLY the total
    // and `UNAUTHENTICATED` move: the gated remainder is arithmetically unchanged.
    // 206 → 207 is `GET /internal/platform-signals/run`, the same shape again: total and
    // `UNAUTHENTICATED` move together, so this subtraction is unchanged and that is the check.
    // 205 → 206 is `GET /admin/costs`, the same shape: total and `UNAUTHENTICATED` move together,
    // the gated remainder does not.
    //
    // 200 → 206 across all three slices, and the identity is what separates them: the total grew
    // by six, the exempt lists by four, and the gated remainder by two — the 0.14.1 pair, and
    // nothing this money slice mounted. A slice that moved the two sides by the same amount would
    // be mounting something this gate has an opinion about.
    // 210 → 211 with the manage link, and BOTH numbers move by one: it is `paid`, so the gated
    // remainder grows exactly as the table does — the arithmetic saying the one route a refused
    // account may still reach did not slip into an exempt class. It is named per route in
    // `ACCESS_REFUSED_MAY_REACH_ROUTES`, which is a different gate from this one.
    // 211 → 212 with the access read, and this is the case the paragraph above contrasts: the
    // total moves by one, READ moves by one, and the remainder does not move at all.
    // 212 -> 197 AT THE BOUNDARY, and this subtraction is the reading rather than the total: the
    // fifteen routes that left were ALL exempt-class doors (thirteen `unauthenticated`, one
    // `read`, one `ceremony`), so both sides move by fifteen and the GATED REMAINDER is
    // arithmetically unchanged. A money slice that had taken a gated route out with it would
    // show here as two numbers moving by different amounts.
    // 197 -> 200 with the Trash window, and BOTH numbers move by three: all three routes are
    // `connection`, on no exempt list, so the gated remainder grows exactly as the table does.
    // That is the reading on doors that open a socket to somebody's mailbox — two numbers moving
    // by different amounts would say a dialling route had slipped into an exempt class.
    // 200 -> 201 with the fault probe, and the remainder does NOT move: the probe is
    // `unauthenticated`, so the total and that list grow by one each. A probe that had landed in
    // a gated class would show here as two numbers moving by different amounts.
    // 201 -> 203 with the authorize ceremony's split, and the remainder does NOT move: one new
    // route is `read` and the other `ceremony`, so the total and those two lists grow by one each.
    // A confirmation that had landed in a gated class would show here as two numbers moving by
    // different amounts.
    // 203 -> 205 with mail 0107's held-release pair: the GET is `read` and enters `READ`, the
    // POST is `work` and enters the gated remainder, so the two numbers move by one each — which
    // is this arithmetic saying the PRESS did not slip into an exempt class. A press that re-opens
    // a rule's backlog is exactly the shape that must stay gated.
    // 205 -> 206 with the screened-out unsubscribe drain, and the remainder does NOT move: the
    // drain is `unauthenticated`, so the total and that list grow by one each. A scheduler's door
    // that had landed in a gated class would show here as two numbers moving by different amounts.
    // 206 -> 208 with cloud 0036's staff step-up and second-factor recovery, and the remainder
    // does NOT move: both are `unauthenticated`, so the total and that list grow by two each.
    // 208 -> 209 with FIX-021's held-release dismiss, and the remainder MOVES: `work`, gated, the
    // same arithmetic as the press it sits beside.
    // 211 -> 213 with the undecided-sender pair: the GET is `read` and enters `READ`, the POST is
    // `work` and enters the gated remainder, so the two numbers move by one each — this arithmetic
    // saying the press that moves somebody's mail did not slip into an exempt class.
    // 213 -> 214 with `GET /drafts/:id/send-attempt`, and the remainder does NOT move: `read`,
    // so the total and `READ` grow by one each.
    // 214 -> 219 with cloud 0042's desktop approval, and the remainder does NOT move: four
    // `ceremony` and one `read`, so the total and those two lists grow together.

    // 219 -> 220 with `GET /messages/timeline`, a `read`: the total and `READ` grow by one each,
    // the remainder does not move.
    // 220 -> 221 with the profile replace, and the remainder MOVES: `work`, gated, as the decline.
    // 221 -> 222 with the lifecycle erase door, `unauthenticated`: the total and that list grow by
    // one each, the remainder does not move.
    // 222 -> 223 with `GET /internal/security-notices/run`, `unauthenticated`: the total and that
    // list grow by one each, the remainder does not move.
    // 223 -> 224 with the profile-import status read, a `read`: the total and `READ` grow by one
    // each, the remainder does not move. At 224 the candidate read moves `connection` -> `read`:
    // `READ` grows by one and the remainder falls by one.
    // 224 -> 225 with `POST /pair/state`, a `ceremony`: the total and `CEREMONY` grow by one each,
    // the remainder does not move.
    // 225 -> 226 with the self-check, and the remainder MOVES: it dials, so `connection`, gated.
    // 226 -> 227 with the checkout confirm, and the remainder MOVES: `paid`, so gated for an
    // unverified address exactly like the manage link beside it.
    // 227 -> 228 with clearing a refused "Not junk", and the remainder MOVES: `work`, gated.
    // 228 -> 233 with cloud 0047's five staff routes, all `unauthenticated`: the remainder does
    // not move.
    // 235 -> 236 with the web's sign-out door, a `ceremony`: the total and `CEREMONY` grow by one
    // each, the remainder does not move.
    // 236 -> 237 with the sender sheet's "why did these stay", a `read`: the total and `READ` grow
    // by one each, the remainder does not move.
    // 237 -> 238 with what waits on the organizer, a `read`: the total and `READ` grow by one each,
    // the remainder does not move.
    // 238 -> 239 with the send withdraw, and the remainder MOVES: `connection`, gated, as the send.
    // 239 -> 240 with the gap offer's answer, and the remainder MOVES: `work`, gated.
    // 240 -> 241 with what agreeing will screen, a `read`: the total and `READ` grow by one each, the
    // remainder does not move.
    // 241 -> 246 with the console's five reads, `unauthenticated`: the total and `UNAUTHENTICATED`
    // grow by five each, the remainder does not move.
    // 246 -> 247 with the billing link, `unauthenticated`: the remainder does not move.
    // 247 -> 248 with the password change, a `ceremony`: the total and `CEREMONY` grow by one
    // each, the remainder does not move.
    // 248 -> 252 with the alert drills' four routes, `unauthenticated`: the total and
    // `UNAUTHENTICATED` grow by four each, the remainder does not move.
    // 252 -> 253 with the decide step's waiting count, a `read`: the total and `READ` grow by one
    // each, the remainder does not move.
    // 253 -> 256 with the waiting filings: the GET joins `READ`, the two presses grow the
    // remainder by two.
    // 256 -> 257 with the mail-domain lookup, a `connection`: the remainder grows by one.
    expect(gated.length).toBe(257 - UNAUTHENTICATED.length - CEREMONY.length - READ.length);

    expect(gated.length).toBeGreaterThan(50);
  });

  it("an ANONYMOUS route is `unauthenticated`, and an `unauthenticated` route is public", () => {
    // ANONYMOUS_PIPELINE never resolves a session, so `withSpendGate` cannot fire inside it —
    // asserting the middleware is present in that chain would pass while enforcing nothing.
    // These two are the actual fence, and they are asserted in BOTH directions so neither
    // "an anonymous route quietly starts spending" nor "a session-bearing route claims to be
    // unauthenticated" is representable.
    for (const r of apiRoutes) {
      if (r.options?.anonymous) {
        expect(r.cost, `${key(r)} resolves no session, so it cannot be gated`).toBe("unauthenticated");
      }
      if (r.cost === "unauthenticated") {
        expect(r.options?.public, `${key(r)} claims no user session decides anything`).toBe(true);
      }
    }
  });

  it("THE OLD OPT-IN FLAG CANNOT COME BACK", () => {
    // A deleted interface field does not stop anyone re-adding one, and `verifiedEmail: true` on
    // a route would now read as a gate while doing nothing at all — the worst of both. Asserted
    // over the SOURCE TEXT for the reason the guard is: TypeScript is perfectly happy for a
    // second, parallel mechanism to exist beside the first.
    const dir = new URL("../src/", import.meta.url);
    const hits: string[] = [];
    const walk = (rel: string): void => {
      for (const e of readdirSync(new URL(rel, dir), { withFileTypes: true })) {
        if (e.isDirectory()) { walk(`${rel}${e.name}/`); continue; }
        if (!e.name.endsWith(".ts")) continue;
        const text = readFileSync(new URL(`${rel}${e.name}`, dir), "utf8");
        text.split("\n").forEach((line, i) => {
          if (/verifiedEmail/.test(line)) hits.push(`src/${rel}${e.name}:${i + 1}`);
        });
      }
    };
    walk("");
    expect(hits, "a second verification mechanism reappeared beside `cost`").toEqual([]);
  });
});

describe("the gate, over HTTP, on every route it governs", () => {
  /**
   * The whole-table sweep. Modelled on `enrollment-flow.test.ts`'s: one unverified session, a
   * real request per gated route, and the assertion is the SPECIFIC refusal — a 401, a 404 or a
   * 400 would all be "not 200" and none of them would be this gate.
   *
   * `lastTwofaAt` is set so `withStepUp` (which runs first) passes: a step-up refusal on the
   * mailbox and billing routes would mask exactly the thing under test.
   */
  it("EVERY `work` / `connection` / `paid` route answers 403 email_unverified", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, {
      now: FIXED_NOW, lastTwofaAt: FIXED_NOW, emailVerified: false,
    });
    const id = randomUUID();
    const gated = apiRoutes.filter((r) => !unverifiedMayReach(r.cost));
    expect(gated.length, "the sweep is not vacuous").toBeGreaterThan(50);

    for (const route of gated) {
      const path = sweepPath(route, id);
      const res = await H(req(route.method, path, { bearer: s.token }), deps);
      expect(res.status, `${route.method} ${path} (${route.cost})`).toBe(403);
      const body = await res.json() as { error: { code: string } };
      expect(body.error.code, `${route.method} ${path} (${route.cost})`).toBe("email_unverified");
    }
  });

  it("…and the SAME routes stop answering `email_unverified` once the address is proven", async () => {
    // The other half, and the one that stops this file passing for the wrong reason: without it,
    // a gate that refused every request in the table would satisfy the sweep above perfectly.
    // These routes then answer 400/404/402/503 for their own reasons — what matters is that the
    // VERIFICATION refusal is gone, and that the only thing that changed is one timestamp.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const id = randomUUID();

    for (const route of apiRoutes.filter((r) => !unverifiedMayReach(r.cost))) {
      const path = sweepPath(route, id);
      const res = await H(req(route.method, path, { bearer: s.token }), deps);
      if (res.status !== 403) continue;
      const body = await res.json().catch(() => ({})) as { error?: { code?: string } };
      expect(body.error?.code, `${route.method} ${path} still refuses a VERIFIED address`)
        .not.toBe("email_unverified");
    }
  });

  it("`raw` is no longer an escape hatch: the SSE stream and the IMAP byte route refuse", async () => {
    // Named individually because this is the regression that was live: both are `raw`, and
    // RAW_PIPELINE omitted the gate entirely, so neither could be refused however the route was
    // annotated. `GET /events` holds a function with a poll loop; `GET /attachments/:id` opens a
    // socket to somebody's mail server.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, {
      now: FIXED_NOW, lastTwofaAt: FIXED_NOW, emailVerified: false,
    });
    for (const path of ["/events", `/attachments/${randomUUID()}`]) {
      const res = await H(req("GET", path, { bearer: s.token }), deps);
      expect(res.status, path).toBe(403);
      expect((await res.json() as { error: { code: string } }).error.code, path).toBe("email_unverified");
    }
  });

  it("the reads and the ceremony stay reachable — including the way OUT", async () => {
    // Refusing these would be the gate causing the harm it exists to prevent. `resend` is the
    // only path to verification; `GET /auth/session` is what the wizard derives its step from;
    // `DELETE /account` is an Art. 17 right that may not be withheld from somebody who mistyped
    // their own address and can therefore never verify.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, {
      now: FIXED_NOW, lastTwofaAt: FIXED_NOW, emailVerified: false,
    });
    const open: Array<[string, string]> = [
      ["GET", "/auth/session"], ["GET", "/mailboxes"], ["GET", "/sync"],
      ["GET", "/billing/subscription"], ["GET", "/account/ai"],
    ];
    for (const [method, path] of open) {
      const res = await H(req(method, path, { bearer: s.token }), deps);
      expect(res.status, `${method} ${path}`).not.toBe(403);
    }
    const resend = await H(req("POST", "/auth/verify-email/resend", {
      bearer: s.token, headers: { "x-vercel-forwarded-for": "198.51.100.7" }, body: "{}",
    }), deps);
    expect(resend.status).toBe(200);

    // Taking back a password somebody else knows: its own refusal (an empty body), never this gate's.
    const rotate = await H(req("POST", "/auth/password", { bearer: s.token, body: "{}" }), deps);
    expect(rotate.status, "a password change must not be gated on a verification").toBe(400);

    const erase = await H(req("DELETE", "/account", { bearer: s.token, body: "{}" }), deps);
    expect(erase.status, "Art. 17 erasure must not be gated on a verification").toBe(200);
  });
});

describe("route 125: a route that declares nothing is refused", () => {
  /**
   * THE ONE THAT PROTECTS THE ROUTES NOBODY HAS WRITTEN YET.
   *
   * `Route.cost` is required, so the ordinary way to arrive here is a compile error. This is the
   * floor beneath that, and it is not hypothetical: an audit proved that NO test file in this
   * repository is typechecked, so a synthetic route in a test file is exactly the shape the
   * compiler never sees — as is a JavaScript host, and as is a cast.
   *
   * The route is mounted through the real `createApp`, so what is asserted is the pipeline's
   * behaviour and not the predicate's.
   */
  const undeclared = (options?: Route["options"]): Route[] => [{
    method: "POST",
    pattern: "/route-125",
    // Deliberately absent — both required declarations. The cast is the point: this is what a
    // future route that skips them looks like from the middleware's side.
    ...({} as { cost: CostClass; relay: boolean }),
    ...(options ? { options } : {}),
    handler: async () => new Response(JSON.stringify({ spent: true }), {
      status: 200, headers: { "content-type": "application/json" },
    }),
  }];

  it("an UNDECLARED route refuses an unverified account", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, {
      now: FIXED_NOW, lastTwofaAt: FIXED_NOW, emailVerified: false,
    });
    const res = await createApp(undeclared()).handle(
      req("POST", "/route-125", { bearer: s.token, body: "{}" }),
      { ...deps, session: null, idempotency: null },
    );
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("email_unverified");
  });

  it("an undeclared RAW route refuses too — the pipeline is not a way around the default", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, {
      now: FIXED_NOW, lastTwofaAt: FIXED_NOW, emailVerified: false,
    });
    const res = await createApp(undeclared({ raw: true })).handle(
      req("POST", "/route-125", { bearer: s.token, body: "{}" }),
      { ...deps, session: null, idempotency: null },
    );
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("email_unverified");
  });

  it("a MISSPELLED class is treated as undeclared, not as permission", async () => {
    // `"reads"`, `"Read"`, a class renamed in the union but not in a route — every one of them
    // is a string the predicate does not recognise, and the answer to "I do not recognise this"
    // must be refusal.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, {
      now: FIXED_NOW, lastTwofaAt: FIXED_NOW, emailVerified: false,
    });
    const routes = undeclared();
    routes[0]!.cost = "reads" as CostClass;
    const res = await createApp(routes).handle(
      req("POST", "/route-125", { bearer: s.token, body: "{}" }),
      { ...deps, session: null, idempotency: null },
    );
    expect(res.status).toBe(403);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("email_unverified");
  });

  it("and the same undeclared route is served to a VERIFIED account", async () => {
    // So the guard above is measuring the verification state and not simply refusing everything
    // that has no `cost`. An undeclared route is a mistake to be caught by the compiler; it is
    // not a reason to break a proven account.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await createApp(undeclared()).handle(
      req("POST", "/route-125", { bearer: s.token, body: "{}" }),
      { ...deps, session: null, idempotency: null },
    );
    expect(res.status).toBe(200);
  });
});

describe("the requirement is a COMPOSITION POLICY, and its absence is the strict answer", () => {
  /**
   * `requireVerifiedForProduct` moved the QUESTION to the composition root without moving the
   * DEFAULT: whether an unproven address may reach the costly classes is something a hosted
   * service and an operator-run server answer differently (on a self-hosted box the IMAP
   * credential proves mailbox ownership and the account email is a login identifier), so each
   * root states its answer — and a root that states nothing gets REQUIRE, because an absent
   * config value must never be the thing that relaxes a gate. Everything above this block ran
   * against deps that never set the field; these four pin the semantics by name.
   *
   * `POST /mailboxes` is the probe route throughout: it is the product action the requirement
   * has always bitten first (the account's first real spend), and driving it to 201 in the
   * relaxed composition proves the seam frees the ACTION, not merely the middleware branch.
   */
  const MAILBOX_BODY = JSON.stringify({
    provider: "imap", address: "mila@lichtgrat.example",
    imap: { host: "imap.example", port: 993, secure: true, user: "mila", pass: "s3cr3t-imap-password-password" },
  });
  const addMailbox = (deps: ApiDeps, token: string): Promise<Response> =>
    H(req("POST", "/mailboxes", { bearer: token, body: MAILBOX_BODY }), deps);
  const code = async (res: Response): Promise<string> =>
    ((await res.json()) as { error: { code: string } }).error.code;

  it("ABSENT ⇒ REQUIRE — a container that never heard of the policy keeps today's gate", async () => {
    // The named pin for what the whole-table sweep above establishes at scale. It exists so the
    // sweep can never be satisfied by a default that quietly inverted: a future edit that makes
    // absence permissive fails HERE by name, not merely somewhere in a 90-route loop.
    const { db, deps } = await makeDeps();
    expect("requireVerifiedForProduct" in deps, "the harness must exercise ABSENCE").toBe(false);
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW, emailVerified: false });
    const res = await addMailbox(deps, s.token);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("email_unverified");
  });

  it("the managed value — explicit `true` — requires, so the hosted wiring cannot drift", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW, emailVerified: false });
    const res = await addMailbox({ ...deps, requireVerifiedForProduct: true }, s.token);
    expect(res.status).toBe(403);
    expect(await code(res)).toBe("email_unverified");
  });

  it("`false` composes the gate OFF — the same route table serves the product action unverified", async () => {
    // Nothing about the ROUTES changes (the frozen census above is byte-identical either way);
    // the composition alone decides. The 201 is the point: the action itself completes, so the
    // seam frees the product and not just one middleware's branch.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW, emailVerified: false });
    const res = await addMailbox({ ...deps, requireVerifiedForProduct: false }, s.token);
    expect(res.status).toBe(201);

    // …and the ceremony/read exemptions above were never the seam's subject: a VERIFIED account
    // through the same relaxed container is served identically (nothing regressed for the
    // ordinary case).
    const v = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const session = await H(
      req("GET", "/auth/session", { bearer: v.token }),
      { ...deps, requireVerifiedForProduct: false },
    );
    expect(session.status).toBe(200);
  });

  it("GARBAGE is not permission — only the boolean `false` relaxes", async () => {
    // A JavaScript composition root that assigns `"false"`, `0` or `null` gets the strict gate,
    // for the reason the cost classes fail closed on a misspelling: the answer to "I do not
    // recognise this" must be refusal.
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW, emailVerified: false });
    for (const garbage of ["false", 0, null] as const) {
      const res = await addMailbox(
        { ...deps, requireVerifiedForProduct: garbage as unknown as boolean }, s.token,
      );
      expect(res.status, `value ${JSON.stringify(garbage)} must not relax the gate`).toBe(403);
      expect(await code(res)).toBe("email_unverified");
    }
  });
});
