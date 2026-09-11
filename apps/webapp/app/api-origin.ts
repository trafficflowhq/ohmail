/**
 * The runtime half of the allow-list. `next.config.mjs` validates `TF_API_ORIGIN` at BUILD time, and that is the only
 * gate the `/api/*` REWRITE needs — a rewrite destination is compiled into `routes-manifest.json`. The SESSION GATE
 * is not compiled: `middleware.ts` reads `process.env.TF_API_ORIGIN` in the edge runtime, re-read per invocation
 * (this file used to say the opposite, measurably false: after a build the manifest carries the origin verbatim while
 * `middleware.js` still carries `process.env.TF_API_ORIGIN??""`).
 */

/**
 * What that bought an attacker with dashboard access: change the variable, no redeploy, and the gate's `fetch` —
 * carrying the visitor's LIVE session token as `Authorization: Bearer` — goes to a host of their choosing while the
 * rewrite stays pinned. So the runtime re-reads the allow-list too; this module is that list, plain and edge-safe,
 * with a drift guard against the compiled copy in `next.config.mjs` (which cannot import TypeScript — the only reason
 * there are two). It NEVER throws: a bad value must stop a REQUEST, not the build — a throw inside middleware is a
 * 500 on the front door, so this returns `null`, which `resolveSurface` treats as "nothing can validate a token".
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

/**
 * The SELF-HOST session gate's API origin (`OHMAIL_INTERNAL_API_ORIGIN`) — the api container by its in-network name
 * (`http://api:8080` on the reference compose). A different resolver on purpose, reachable only from the self-host
 * build: the middleware selects it behind the COMPILED flavor, so a managed deployment cannot read this variable at
 * all — the dashboard-repoint attack needs a variable the managed bundle looks at.
 */

/**
 * No allow-list here: the value names a container on the operator's own compose network, chosen by the person who
 * sets `DATABASE_URL`, and demanding TLS between two containers on one bridge would make every install carry an
 * internal CA for a wire nobody else sees. The SHAPE checks stay `resolveApiOrigin`'s — a path would concatenate in
 * front of `/auth/session`, credentials in the URL would ride every request. Failure is `null` — the gate answers the
 * landing, the page that owes nobody anything.
 */
export function resolveInternalApiOrigin(raw: string | undefined | null): string | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.origin;
}
