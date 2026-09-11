/**
 * The browser-enforced containment the single origin left unbuilt. `origins.ts` says it plainly: "the landing is
 * never an auth origin" is gone, and nothing at the origin layer can restate it — the marketing surface, the demo,
 * the passkey ceremonies, the session cookie, the JS-readable `tf_csrf` and the IndexedDB mirror are one origin, and
 * the only containment left is what the BROWSER enforces.
 */

/**
 * `connect-src 'self'` is the load-bearing directive: injected script can read `tf_csrf` and issue same-origin
 * requests — unavoidable under one origin — but it cannot SEND what it reads anywhere (no fetch, XHR, WebSocket,
 * EventSource or sendBeacon off-origin); `form-action` and `base-uri` close the classic non-connect exfiltration
 * channels, `img-src` refuses the pixel, `default-src 'self'` keeps an off-origin script tag from loading at all.
 * `frame-ancestors 'none'` replaces an accident with a control: framing was blocked only as a side effect of
 * `SameSite=Strict`, and relaxing the cookie would otherwise make the mail client framable with no separate control
 * noticing.
 */

/**
 * The one directive that is not strict: `script-src` keeps `'unsafe-inline'` in the BASELINE policy. The App Router
 * inlines its RSC payload per page and per build, so it cannot be hashed from a config; a nonce is per-request, and
 * anonymous `/` is deliberately a static prerender — a CDN would cache ONE nonce and serve it to everyone, a nonce
 * that authorises nothing. So the split is by surface: the pages that render mail are dynamic already and get {@link
 * nonceCsp} (`'unsafe-inline'` is ignored by every browser that understands nonces); the static marketing pages keep
 * {@link BASELINE_CSP} and their cache.
 */

/**
 * Defensible because no untrusted markup string reaches a DOM sink in this app: no `dangerouslySetInnerHTML` but the
 * two theme-boot blocks, and the mail viewer builds elements from walked data — a sender's own markup renders solely
 * inside the sandboxed `srcdoc` frame. `next.config.mjs` carries a copy for the paths middleware does not match (it
 * cannot import TypeScript); a drift guard fails if the two disagree.
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
