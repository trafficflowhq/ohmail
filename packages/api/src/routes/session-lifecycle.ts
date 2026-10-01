import { classifyRefreshFailure, type SessionLifecycle } from "@trafficflow/services/auth";
import { ServiceError } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { clearResumeCookie, clearSessionCookies, jarCookie, ownerCookieValue, sessionCookies } from "../cookies.js";
import { csrfTokenFor } from "../csrf.js";
import type { ApiDeps } from "../deps.js";
import { accountErasedResponse, erasedAccountBearer, withSessionAcquireCeiling } from "../middleware.js";
import type { Route } from "../router.js";
import { sessionEnded } from "../session-end.js";
import { cookieSurface, json, noContent, parseCookies, readBody } from "./shared.js";

/**
 * The session lifecycle routes — `/auth/refresh`, `/auth/logout` and the web's sign-out door below
 * the refresh path — carved out of `core.ts` so a composition that runs sessions without the sign-in
 * ceremony can mount them: the hosted service (through `coreRoutes`, exactly where they were) and the
 * desktop-host door, where a paired phone rotates the bearer pair the redeem minted. What a session IS
 * — rotation, reuse detection, family revocation — is `SessionLifecycle`'s; these handlers are
 * transport, mounted by both tables as the same objects so the doors cannot drift. The cookie branches
 * are real code on the hosted surface and dead code on any bearer-only host: `cookieSurface(deps)`
 * reads `allowCookieAuth`, and the zero-Set-Cookie census stands on this gate.
 */

/**
 * The session-lifecycle service from the per-request bag; a misconfigured bag is a clean 500.
 *
 * The narrow sibling of `shared-cloud.ts#auth`: that accessor probes for `login` — a CEREMONY
 * method — because the twenty ceremony routes need the full `AuthService`. These routes need
 * only the machinery half, which every composition fills (`services.auth` is statically a
 * `SessionLifecycle`; the hosted `AuthService` extends it), so probing for the ceremony here
 * would 500 the exact host this module exists for.
 */
export function sessionLifecycle(deps: ApiDeps): SessionLifecycle {
  const svc = deps.services?.auth;
  if (!svc || typeof svc.refresh !== "function") {
    throw new ServiceError("internal", 500, "auth service not configured");
  }
  return svc;
}

/**
 * THE ONE READER OF THE REFRESH COOKIE, in either spelling — a census holds it here, and both doors
 * under the cookie's path ask it. Gated on the cookie surface: a bearer-only host reads no `tf_*`
 * value at all. An empty value is no presentation.
 */
function presentedRefreshCookie(jar: Readonly<Record<string, string>>, deps: ApiDeps): string | undefined {
  const value = cookieSurface(deps) ? jarCookie(jar, "tf_refresh") : undefined;
  return value === "" ? undefined : value;
}

