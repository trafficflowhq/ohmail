import { ServiceError, generateToken } from "@trafficflow/services/mail";
import type {
  AuthService, SessionEstablished, EnrollmentSessionEstablished,
  BillingPlanePort, EntitlementsService, WaitlistService, ProposalsService,
} from "@trafficflow/services";
import type { ApiDeps } from "../deps.js";
import type {} from "../deps-cloud.js";
import { enrollmentCookies, sessionCookies } from "../cookies.js";
import { csrfTokenFor } from "../csrf.js";
import { cookieSurface, json } from "./shared.js";

/**
 * THE HOSTED ACCESSORS — the members of the dependency bag that only a hosted deployment has.
 *
 * `shared.ts` next door reaches into the per-request bag for a service and turns a misconfigured
 * host into a 500 rather than a confusing failure deeper in. Most of those services are the mail
 * half and are the same everywhere. These are not: the identity ceremony, the two paid surfaces,
 * the funnel, and the proposer that calls a model.
 *
 * They lived in `shared.ts`, which meant the module every host compiles named all of them, and the
 * comment there argued that a type-only import made this safe. It does not: erasure decides what
 * ends up in an artifact and says nothing about what a reader of the source can see, or about what
 * a checkout without those modules can compile.
 *
 * The session-cookie helpers move with them for a second reason on top of that one. They mint the
 * browser session for a completed ceremony, and their argument types ARE the ceremony's results —
 * so a local install, which mints one session per launch and runs no ceremony at all, has neither
 * the types nor a use for the functions.
 */

/** The AuthService from the per-request bag; a misconfigured deps is a 500 (not a 401). */
export function auth(deps: ApiDeps): AuthService {
  const svc = deps.services?.auth;
  if (!svc) throw new ServiceError("internal", 500, "auth service not configured");
  return svc;
}

export function proposals(deps: ApiDeps): ProposalsService {
  const svc = deps.services?.proposals;
  if (!svc) throw new ServiceError("internal", 500, "proposals service not configured");
  return svc;
}

/**
 * The billing-plane port and the open entitlements service, or `null` on a deployment that
 * carries no billing configuration (the pair replaced the old in-process billing service).
 *
 * Only the raw webhook route uses these shapes: it has no error envelope above it, so it must
 * turn "unconfigured" into a status itself rather than throw. Every other billing route uses
 * {@link billingPlane} / {@link entitlements}.
 */
export function billingPlaneOrNull(deps: ApiDeps): BillingPlanePort | null {
  return deps.services?.billingPlane ?? null;
}

export function entitlementsOrNull(deps: ApiDeps): EntitlementsService | null {
  return deps.services?.entitlements ?? null;
}

/**
 * The billing-plane port — **503, not 500, when the deployment has no billing config.**
 *
 * This is the poisoned-KEK philosophy applied to billing: a deployment that was never
 * pointed at a billing plane (`BILLING_PLANE_URL` + `BILLING_PLANE_SECRET` — no Stripe
 * credential exists on this host at all) is not broken, it is pre-launch,
 * and the host must stay up and diagnosable. 503 says "this capability is not available here"
 * and leaves `/health` — and every non-billing route — completely unaffected. A 500 would say
 * "we have a bug", which is both false and the wrong thing to page someone about.
 *
 * A PARTIALLY configured deployment never reaches this: `loadHostConfig` throws at cold start
 * (all-or-nothing — half a plane block, or a leftover `STRIPE_*` variable), because a host
 * that answers 503 on the webhook while cheerfully accepting checkouts would take payments it
 * can never turn into credits. The same all-or-nothing law covers the PAIR: a host that arms
 * one of `billingPlane`/`entitlements` without the other is misarmed, and the 503 grammar here
 * is what its routes answer.
 */
export function billingPlane(deps: ApiDeps): BillingPlanePort {
  const svc = deps.services?.billingPlane;
  if (!svc) throw new ServiceError("billing_unconfigured", 503, "billing is not configured on this deployment");
  return svc;
}

/** The open entitlements service — same 503 grammar as {@link billingPlane}. */
export function entitlements(deps: ApiDeps): EntitlementsService {
  const svc = deps.services?.entitlements;
  if (!svc) throw new ServiceError("billing_unconfigured", 503, "billing is not configured on this deployment");
  return svc;
}

