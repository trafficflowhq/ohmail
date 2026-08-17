/**
 * THE RUNTIME HALF OF THE ALLOW-LIST.
 *
 * `next.config.mjs` validates `TF_API_ORIGIN` against {@link ALLOWED_API_ORIGINS} at BUILD
 * time and fails the build on anything else. That is a real gate, and it is the only gate
 * the `/api/*` REWRITE needs: a rewrite destination is compiled into `routes-manifest.json`
 * by `next build`, so the value that shipped is the value that was reviewed.
 *
 * The SESSION GATE is not compiled. `middleware.ts` reads `process.env.TF_API_ORIGIN` in
 * the edge runtime — the middleware bundle contains the literal expression, not the value —
 * so the variable is re-read from the deployment's environment on every invocation. The
 * file used to say the opposite ("Next inlines it into the middleware bundle, so there is
 * no runtime lookup"), and that was measurably false: after a build with the variable set,
 * `.next/routes-manifest.json` carries the origin verbatim while `.next/server/middleware.js`
 * still carries `process.env.TF_API_ORIGIN??""`.
 *
 * What that bought an attacker with dashboard access, and no code change and no review:
 * change the variable, do not redeploy, and the gate's `fetch` — which carries the
 * visitor's LIVE session token as `Authorization: Bearer` (`session-gate.ts`) — goes to a
 * host of their choosing, while the rewrite stays pinned to the old value. A split brain in
 * which one half of the topology leaks credentials and the other half looks fine.
 *
 * So the runtime re-reads the allow-list too. This module is that allow-list, and it is
 * deliberately a plain, dependency-free, edge-safe module: `middleware.ts` can import it,
 * a unit test can drive it, and a drift guard asserts it has not drifted from
 * the compiled list in `next.config.mjs` (which cannot import TypeScript, which is the only
 * reason there are two copies at all).
 *
 * ## It NEVER throws
 *
 * `apiOrigin()` in `next.config.mjs` throws, because a bad value there must stop a build.
 * Here a bad value must stop a REQUEST, and the gate's entire contract is that every
 * failure answers `"marketing"` (`session-gate.ts` — "the landing is the state that is
 * never wrong"). A throw inside middleware is a 500 on the product's front door. So this
 * returns `null`, which `resolveSurface` already treats as "nothing can validate a token".
 * Fail closed, toward the page that owes the viewer nothing.
 */

/**
 * The only hosts a live session token may be presented to.
 *
 * MUST equal `ALLOWED_API_ORIGINS` in `next.config.mjs`. A drift guard reads
 * that file's source and fails if the two lists differ.
 */
export const ALLOWED_API_ORIGINS: readonly string[] = ["https://api.ohmail.app"];

/** Loopback is exempt, exactly as in `next.config.mjs`: `pnpm dev` and the e2e harness. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Validate `TF_API_ORIGIN` for RUNTIME use, or answer `null`.
 *
 * The checks are the build-time ones, in the same order and for the same reasons: a path /
 * query / fragment would be concatenated in front of the endpoint, credentials in the URL
 * would ride along on every request, and plaintext outside loopback would put the bearer
 * token on the wire in clear. The difference is only what a failure does.
 */
export function resolveApiOrigin(raw: string | undefined | null): string | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  if (url.username !== "" || url.password !== "") return null;

  if (LOOPBACK.has(url.hostname.toLowerCase())) {
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  }
  if (url.protocol !== "https:") return null;
  if (!ALLOWED_API_ORIGINS.includes(url.origin)) return null;
  return url.origin;
}
