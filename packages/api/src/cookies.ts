import type { AuthConfig } from "@trafficflow/services/mail";
// TYPE-ONLY, and deliberately from the full barrel: `OAuthTokens` describes the hosted
// ceremony's response shape. A type import is erased, so this costs the local artifact
// nothing at runtime — it is not a module-graph edge in the emitted JS.
import type { OAuthTokens } from "@trafficflow/services";

/* ── THIS FILE IS THE MINTING HALF OF THE COOKIE SEAM, AND `csrf.ts` IS THE VERIFYING HALF ──
 *
 * Everything here MINTS the browser session for a completed sign-in ceremony, which is the one
 * thing a single-user local install never does. For a long time the boundary was module
 * ABSENCE — the engine bundle did not carry this file, and `csrfTokenFor` moved to `csrf.ts`
 * precisely to keep `middleware.ts` from dragging it in. Phase 3 changed which mechanism holds
 * the line: the desktop-host door mounts `POST /auth/refresh` (`routes/session-lifecycle.ts`),
 * whose COOKIE branch names this module, so the engine artifact now carries it as dead code
 * behind `cookieSurface` — every desktop door composes `allowCookieAuth: false`, which gates
 * cookie ingress and egress alike, and the zero-Set-Cookie census in `desktop-host.test.ts`
 * sweeps the whole door on it. The boundary is the composed gate, not the module graph; what
 * this file must still never gain is a caller that mints outside that gate.
 *
 * Written without a literal `Set-Cookie` string in prose, deliberately: the web client's
 * rewrite suite greps THIS FILE for every backticked cookie assignment
 * and asserts its attributes, so an attacker's cookie quoted in a comment fails that guard —
 * correctly. It has already caught one.
 *
 * A session established before the CSRF derivation changed carries an unrelated `tf_csrf`, and
 * its next mutation therefore answers 403 `csrf_failed` — which `apps/webapp/app/api-client.ts`
 * treats as recoverable (one refresh, one retry), so the refresh re-mints both cookies and the
 * retry succeeds. Bearer callers are exempt from CSRF entirely and are untouched. */

/* THE `Max-Age` OF EVERY COOKIE HERE FOLLOWS `cfg`, AND THAT IS THE ONLY RELATIONSHIP THIS FILE
 * HAS TO SESSION LIFETIMES. `cfg.refreshTtlMs` is the COOKIE surface's rolling window by
 * definition (`packages/services/src/auth/config-types.ts`), so the browser's copy and the
 * `refresh_tokens` row it mirrors are re-issued from the same number on every rotation — the
 * cookie set below is written afresh by each successful `POST /auth/refresh`, which is where
 * "rolling" becomes something a browser can observe. The native surface's longer window never
 * reaches this file: a bearer client is answered with a JSON token pair and no `Set-Cookie` at
 * all, which is why lengthening it could not widen anything here.
 *
 * No ATTRIBUTE changed for any of this, deliberately — the same rewrite suite
 * greps this file for every backticked cookie assignment and asserts `HttpOnly`, `SameSite`,
 * `Secure`, the `tf_refresh` path, and the ABSENCE of `Domain=` — every cookie minted here is
 * host-only, and must stay host-only. A lifetime is a number; the posture is the guard. */
const seconds = (ms: number): number => Math.floor(ms / 1000);

/**
 * The name of the RESUME MARKER — see {@link sessionCookies}. Exported because
 * `apps/webapp/app/session-gate.ts` reads it and the two must not drift.
 */
export const RESUME_COOKIE = "tf_resume";

/**
 * The name of the OWNER MARKER — see {@link sessionCookies}. Exported because
 * `apps/webapp/app/shell/owner-cookie.ts` reads it and the two must not drift.
 */
export const OWNER_COOKIE = "tf_owner";

/**
 * The account-id characters this will put in a cookie value, and nothing else.
 *
 * Two jobs, and the second is the one that matters. It keeps an id whose shape the browser
 * cannot store — anything with a separator, a space, or a newline in it — out of a header we
 * assemble by string concatenation, which is the only way a value could ever become an
 * ATTRIBUTE. And it is applied on BOTH paths: to the account id we mint from, so a future id
 * format that broke this is a cookie that is not set rather than a header that is not what it
 * looks like; and to the value the browser hands back on refresh, which is the only place a
 * value we did not write can enter.
 *
 * `null` means "no marker" and is always a safe answer: the client falls back to asking
 * `GET /auth/session` before it opens anything, which is what every client did before this
 * existed. Account ids are UUIDs today and comfortably inside this set.
 */