/**
 * The WaitlistService — **503, not 500, when the deployment has none.**
 *
 * Same posture as {@link billing}: a host that was never given a waitlist is not broken,
 * it is a host that does not serve the funnel (a native-only surface, a test harness whose
 * subject is something else). The service itself needs no configuration — its MAILER is
 * the optional part, and `WaitlistService` handles that absence internally by recording
 * the signup and reporting `mailed: false` — so `apps/api-vercel` builds one
 * unconditionally and this branch is only reachable on a host that chose not to.
 */
export function waitlistSvc(deps: ApiDeps): WaitlistService {
  const svc = deps.services?.waitlist;
  if (!svc) throw new ServiceError("waitlist_unconfigured", 503, "the waitlist is not available on this deployment");
  return svc;
}

/**
 * Web session response: move the established tokens into the three cookies and
 * STRIP `tokens` from the JSON body (the web session lives in cookies, contract
 * §1.3 / the `SessionEstablished` DTO comment). Any extra fields on `est` (e.g.
 * `recoveryVerify`'s `remainingCodes`) are preserved.
 *
 * On a BEARER-ONLY host the tokens stay in the body and nothing is set: a `Set-Cookie` no
 * browser will ever hold is at best noise, and stripping `tokens` there left the only
 * client that can reach that host — a native one — with a 200 carrying no credential at all.
 */
export function webSession<T extends SessionEstablished>(deps: ApiDeps, est: T): Response {
  if (!cookieSurface(deps)) return json(est, 200);
  // DERIVED from the access token, never random — see `csrfTokenFor`. A value unrelated to the
  // session let a cookie-tossed pair satisfy the double-submit check.
  // The account id rides with them, in a cookie that carries no authority — see `OWNER_COOKIE`
  // in `cookies.ts`. It is read from the session being established rather than from anything the
  // caller sent, which is what makes it a server-verified id and therefore safe to name a local
  // mirror with.
  const cookies = sessionCookies(
    est.tokens!, csrfTokenFor(est.tokens!.accessToken), deps.authConfig, est.user?.accountId ?? null,
  );
  const { tokens: _tokens, ...body } = est;
  return json(body, 200, cookies);
}

/**
 * The `/auth/register` · `/auth/login`-re-entry response: mirror the
 * enrollment token into `tf_session` + `tf_csrf` for the browser AND leave it in the
 * body for a native client. Pre-session the wire carries no client-type signal at
 * all — no cookie, no bearer header, no prior session — so a browser-only or
 * native-only answer would break the other client, and inventing a `client:` body
 * discriminator would be API surface invented for a 5-minute credential whose only
 * power is enrolling the caller's own first factor. See
 * {@link EnrollmentSessionEstablished} for why that is an acceptable exposure and why
 * the FULL session that replaces it still never puts a token in a cookie client's body.
 */
export function enrollmentSession(
  deps: ApiDeps, est: EnrollmentSessionEstablished, status = 200,
): Response {
  // Bearer-only host: the token is already in the body (that is the native shape), so the
  // cookies are the only part that has to go. See {@link cookieSurface}.
  if (!cookieSurface(deps)) return json(est, status);
  return json(est, status, enrollmentCookies(
    est.enrollmentToken, csrfTokenFor(est.enrollmentToken), deps.authConfig,
  ));
}

/**
 * A 2FA-enrollment response that MAY carry the full session exchanged for the
 * caller's enrollment session (the first factor retires it). Transport
 * follows the request: a cookie client gets the three fresh session cookies with
 * `session.tokens` stripped (unchanged invariant); a bearer client keeps the tokens in
 * the body, which is the only place a native client can read them. With no exchange —
 * the ordinary "add another factor" path — the response is unchanged.
 */
export function enrollmentResult<T extends { session?: SessionEstablished }>(deps: ApiDeps, r: T): Response {
  if (!r.session || deps.session?.via === "bearer" || !cookieSurface(deps)) return json(r, 200);
  const cookies = sessionCookies(
    r.session.tokens!, csrfTokenFor(r.session.tokens!.accessToken), deps.authConfig,
    // The enrollment session that is being RETIRED here never carried one (see
    // `enrollmentCookies`); the full session replacing it does, from its own user.
    r.session.user?.accountId ?? null,
  );
  const { tokens: _tokens, ...session } = r.session;
  return json({ ...r, session }, 200, cookies);
}
