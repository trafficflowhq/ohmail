import type { SessionLifecycle } from "@trafficflow/services/auth";
import { ServiceError } from "@trafficflow/services/mail";
import { serviceContext } from "../context.js";
import { clearSessionCookies, ownerCookieValue, sessionCookies, OWNER_COOKIE } from "../cookies.js";
import { csrfTokenFor } from "../csrf.js";
import type { ApiDeps } from "../deps.js";
import type { Route } from "../router.js";
import { cookieSurface, json, noContent, parseCookies, readBody } from "./shared.js";

/**
 * THE SESSION LIFECYCLE ROUTES — `/auth/refresh` and `/auth/logout`, carved out of `core.ts`
 * so a composition that runs sessions WITHOUT the sign-in ceremony can mount them.
 *
 * Two such compositions exist: the hosted service (which mounts these through `coreRoutes`,
 * exactly where they always were — the carve moved the objects, not the behaviour) and the
 * desktop-host door (`routes/desktop-host.ts`), where a paired phone rotates the bearer pair
 * the device-pair redeem minted and signs itself out. What a session IS once it exists — the
 * rotation, the reuse detection, the family revocation — is `SessionLifecycle`'s
 * (`@trafficflow/services/auth`); these two handlers are its transport, and they are mounted by
 * BOTH tables as the SAME objects, so the two doors cannot drift.
 *
 * The cookie branches below are real code on the hosted surface and DEAD code on any bearer-only
 * host: `cookieSurface(deps)` reads `allowCookieAuth`, and a host that composes `false` neither
 * reads a `tf_*` cookie nor writes one — the zero-Set-Cookie census over the desktop-host door
 * stands on exactly this gate.
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
    cost: "ceremony",
    options: { public: true },
    handler: async (req, deps) => {
      const jar = parseCookies(req.headers.get("cookie"));
      const cookieRefresh = cookieSurface(deps) ? jar["tf_refresh"] : undefined;
      if (cookieRefresh) {
        // A FAILED COOKIE REFRESH MUST CLEAR THE JAR, not just refuse.
        //
        // The browser is told to resume by `tf_resume` (see `cookies.ts`), and that marker
        // outlives a refresh token that has been revoked, rotated past, or reused. Without
        // this, such a browser loops: the gate sees the marker, sends it to the resume splash,
        // the splash's refresh is refused, and the next visit does it all again — for the whole
        // ninety-day marker lifetime, on every page load. Answering the refusal with
        // `clearSessionCookies()` makes the failure self-healing: the marker goes with the rest
        // and the visitor lands on the marketing page, signed out, which is the truth.
        //
        // Rethrown as 401 rather than swallowed: the caller must still be told it failed.
        try {
          // `concurrentGrace`: this is the COOKIE surface, where a shared browser jar lets several
          // tabs present one `tf_refresh` at once and the client single-flights refresh only per
          // tab — so a duplicate presentation within the grace window is a benign concurrent
          // rotation, not theft, and must not revoke the family. The native body branch below does
          // NOT pass it: a bearer client holds its token privately and rotates it serially, so it
          // keeps strict reuse detection. See `SessionLifecycle.refresh`.
          //
          // `surface` rides the same branch and chooses the ROLLING WINDOW this rotation issues:
          // the browser's, which is the shorter one. It is stated rather than left to the default
          // — the default is this same value, and saying it here is what makes the pair below
          // (`"native"`) read as a decision instead of an omission.
          const { tokens } = await sessionLifecycle(deps).refresh(
            serviceContext(deps, req), { refreshToken: cookieRefresh },
            { concurrentGrace: true, surface: "cookie" },
          );
          // THE OWNER MARKER IS RE-STAMPED HERE, NOT MINTED. `refresh` rotates a token family and
          // answers tokens; it resolves no user, so this handler has no account id of its own to
          // write. What it does have is the marker the browser already holds, and extending its
          // life is the whole job: without this, a session that keeps renewing for its full
          // ninety days outlives the cookie that makes its next cold start fast, and warm open
          // degrades to the old blocking path with nothing failing anywhere.
          //
          // Echoing a client value into a `Set-Cookie` is safe here for two reasons together, and
          // it would not be for one alone: `ownerCookieValue` refuses anything outside an
          // id-shaped character set, so nothing the browser sends can become an ATTRIBUTE; and the
          // value has no authority to re-stamp — it names a local database, is read by no handler,
          // and the client still confirms it against `GET /auth/session` before trusting a row of
          // what it opens. An absent or malformed marker answers `null`, which sets no cookie and
          // clears none.
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
