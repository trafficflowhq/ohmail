/**
 * THE BROWSER-ENFORCED CONTAINMENT THE SINGLE ORIGIN LEFT UNBUILT.
 *
 * `packages/services/src/auth/origins.ts` says it plainly: the old rule — "the landing is
 * never an auth origin" — is gone, and **nothing at the origin layer can restate it**. The
 * marketing surface, the demo prototype, the passkey ceremonies, the session cookie, the
 * JS-readable `tf_csrf` and the IndexedDB mail mirror are now one origin. The only
 * containment left is the one the BROWSER enforces on that origin's documents, and until
 * this file existed `ohmail.app` shipped none of it: no CSP, no `X-Frame-Options`, no
 * `Referrer-Policy`, no `nosniff` — while `apps/admin` (a staff console holding strictly
 * less) shipped four headers on every path.
 *
 * ── WHAT IS ENFORCED, AND WHY EACH ONE ──────────────────────────────────────────────────
 *
 * `connect-src 'self'` is the load-bearing one, and it is the direct answer to the loss
 * origins.ts describes. Script injected anywhere on this origin can read `tf_csrf` and
 * issue same-origin authenticated requests — that much is unavoidable under one origin —
 * but it cannot SEND what it reads anywhere: no `fetch`, no `XMLHttpRequest`, no
 * `WebSocket`, no `EventSource`, no `sendBeacon` to any host but this one. `form-action`
 * and `base-uri` close the two classic non-`connect` exfiltration channels, `img-src`
 * refuses the pixel, and `default-src 'self'` means a script tag pointing off-origin does
 * not load at all — the same rule the no-third-party guard asserts over the source,
 * now enforced at runtime over whatever actually shipped.
 *
 * `frame-ancestors 'none'` replaces an accident with a control. Framing `ohmail.app` was
 * blocked only as a SIDE EFFECT of `SameSite=Strict`: a framed request carries no cookie,
 * so the gate renders marketing and there is nothing to clickjack. That is a true fact
 * about today's cookie flags, not a decision — relax the cookie to `Lax` for any reason
 * and the live mail client becomes framable with no separate control noticing.
 *
 * ── THE ONE DIRECTIVE THAT IS NOT STRICT, AND EXACTLY WHY ───────────────────────────────
 *
 * `script-src` keeps `'unsafe-inline'` in the BASELINE policy, and that is a real
 * limitation rather than an oversight:
 *
 *  - The App Router inlines its RSC payload as `<script>self.__next_f.push(…)</script>`.
 *    The content differs per page and per build, so it cannot be hashed from a config file.
 *  - Which leaves a nonce — and a nonce is per-request, so a document carrying one cannot
 *    be a static prerender. Anonymous `/` IS a static prerender, deliberately: `middleware.ts`
 *    documents that keeping it CDN-cacheable is most of why the gate refuses to fetch
 *    anything without a cookie. Putting a nonce on it would trade a documented architectural
 *    property for a directive, and — worse — a CDN would then cache ONE nonce and serve it
 *    to everyone, which is a nonce that authorises nothing.
 *
 * So the split is by surface, not by wishful thinking. The pages that render mail are
 * dynamic already, and they get {@link nonceCsp}: `script-src 'self' 'nonce-…'`, under
 * which `'unsafe-inline'` is ignored by every browser that understands nonces. The static
 * marketing pages keep {@link BASELINE_CSP} and therefore keep their cache. Both get every
 * other directive.
 *
 * In `apps/webapp` no untrusted markup string reaches a DOM sink: there is no
 * `dangerouslySetInnerHTML` in the shell except the two theme-boot blocks, and the mail
 * viewer's native rendering is built element by element from walked data
 * (`BodyText`/`buildRichNodes`), so sender bytes enter the app's document only as text
 * nodes and as attributes that code constructed — a sender's own markup renders solely
 * inside the sandboxed `srcdoc` frame. That is why this ordering is defensible rather
 * than negligent.
 *
 * ── THE COPY IN `next.config.mjs` ───────────────────────────────────────────────────────
 *
 * `next.config.mjs` cannot import TypeScript, so the baseline policy is spelled there too,
 * for the paths middleware does not match (static assets, `/demo/*`, the icons).
 * A drift guard reads that file's source and fails if the two disagree —
 * the same discipline the rewrite guard uses for `REFRESH_PATH`.
 */

/**
 * Every directive except `script-src`, in the order the config file spells them.
 *
 * `style-src` keeps `'unsafe-inline'` unconditionally: React sets element `style`
 * attributes throughout the shell (the demo build-up's transforms, the annotation
 * geometry, the rail measurements), and CSP treats those as inline styles. Removing it
 * would mean a redesign, and inline STYLE is not a code-execution primitive the way
 * inline script is.
 */
export const SHARED_CSP_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "connect-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "frame-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "media-src 'self'",
  "upgrade-insecure-requests",
];

/** The policy for statically prerendered documents — see the header for why `unsafe-inline`. */
export const BASELINE_CSP: string = [
  ...SHARED_CSP_DIRECTIVES,
  "script-src 'self' 'unsafe-inline'",
].join("; ");

/**
 * The policy for the surfaces that render mail or take credentials.
 *
 * Nonce AND `'self'`: the nonce authorises the two inline blocks (Next's own bootstrap,
 * which it stamps from the request header, and the theme-boot script, which
 * `(product)/layout.tsx` passes down), while `'self'` covers the `/_next/static` chunks.
 * `'strict-dynamic'` is deliberately NOT used — it would DISABLE `'self'`, making every
 * chunk load depend on Next's loader being nonce-propagating, for no gain on an origin
 * that is already proven to load no third-party script.
 */
export function nonceCsp(nonce: string): string {
  return [...SHARED_CSP_DIRECTIVES, `script-src 'self' 'nonce-${nonce}'`].join("; ");
}

/**
 * A fresh nonce. 16 bytes of `crypto.getRandomValues`, base64 — Web Crypto and `btoa` are
 * both present in the edge runtime, and neither `node:crypto` nor `Buffer` is.
 */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * The three headers that are not CSP, applied to every response.
 *
 * `X-Frame-Options` is redundant with `frame-ancestors` for any browser released this
 * decade and is sent anyway: it is one header, and it is what an old client understands.
 * `Referrer-Policy` is `strict-origin-when-cross-origin` rather than admin's `no-referrer`
 * because this origin has a marketing surface whose outbound links are a legitimate part
 * of the product; it still never leaks a path off-origin.
 */
export const STATIC_SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
];
