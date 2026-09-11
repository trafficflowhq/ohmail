import type { AuthConfig } from "@trafficflow/services/mail";
// TYPE-ONLY, and deliberately from the full barrel: `OAuthTokens` describes the hosted
// ceremony's response shape. A type import is erased, so this costs the local artifact
// nothing at runtime — it is not a module-graph edge in the emitted JS.
import type { OAuthTokens } from "@trafficflow/services";

/* This file is the minting half of the cookie seam; `csrf.ts` is the verifying half.
 * Everything here mints the browser session for a completed sign-in ceremony — the one thing
 * a single-user local install never does. The boundary is the composed gate, not the module
 * graph: every desktop door composes `allowCookieAuth: false`, which gates cookie ingress and
 * egress alike, and the zero-Set-Cookie census in `desktop-host.test.ts` sweeps the whole door.
 * What this file must never gain is a caller that mints outside that gate. Written without a
 * literal Set-Cookie string in prose: the web client's rewrite suite greps this file for every
 * backticked cookie assignment and asserts its attributes. A session from before the CSRF
 * derivation changed answers 403 `csrf_failed` once; the client refreshes and retries. */

/* The `Max-Age` of every cookie here follows `cfg`, and that is this file's only relationship
 * to session lifetimes. `cfg.refreshTtlMs` is the cookie surface's rolling window by
 * definition (`packages/services/src/auth/config-types.ts`); the browser's copy and the
 * `refresh_tokens` row are re-issued from the same number on every successful
 * `POST /auth/refresh`. The native surface's longer window never reaches this file — a bearer
 * client gets a JSON token pair and no Set-Cookie. No attribute changes for any of this: the
 * rewrite suite asserts `HttpOnly`, `SameSite`, `Secure`, the `tf_refresh` path, and the
 * absence of `Domain=` — every cookie minted here is host-only, and must stay host-only. */
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
 * The account-id characters this will put in a cookie value, and nothing else. It keeps an id
 * whose shape the browser cannot store — a separator, a space, a newline — out of a header we
 * assemble by concatenation, the only way a value could become an attribute. Applied on both
 * paths: to the id we mint from (a future id format that broke this is a cookie not set, not
 * a header that lies), and to the value the browser hands back on refresh, the only entry
 * point for a value we did not write. `null` means "no marker" and is always safe: the client
 * falls back to asking `GET /auth/session` first. Account ids are UUIDs, inside the set.
 */
const OWNER_SAFE = /^[A-Za-z0-9._~-]{1,128}$/;

export function ownerCookieValue(raw: string | null | undefined): string | null {
  return typeof raw === "string" && OWNER_SAFE.test(raw) ? raw : null;
}

/**
 * The web session cookies: `tf_session` (access, HttpOnly), `tf_refresh` (HttpOnly, path-scoped
 * to `/auth/refresh`), `tf_csrf` (readable — the SPA sends the double-submit header), all
 * `SameSite=Strict; Secure`; `tf_resume`, deliberately `Lax` — a browser can hold a recoverable
 * session the server is never told about, and the marker is not a credential, living as long as
 * the refresh token (lengthening `tf_session` or widening `tf_refresh`'s Path stay refused); and
 * `tf_owner`, the account id — an identifier, never a credential — so the client opens the
 * account-named mirror immediately (`packages/client-engine/src/idb.ts` records the shared-name
 * leak): not HttpOnly, host-only, `Secure`, `Strict`, never set for an enrollment session.
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
 * The same five cookies with `Max-Age=0` (expire on logout / session death). The marker must
 * be cleared: a logout that left it behind sends the next visit to the resume splash, which
 * fails and bounces to the landing. The attributes must match the set exactly,
 * `SameSite=Lax` included, or the browser treats it as a different cookie and the deletion
 * silently does nothing. The `tf_owner` marker must be cleared for a sharper reason: it tells the
 * next visit to open a mirror before asking who is there, and on a shared machine that paints
 * a signed-out person's chrome from a database the sign-out was supposed to end. The web
 * client also clears it and wipes the mirror (`apps/webapp/app/sign-out.ts`).
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
