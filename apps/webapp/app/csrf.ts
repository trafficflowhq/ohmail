/**
 * The double-submit CSRF token, read from the cookie the server minted. Its own module because
 * `api-client.ts` (the natural home) imports `session-refresh.ts`, and `session-refresh.ts` now
 * needs the token too — the resume splash's `POST /auth/refresh` is a cookie-authenticated unsafe
 * method like any other, so it must double-submit. Importing it back out of `api-client.ts` would
 * close a cycle between the two modules; a function declaration would probably survive one, and
 * "probably survives a cycle" is not a thing to build the sign-in path on. The reader sits here,
 * both import it, and `api-client.ts` re-exports it so its public surface is unchanged.
 */

import { cookieFromJar } from "./shell/cookie-jar";

export const CSRF_COOKIE = "tf_csrf";

/**
 * Read the double-submit CSRF token.
 *
 * `tf_csrf` is deliberately NOT `HttpOnly` (that is what "double submit" means: the client
 * must be able to echo it). Absent ⇒ no header is sent, which is correct for a request that
 * carries no cookie session — a bearer client is CSRF-exempt by construction, and a
 * pre-session `POST /auth/register` has nothing to double-submit yet.
 */
export function csrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const raw = cookieFromJar(document.cookie, CSRF_COOKIE);
  return raw === null ? null : decodeURIComponent(raw);
}

/**
 * Enough of `tf_csrf` to tell that the jar moved on, and never the value itself; `""` for none. Pure,
 * so the resume page marks the jar its navigation carried as the browser marks the jar it holds.
 */
export function csrfMark(csrf: string | null): string {
  if (csrf === null) return "";
  let h = 0x811c9dc5;
  for (let i = 0; i < csrf.length; i += 1) h = Math.imul(h ^ csrf.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0");
}
