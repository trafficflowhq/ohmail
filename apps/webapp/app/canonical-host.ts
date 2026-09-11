/**
 * The canonical host, enforced by the application. `scripts/legacy-domains.mjs` declares that `www.ohmail.app`,
 * `app.ohmail.app` and every `mailoh.*` host 308 to `ohmail.app`, and `--apply` writes those redirects into Vercel —
 * the fast path. But that is EXTERNAL STATE: nothing in the tree fails when it drifts, and the recorded failure is
 * `www.ohmail.app 200` — the product serving on a host `origins.ts` keeps on `NEVER_AUTH_HOSTS`, where every sign-in
 * is refused `origin_not_allowed` with nothing on screen explaining why.
 */

/**
 * So the rule is also enforced HERE, where it is diffable and testable. An explicit list and not "anything that is
 * not ohmail.app": this deployment legitimately answers on preview URLs, `localhost:3001` and the platform's probes,
 * and a default-deny host rule would 308-loop the apex the first time an alias moved. A drift guard holds the list in
 * step with `legacy-domains.mjs` and `NEVER_AUTH_HOSTS`.
 */

/** Where every host in {@link REDIRECT_ONLY_HOSTS} is sent. */
export const CANONICAL_ORIGIN = "https://ohmail.app";

/**
 * Hosts that must never serve this app — each is declared as a 308 to
 * {@link CANONICAL_ORIGIN} in `scripts/legacy-domains.mjs`.
 *
 * Lower-case, no port: {@link canonicalRedirect} normalizes before comparing.
 */
export const REDIRECT_ONLY_HOSTS: readonly string[] = [
  // Current domain, retired addresses — both on NEVER_AUTH_HOSTS in origins.ts.
  "www.ohmail.app",
  "app.ohmail.app",
  // The pre-rename hosts. Every already-delivered sign-in mail and every bookmark.
  "mailoh.app",
  "www.mailoh.app",
  "mailoh.io",
  "www.mailoh.io",
];

/**
 * The absolute URL this request should be sent to, or `null` to serve it here.
 *
 * The path and the query are preserved — a stale `www.ohmail.app/privacy` link has to land
 * on `/privacy`, not on the home page — and the fragment never reaches a server anyway.
 */
export function canonicalRedirect(host: string | null, pathAndQuery: string): string | null {
  if (!host) return null;
  // `Host` may carry a port (`www.ohmail.app:443`); IPv6 literals are bracketed and
  // contain no port we care about here.
  const bare = host.trim().toLowerCase().replace(/:\d+$/, "");
  if (!REDIRECT_ONLY_HOSTS.includes(bare)) return null;
  return `${CANONICAL_ORIGIN}${pathAndQuery.startsWith("/") ? pathAndQuery : `/${pathAndQuery}`}`;
}