const OWNER_SAFE = /^[A-Za-z0-9._~-]{1,128}$/;

export function ownerCookieValue(raw: string | null | undefined): string | null {
  return typeof raw === "string" && OWNER_SAFE.test(raw) ? raw : null;
}

/**
 * The four web session cookies (contract §1.3):
 *  - `tf_session` = access token — HttpOnly, so JS never sees it.
 *  - `tf_refresh` = refresh token — HttpOnly, path-scoped to `/auth/refresh`.
 *  - `tf_csrf`    = CSRF token — NOT HttpOnly (readable by the SPA for the
 *    double-submit header), same lifetime as the access cookie.
 *  - `tf_resume`  = the resume marker. Carries NO credential. See below.
 *
 * The first three are `SameSite=Strict; Secure`. The marker is `Lax`, deliberately.
 *
 * ── WHY A FOURTH COOKIE EXISTS, AND WHY IT IS THE ONLY `Lax` ONE ────────────────────────
 *
 * Two production defects, one shape: **the browser holds a recoverable session and the
 * server is never told.**
 *
 *  1. `tf_session` expires after `accessTtlMs` — fifteen minutes. `tf_refresh` is good for
 *     `refreshTtlMs` (ninety days, rolling), but it is `Path=/auth/refresh`, so a request for
 *     `/` never carries it.
 *     The edge gate therefore sees a browser with no session at all and serves the marketing
 *     page to a signed-in customer. That happened in production: an account created the day
 *     before, intact, and no way back into it.
 *  2. `SameSite=Strict` withholds every cookie on a cross-site top-level navigation. So a
 *     signed-in user clicking an ohmail.app link *from their own mail* is served marketing
 *     even INSIDE the fifteen minutes, with a perfectly live session in the jar.
 *
 * The marker fixes both by telling the edge one bit: "this browser may be able to resume."
 * `Lax` is what makes case 2 work — it is sent on top-level navigations — and it is safe
 * precisely because the marker is not a credential. It authorises nothing, proves nothing,
 * and grants no access; forging it gets an attacker a refresh attempt that fails. It only
 * routes `/` to a splash that tries `POST /auth/refresh`, where the real, Strict,
 * path-scoped refresh token is the only thing that can actually mint a session.
 *
 * The obvious-looking alternatives are both wrong and are written down so they are not
 * retried: lengthening `tf_session`'s Max-Age leaves an expired ACCESS TOKEN in the jar and
 * changes nothing about what the gate can prove; widening `tf_refresh`'s Path so middleware
 * can see it is forbidden by `apps/webapp/next.config.mjs` and would put a live credential on
 * every request to every page, which is the exposure the narrow path exists to prevent.
 *
 * Its lifetime matches the REFRESH token, not the access token: the marker should be present
 * for exactly as long as a resume could succeed.
 *
 * ── AND A FIFTH: WHOSE MAILBOX THIS BROWSER LAST HELD ───────────────────────────────────
 *
 * `tf_owner` carries the account id. It is an IDENTIFIER AND NEVER A CREDENTIAL: it authorises
 * nothing, proves nothing, is read by no handler on any request, and forging it gets an attacker
 * a name for a local database that then fails to be confirmed.
 *
 * It exists because the web client's mail mirror is NAMED for the account it holds — see
 * `packages/client-engine/src/idb.ts` for the cross-account leak that one shared database name
 * produced. The name has to be a server-verified id, so the shell asked `GET /auth/session` and
 * rendered nothing until it answered: a network round trip in front of every first paint, ahead
 * of a mirror that was already on the device and already the right one. This cookie is what lets
 * the browser open that mirror immediately and confirm in parallel, and the confirmation is
 * unchanged — a mismatch or a refusal still tears the engine down.
 *
 * NOT HttpOnly, which is the whole point and is the one attribute that differs from the marker
 * above: the client must READ it. That exposes the account id to same-origin script, which is a
 * non-event — script on this origin can already enumerate `indexedDB.databases()`, where the id
 * is half of every mirror's name, and can already read the mail inside them.
 *
 * Everything else matches the session cookies exactly: HOST-ONLY (no `Domain=`, so it never
 * reaches any subdomain), `Secure`, and the same `SameSite=Strict`. The
 * marker's `Lax` is NOT copied — that widening was bought by the marker's job of routing a
 * cross-site navigation, and this cookie has no such job.
 *
 * Its lifetime matches the refresh token's for the marker's reason: it should be present for
 * exactly as long as this browser could still resume into that mailbox.
 *
 * It is NOT set for an ENROLLMENT session (see {@link enrollmentCookies}), which owns no mailbox
 * to open, and it is not minted at all when the caller cannot name an owner — `owner: null`
 * simply omits it, leaving whatever the jar already holds.
 */