export const sessionLifecycleRoutes: Route[] = [
  {
    // enrollmentOk: abandoning a half-finished enrollment must always be possible. The body's ONE
    // field is handed on alone: the service's refresh-token arm is the sign-out door's below.
    method: "POST",
    pattern: "/auth/logout",
    relay: true,
    cost: "ceremony",
    options: { enrollmentOk: true },
    handler: async (req, deps) => {
      const body = await readBody<{ allDevices?: boolean }>(req);
      await sessionLifecycle(deps).logout(serviceContext(deps, req), { allDevices: body.allDevices });
      return sessionEnded(noContent(cookieSurface(deps) ? clearSessionCookies() : []));
    },
  },
  {
    // THE WEB'S SIGN-OUT. Under `/auth/refresh` because that is the only path `tf_refresh` reaches,
    // and after a renewal whose answer was lost it is the one credential in the jar that still
    // names the live family — `/auth/logout` sees only the replaced access token and 401s before
    // its handler. Revokes that family and the resolved session's (`enrollmentOk`, so a sign-out
    // during enrollment ends that session too); `{ refreshToken }` in the body is the same arm for a
    // bearer client. The jar is cleared on the 204 and on the door's own 401, never on a fault: the
    // retry needs the cookie the fault left in place. A token tells its holder one thing here —
    // whether it was ever minted (204 in any state, 401 never) — and presenting it ends its family.
    method: "POST",
    pattern: "/auth/refresh/logout",
    relay: false,  /* resolves a credential from the request */
    cost: "ceremony",
    options: { public: true, enrollmentOk: true },
    handler: async (req, deps) => {
      let presented = presentedRefreshCookie(parseCookies(req.headers.get("cookie")), deps);
      if (presented === undefined) {
        const body = await readBody<{ refreshToken?: unknown }>(req);
        if (body.refreshToken !== undefined && typeof body.refreshToken !== "string") {
          throw new ServiceError("validation_failed", 400, "refreshToken must be a string");
        }
        presented = body.refreshToken === "" ? undefined : body.refreshToken;
      }
      try {
        await sessionLifecycle(deps).logout(serviceContext(deps, req), { refreshToken: presented });
      } catch (err) {
        if (classifyRefreshFailure(err) !== "session_refused") throw err;
        const refusal = err as ServiceError;
        return sessionEnded(json(
          { error: { code: refusal.code, message: refusal.message } }, refusal.httpStatus,
          cookieSurface(deps) ? clearSessionCookies() : [],
        ));
      }
      return sessionEnded(noContent(cookieSurface(deps) ? clearSessionCookies() : []));
    },
  },
  {
    // Web reads the refresh token from the `tf_refresh` cookie → rotate → set new cookies (204).
    // Native sends `{ refreshToken }` in the body → 200 { tokens }. The cookie branch exists ONLY
    // on a cookie surface: this route is `public`, so `withSession` never gates it, and a
    // bearer-only host must REFUSE the cookie rather than rely on browsers not pointing at it.
    // A sign-in revokes the jar's previous session inside its mint (`webSession`), so a late
    // rotation of that session is refused here as revoked.
    method: "POST",
    pattern: "/auth/refresh",
    relay: false,  /* resolves a credential from the request body */
    cost: "ceremony",
    // A busy pool answers this door fast — see `withSessionAcquireCeiling` — and says a replay is
    // safe: the rotation re-answers a repeated attempt id and converges a cookie retry in its grace.
    options: { public: true, credentialSubject: true, replaySafe: true, middleware: [withSessionAcquireCeiling] },
    handler: async (req, deps) => {
      const jar = parseCookies(req.headers.get("cookie"));
      const cookieRefresh = presentedRefreshCookie(jar, deps);
      if (cookieRefresh) {
        // A REFUSED cookie refresh must clear the jar, not just refuse. The browser is told to
        // resume by `tf_resume`, which outlives a refresh token that has been revoked, rotated
        // past, or reused — without this, such a browser loops through the resume splash on every
        // page load for the marker's whole ninety-day life. Answering the refusal with
        // `clearSessionCookies()` makes the failure self-healing: the marker goes with the rest
        // and the visitor lands on the marketing page, signed out, which is the truth.
        //
        // REFUSED, not FAILED: see the catch — the two are not the same answer.
        try {
          // `concurrentGrace`: this is the cookie surface, where a shared browser jar lets
          // several tabs present one `tf_refresh` at once and the client single-flights refresh
          // only per tab — a duplicate presentation within the grace window is a benign
          // concurrent rotation, not theft, and must not revoke the family. The native branch
          // below does not pass it: a bearer client holds its token privately and rotates
          // serially, so it keeps strict reuse detection (`SessionLifecycle.refresh`). `surface`
          // rides the same branch and picks the rolling window this rotation issues — the
          // browser's, the shorter one — stated rather than left to the default so the pair below
          // reads as a decision.
          const { tokens } = await sessionLifecycle(deps).refresh(
            serviceContext(deps, req), { refreshToken: cookieRefresh },
            { concurrentGrace: true, surface: "cookie" },
          );
          // The `tf_owner` marker is re-stamped here, not minted: `refresh` rotates a token family and
          // resolves no user, so this handler has no account id of its own to write — what it has
          // is the marker the browser already holds, and extending its life is the job: without
          // this, a session renewing for its full ninety days outlives the cookie that makes its
          // next cold start fast. Echoing a client value into a `Set-Cookie` is safe for two
          // reasons together: `ownerCookieValue` refuses anything outside an id-shaped character
          // set (nothing the browser sends can become an attribute), and the value has no
          // authority — it names a local database, is read by no handler, and the client still
          // confirms against `GET /auth/session`. Absent or malformed answers `null`: no cookie
          // set, none cleared.
          return noContent(sessionCookies(
            tokens!, csrfTokenFor(tokens!.accessToken), deps.authConfig, ownerCookieValue(jarCookie(jar, "tf_owner")),
          ));
        } catch (err) {
          /*
           * DECIDED BY THE THROWN VALUE'S CLASS. This answered every failure with one coded 401
           * and `clearSessionCookies()`, so a busy pool or a driver error destroyed the browser's
           * only copy of a token the server still honours — and the client reads a coded 401 here
           * as "your session is gone". A FAULT is rethrown to `withErrorEnvelope` (503 `db_busy`,
           * else 500) with NO `Set-Cookie`, so the token survives and the next attempt spends it;
           * a REQUEST refusal (the cross-account 409) keeps the jar too, its session unjudged.
           * Only a 401 clears it, and the refusal is relayed by NAME rather than flattened into
           * one sentence, so an expiry and a replay are told apart by the client and in the log.
           */
          const failure = classifyRefreshFailure(err);
          if (failure === "fault") throw err;
          // AN ERASED ACCOUNT'S REFRESH is told so, the native branch's rule below: past the access
          // window this is the only door a browser can hear it at. The jar is cleared as for any
          // refusal; `erasedAccountBearer` names the account on `deps`, and `nameTheAccount` stamps it.
          if (failure === "session_refused" && await erasedAccountBearer(req, deps, cookieRefresh)) {
            return sessionEnded(json(
              { error: { code: "account_erased", message: "this account has been deleted" } },
              410, clearSessionCookies(),
            ));
          }
          const refusal = err as ServiceError;
          return sessionEnded(json(
            { error: { code: refusal.code, message: refusal.message } },
            refusal.httpStatus,
            failure === "session_refused" ? clearSessionCookies() : [],
          ));
        }
      }
      // THE NATIVE BRANCH: a bearer client (the desktop app's sidecar, a paired device on the
      // desktop-host door, or the OAuth grant's sibling in `/oauth/token`) presenting its own
      // token in the body. No grace — it rotates serially and a re-presentation is theft — and
      // the LONG rolling window, because this is an installed app that renews on launch rather
      // than a browser sharing a jar. Both arguments are explicit; neither is the default.
      const body = await readBody<{ refreshToken?: string; attemptId?: string }>(req);
      // `attemptId` — the client's name for THIS rotation attempt, repeated on every retry of it.
      // All three bearer clients send it now (the phone, the desktop host client, the sidecar's
      // cloud auth); it stays OPTIONAL because absent is the strict arm the OAuth grant and any
      // older build still take, and that arm is the theft detector. The service bounds it and
      // refuses a malformed one before consuming anything (`readAttemptId`); nothing about it is
      // logged here or there.
      try {
        const { tokens } = await sessionLifecycle(deps).refresh(
          serviceContext(deps, req),
          { refreshToken: body.refreshToken, attemptId: body.attemptId },
          { surface: "native" },
        );
        return json({ tokens }, 200);
      } catch (err) {
        // A jar holding the resume marker and no refresh token sends every visit through the splash
        // until the marker goes, so the answer that finds nothing to rotate takes it with it.
        if (err instanceof ServiceError && err.code === "refresh_missing" && cookieSurface(deps)
          && jarCookie(jar, "tf_resume") !== undefined) {
          return json({ error: { code: err.code, message: err.message } }, err.httpStatus, clearResumeCookie());
        }
        // A refused token of an ERASED account is told so — the session door's rule, for the
        // client that declared it (`erasedAccountBearer`). Anything else travels as it was.
        if (classifyRefreshFailure(err) === "session_refused" && typeof body.refreshToken === "string"
          && await erasedAccountBearer(req, deps, body.refreshToken)) {
          return accountErasedResponse();
        }
        throw err;
      }
    },
  },
];
