/**
 * THE CANONICAL HOST, ENFORCED BY THE APPLICATION.
 *
 * `scripts/legacy-domains.mjs` declares that `www.ohmail.app`, `app.ohmail.app` and every
 * `mailoh.*` host 308 to `ohmail.app`, and `--apply` writes those redirects into Vercel.
 * That is the right place for them: a domain-level redirect is answered before any function
 * runs, which is cheaper and faster than anything this file can do.
 *
 * But it is EXTERNAL STATE. Nothing in the tree fails when it drifts, and the commit that
 * introduced the `www` entry records the exact failure that drift produces: the
 * probe printed `www.ohmail.app 200` — the product SERVING on a host that
 * `packages/services/src/auth/origins.ts` keeps on `NEVER_AUTH_HOSTS`. A visitor gets a
 * working-looking app in which every sign-in ceremony is refused with `origin_not_allowed`
 * and nothing on screen explaining why. Host-only cookies mean that is a broken duplicate
 * auth surface rather than a session leak, but "broken" is the whole point: it is a state
 * the product cannot recover from and cannot describe.
 *
 * So the rule is also enforced HERE, where it is diffable and testable. Vercel's redirect
 * stays the fast path; this is the backstop that makes the guarantee unconditional.
 *
 * ## Why an explicit list and not "anything that is not ohmail.app"
 *
 * Because a redirect loop is worse than the thing it fixes. This deployment legitimately
 * answers on hosts nobody should be redirected away from: the platform's preview URLs (how
 * a rollback is verified), `localhost:3001`, and the platform's own probes. A default-deny
 * host rule would break every one of them, and the failure would be a 308 loop on the
 * production apex the first time an alias moved. The list is therefore exactly the hosts
 * that are DECLARED to redirect, and `test/canonical-host.test.ts` proves it stays in step
 * with `legacy-domains.mjs` and with `NEVER_AUTH_HOSTS`.
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