export function sessionCookies(
  tokens: OAuthTokens,
  csrfToken: string,
  cfg: AuthConfig,
  owner: string | null,
): string[] {
  const accessMax = seconds(cfg.accessTtlMs);
  const refreshMax = seconds(cfg.refreshTtlMs);
  const ownerId = ownerCookieValue(owner);
  return [
    `tf_session=${tokens.accessToken}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=${accessMax}`,
    `tf_refresh=${tokens.refreshToken}; HttpOnly; SameSite=Strict; Secure; Path=/auth/refresh; Max-Age=${refreshMax}`,
    `tf_csrf=${csrfToken}; SameSite=Strict; Secure; Path=/; Max-Age=${accessMax}`,
    // Presence-only: the value is a constant and is never read. HttpOnly anyway — nothing in
    // the client needs to see it, and a marker JS cannot touch is a marker XSS cannot plant.
    `${RESUME_COOKIE}=1; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=${refreshMax}`,
    ...(ownerId
      ? [`${OWNER_COOKIE}=${ownerId}; SameSite=Strict; Secure; Path=/; Max-Age=${refreshMax}`]
      : []),
  ];
}

/**
 * The web cookies for an ENROLLMENT-scoped session. Two, not three, and
 * short-lived: `tf_session` carries the enrollment token so the browser's enrollment
 * POSTs authenticate exactly like any other cookie request, `tf_csrf` keeps the
 * double-submit guard in force (CSRF semantics are unchanged), and there is
 * deliberately NO `tf_refresh` — no refresh token exists for an enrollment session,
 * so nothing can extend it past `loginTokenTtlMs`. Attributes are byte-for-byte the
 * ones {@link sessionCookies} uses; only the lifetime differs.
 */
export function enrollmentCookies(enrollmentToken: string, csrfToken: string, cfg: AuthConfig): string[] {
  const max = seconds(cfg.loginTokenTtlMs);
  return [
    `tf_session=${enrollmentToken}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=${max}`,
    `tf_csrf=${csrfToken}; SameSite=Strict; Secure; Path=/; Max-Age=${max}`,
  ];
}

/**
 * The same five cookies with `Max-Age=0` (expire on logout / session death).
 *
 * The marker MUST be cleared here. A logout that left it behind would send the next visit to
 * the resume splash, which would fail (the refresh token is gone) and bounce back to the
 * landing — a slower, flickering way of arriving exactly where logout meant to put them. The
 * attributes must match the set exactly, `SameSite=Lax` included, or the browser treats it as
 * a different cookie and the deletion silently does nothing.
 *
 * The OWNER marker must be cleared for a sharper reason: it is what tells the next visit to open
 * a mirror before asking who is there. Leaving it behind on a shared machine would have the app
 * paint a signed-out person's chrome from a database the sign-out was supposed to end, for the
 * few hundred milliseconds until the session check refused. The web client also clears it and
 * wipes the mirror in the same act, so this is the server half of one decision rather than the
 * only guard — see `apps/webapp/app/sign-out.ts`, which runs even when this request fails.
 */
export function clearSessionCookies(): string[] {
  return [
    "tf_session=; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=0",
    "tf_refresh=; HttpOnly; SameSite=Strict; Secure; Path=/auth/refresh; Max-Age=0",
    "tf_csrf=; SameSite=Strict; Secure; Path=/; Max-Age=0",
    `${RESUME_COOKIE}=; HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=0`,
    `${OWNER_COOKIE}=; SameSite=Strict; Secure; Path=/; Max-Age=0`,
  ];
}
