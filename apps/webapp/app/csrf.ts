/**
 * The double-submit CSRF token, read from the cookie the server minted.
 *
 * ── WHY THIS IS ITS OWN MODULE ───────────────────────────────────────────────────────────
 *
 * It lived in `api-client.ts`, which is the natural home for it — every mutation that file
 * sends echoes it. But `api-client.ts` IMPORTS `session-refresh.ts` (for `resumeSession`,
 * `isRecoverable`, `mayRefreshFor`), and `session-refresh.ts` now needs the token too: the
 * resume splash's `POST /auth/refresh` is a cookie-authenticated unsafe method like any
 * other, so it must double-submit. Importing it back out of `api-client.ts` would close a
 * cycle between the two modules. A function declaration would probably survive one, and
 * "probably survives a cycle" is not a thing to build the sign-in path on.
 *
 * So the reader sits here, both import it, and `api-client.ts` re-exports it so its public
 * surface is unchanged.
 */

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
  for (const part of document.cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === "tf_csrf") return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}
