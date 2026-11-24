/**
 * Whether a request may be authenticated by its session cookie: one rule for every door. The
 * list of hosts comes from the settings (`origin.cookieHosts`); nothing a request asserts can
 * add to it.
 */

/**
 * Whether this host accepts cookie authentication, decided per REQUEST HOST.
 *
 * One deployment answers on several hostnames — `api.ohmail.app` (the webapp's rewrite
 * target, and the legacy `api.mailoh.*` names still pinned into shipped clients), plus the
 * platform's own deployment URL every rollback and platform probe uses — so the decision
 * cannot be a build-time flag: it is a property of the hostname the request arrived on.
 * The port is stripped (`localhost:3002`) and the comparison is case-insensitive, because
 * DNS is.
 */
export function allowCookieAuthFor(host: string | null, cookieHosts: string[]): boolean {
  if (!host) return false;                       // no Host header ⇒ fail closed
  const bare = host.trim().toLowerCase().replace(/:\d+$/, "");
  return cookieHosts.some((h) => h.trim().toLowerCase() === bare);
}

/**
 * Every hostname this request asserts, normalized the way
 * {@link allowCookieAuthFor} compares them: the request URL's host (the only
 * one that survives `new Request(url, …)` — `Host` is a forbidden fetch
 * header), the `Host` header when the runtime exposes one, and every
 * `X-Forwarded-Host` value (proxies comma-join, so it is split). Only
 * `X-Forwarded-Host` is independent input; the `every` in
 * {@link allowCookieAuthForRequest} makes a forged value strictly
 * subtractive. A hostless URL contributes nothing; empty ⇒ refusal.
 */
export function assertedHosts(req: Request): string[] {
  let fromUrl = "";
  try {
    fromUrl = new URL(req.url).host;
  } catch {
    /* not absolute — the header sources still apply */
  }
  const raw = [
    fromUrl,
    req.headers.get("host") ?? "",
    ...(req.headers.get("x-forwarded-host") ?? "").split(","),
  ];
  return [...new Set(
    raw.map((h) => h.trim().toLowerCase().replace(/:\d+$/, "")).filter((h) => h.length > 0),
  )];
}

/**
 * The cookie-auth decision. The rule: every asserted host must be on the
 * allow-list, and there must be at least one; anything else is bearer-only.
 * "Every", not "the Host header": the webapp-rewrite pair (`api.ohmail.app`,
 * `ohmail.app`) is fully listed, while a typed `X-Forwarded-Host` can only
 * turn cookies off — honoured alone it would switch the bearer-only surface
 * into cookie mode. Unknown host ⇒ bearer-only, not 421/404: refusing would
 * take out the platform's own deployment URL, while bearer-only still serves
 * and cannot honour an ambient browser credential.
 */
export function allowCookieAuthForRequest(req: Request, cookieHosts: string[]): boolean {
  const asserted = assertedHosts(req);
  if (asserted.length === 0) return false;       // no host assertion at all ⇒ fail closed
  return asserted.every((h) => allowCookieAuthFor(h, cookieHosts));
}
