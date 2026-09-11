import type { SessionLifecycle } from "@trafficflow/services/auth";
import { ServiceError } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { clearSessionCookies, ownerCookieValue, sessionCookies, OWNER_COOKIE } from "../cookies.js";
import { csrfTokenFor } from "../csrf.js";
import type { ApiDeps } from "../deps.js";
import type { Route } from "../router.js";
import { cookieSurface, json, noContent, parseCookies, readBody } from "./shared.js";

/**
 * The session lifecycle routes — `/auth/refresh` and `/auth/logout`, carved out of `core.ts` so a
 * composition that runs sessions without the sign-in ceremony can mount them: the hosted service
 * (through `coreRoutes`, exactly where they were) and the desktop-host door, where a paired phone
 * rotates the bearer pair the redeem minted. What a session IS — rotation, reuse detection,
 * family revocation — is `SessionLifecycle`'s; these handlers are transport, mounted by both
 * tables as the same objects so the doors cannot drift. The cookie branches are real code on the
 * hosted surface and dead code on any bearer-only host: `cookieSurface(deps)` reads
 * `allowCookieAuth`, and the zero-Set-Cookie census stands on this gate.
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

export const sessionLifecycleRoutes: Route[] = [
  {
    // enrollmentOk: abandoning a half-finished enrollment must always be possible.
    method: "POST",
    pattern: "/auth/logout",
    relay: true,
    cost: "ceremony",
    options: { enrollmentOk: true },
    handler: async (req, deps) => {
      const body = await readBody<{ allDevices?: boolean }>(req);
      await sessionLifecycle(deps).logout(serviceContext(deps, req), body);
      return noContent(cookieSurface(deps) ? clearSessionCookies() : []);
    },
  },
  {
    // Web reads the refresh token from the `tf_refresh` cookie → rotate → set new
    // cookies (204). Native sends `{ refreshToken }` in the body → 200 { tokens }.
    //
    // The cookie branch is reachable ONLY on a cookie surface. This route is
    // `public`, so `withSession` never runs on it and `deps.allowCookieAuth` had no effect
    // here at all: on `api.ohmail.app` a `tf_session` cookie was correctly ignored while a
    // `tf_refresh` cookie still rotated the family and answered with a full set of session
    // cookies. "Bearer-only" has to mean the host REFUSES cookies, not that browsers happen
    // not to point at it — so on such a host the body token is the only accepted input.
    method: "POST",
    pattern: "/auth/refresh",
    relay: false,  /* resolves a credential from the request body */
    cost: "ceremony",
    options: { public: true, credentialSubject: true },
    handler: async (req, deps) => {
      const jar = parseCookies(req.headers.get("cookie"));
      const cookieRefresh = cookieSurface(deps) ? jar["tf_refresh"] : undefined;
      if (cookieRefresh) {
        // A failed cookie refresh must clear the jar, not just refuse. The browser is told to
        // resume by `tf_resume`, which outlives a refresh token that has been revoked, rotated
        // past, or reused — without this, such a browser loops through the resume splash on every
        // page load for the marker's whole ninety-day life. Answering the refusal with
        // `clearSessionCookies()` makes the failure self-healing: the marker goes with the rest
        // and the visitor lands on the marketing page, signed out, which is the truth. Rethrown
        // as 401: the caller must still be told it failed.
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
            tokens!, csrfTokenFor(tokens!.accessToken), deps.authConfig, ownerCookieValue(jar[OWNER_COOKIE]),
          ));
        } catch {
          return json(
            { error: { code: "unauthorized", message: "this session cannot be resumed" } },
            401,
            clearSessionCookies(),
          );
        }
      }
      // THE NATIVE BRANCH: a bearer client (the desktop app's sidecar, a paired device on the
      // desktop-host door, or the OAuth grant's sibling in `/oauth/token`) presenting its own
      // token in the body. No grace — it rotates serially and a re-presentation is theft — and
      // the LONG rolling window, because this is an installed app that renews on launch rather
      // than a browser sharing a jar. Both arguments are explicit; neither is the default.
      const body = await readBody<{ refreshToken?: string }>(req);
      const { tokens } = await sessionLifecycle(deps).refresh(
        serviceContext(deps, req), { refreshToken: body.refreshToken }, { surface: "native" },
      );
      return json({ tokens }, 200);
    },
  },
];
