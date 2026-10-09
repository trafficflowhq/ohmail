/**
 * OPTIONAL VISIT STATISTICS FOR THE WEBSITE — off unless a build sets a Google Analytics 4
 * measurement id. One module for the three readers that must agree: `next.config.mjs` (the CSP
 * of the website's documents), the marketing root (whether the consent notice renders) and the
 * loader (what it fetches). The tag never reaches a product route, the desktop or the phone app,
 * and nothing loads before the visitor accepts (`app/(marketing)/components/Analytics.tsx`).
 */

/** The build variable. Unset, empty or absent: no tag, no notice, no CSP change. */
export const GA_ID_VAR = "NEXT_PUBLIC_GA_MEASUREMENT_ID";

const GA_ID = /^G-[A-Z0-9]{4,20}$/;

/**
 * The validated id, or null. The value is spliced into a script URL and a CSP is widened for it,
 * so anything that is not the plain `G-…` shape is no id at all.
 *
 * @param {string | undefined | null} raw
 * @returns {string | null}
 */
export function measurementId(raw) {
  const value = (raw ?? "").trim();
  return GA_ID.test(value) ? value : null;
}

/**
 * The build refuses a SET variable that is not an id: a typo must fail the deploy rather than
 * ship a site whose privacy page and notice describe statistics nothing collects.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export function assertMeasurementId(env) {
  const raw = (env[GA_ID_VAR] ?? "").trim();
  if (raw === "") return null;
  const id = measurementId(raw);
  if (id === null) throw new Error(`${GA_ID_VAR} is set but is not a measurement id: "G-" and then letters and digits.`);
  return id;
}

/** The loader's address for one id. */
export const gtagUrl = (/** @type {string} */ id) =>
  `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;

/** The sources the website's policy gains, per directive, and no others. */
export const ANALYTICS_CSP_SOURCES = Object.freeze({
  "script-src": Object.freeze(["https://www.googletagmanager.com"]),
  "connect-src": Object.freeze([
    "https://*.google-analytics.com",
    "https://*.analytics.google.com",
    "https://*.googletagmanager.com",
  ]),
  "img-src": Object.freeze(["https://*.google-analytics.com", "https://*.googletagmanager.com"]),
});

/**
 * `csp` with the analytics sources appended to their three directives. Every other directive is
 * returned byte for byte; a policy missing one of the three is refused, never silently extended.
 *
 * @param {string} csp
 * @returns {string}
 */
export function withAnalytics(csp) {
  const directives = csp.split("; ");
  /** @type {Record<string, readonly string[]>} */
  const add = ANALYTICS_CSP_SOURCES;
  for (const name of Object.keys(add)) {
    if (!directives.some((d) => d.split(" ")[0] === name)) throw new Error(`policy has no ${name}`);
  }
  return directives
    .map((d) => {
      const extra = add[d.split(" ")[0] ?? ""];
      return extra ? `${d} ${extra.join(" ")}` : d;
    })
    .join("; ");
}

/** Where the visitor's choice is kept (this browser only), and the two values it may hold. */
export const CONSENT_KEY = "ohmail.analytics";
export const CONSENT_GRANTED = "granted";
export const CONSENT_DENIED = "denied";

/** Fired on `window` by the "change your choice" controls; the notice reopens. */
export const CONSENT_REOPEN_EVENT = "ohmail:analytics-choice";
