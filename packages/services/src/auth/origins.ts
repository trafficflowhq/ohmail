import { parse as parseHost } from "tldts";
import { ServiceError } from "../errors.js";
import type { AuthConfig } from "./config-types.js";

// Multi-origin WebAuthn: ONE relying party (`rpID = "ohmail.app"`), SEVERAL browser origins.
// WebAuthn permits it — the rpID may be the origin's host or a registrable-domain suffix of it,
// so one credential works from every subdomain. Two different rules make the allow-list safe: (1)
// ADMISSION, this module, at OPTIONS time — the request's `Origin` must be a member or the
// ceremony never starts (403; a verify-time rejection would let an unknown origin mint challenge
// rows); (2) BINDING, `consumeChallenge`, at VERIFY time — the ceremony is pinned to the origin
// that OPENED it: the stored challenge row's origin is what `expectedOrigin` receives, never the
// verify request's raw header, so a ceremony begun on one allowed origin may not be completed on
// another. Hosts that only REDIRECT are never auth origins ({@link NEVER_AUTH_HOSTS}).

/**
 * Hosts under the product's own registrable domain that must never appear in the allow-list: none
 * SERVES anything — each is a 308 to `ohmail.app`. Unconditional: every `AuthConfig` passes
 * {@link assertOriginConfig}. The old rule — "the landing is never an auth origin" — is GONE:
 * `ohmail.app` serves the marketing page and the mail client from one deployment. The loss is
 * accepted deliberately: an XSS in a marketing component is an XSS in the app. What carries the
 * risk: one codebase and deploy, a browser-app test enforcing that the marketing surface loads
 * NOTHING off-origin, and a HOST-ONLY session cookie. This list keeps redirect hosts (`www.`,
 * `app.`) out; exact host matching — a suffix test would refuse the product.
 */
const NEVER_AUTH_HOSTS: readonly string[] = ["www.ohmail.app", "app.ohmail.app"];

/**
 * `http:` is a secure context only for loopback — WebAuthn refuses it elsewhere.
 *
 * EXPORTED (as {@link isLoopbackHostname}) because this predicate is a CONTRACT other validators
 * must agree with, not restate: `MailService.assertLinkBase` accepts http link bases exactly
 * where this accepts http origins, so an operator origin that boots auth can never be refused as
 * a mail link base. Two hand-kept copies of "what counts as loopback" is how
 * `http://[::1]:8080` booted sign-in and then refused the mailer for the same origin.
 */
function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}
export { isLoopback as isLoopbackHostname };

/**
 * Canonicalize one configured/observed origin to `scheme://host[:port]`.
 * Throws a plain `Error` (this runs at CONFIG construction — a boot failure, not a
 * request failure). Use {@link tryNormalizeOrigin} for untrusted request headers.
 */
export function normalizeOrigin(raw: string): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error("auth origin must be a non-empty string");
  }
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(`auth origin ${JSON.stringify(raw)} is not an absolute URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`auth origin ${raw} must be http(s)`);
  }
  if (u.protocol === "http:" && !isLoopback(u.hostname)) {
    throw new Error(`auth origin ${raw} must use https (http is a secure context only on loopback)`);
  }
  if (u.username || u.password) throw new Error(`auth origin ${raw} must carry no credentials`);
  if (u.search || u.hash || (u.pathname !== "" && u.pathname !== "/")) {
    throw new Error(`auth origin ${raw} must be scheme://host[:port] with no path, query or fragment`);
  }
  return u.origin;
}

/** {@link normalizeOrigin} for UNTRUSTED input: `null` instead of a throw. */
export function tryNormalizeOrigin(raw: string | null | undefined): string | null {
  if (raw == null || raw.trim() === "") return null;
  try {
    return normalizeOrigin(raw);
  } catch {
    return null;
  }
}

// rpID validation: structural, then PUBLIC-SUFFIX-LIST-aware. A dot-boundary suffix test alone is
// not the WebAuthn rule: `rpID: "app"` passes `endsWith` for `https://app.ohmail.app` AND
// `https://evil.app`, and `rpID: "co.uk"` spans two owners. A browser refuses such an rpID at
// ceremony time, so the deployment is green and every passkey fails; both must fail at BOOT. The
// rule, against the real PSL (`tldts`, private section included): (1) rpID is a valid DNS host —
// LDH labels, ≤253 bytes, no IP literal; (2) rpID contains a dot and is not itself a public
// suffix; (3) every origin's host is rpID or a dot-boundary subdomain AND its registrable domain
// equals rpID's (independent of rule 2: `amazonaws.com` covers a bucket owned by someone else);
// (4) one dev exemption for `localhost`/loopback, skipping only rule 1's IP/label checks — `rpID:
// "localhost"` still cannot cover `https://app.ohmail.app`.

/** One DNS label: LDH, no leading/trailing hyphen. Punycode (`xn--…`) qualifies. */
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** Is this host an IPv4/IPv6 literal (bracketed or not)? Never a valid rpID. */
function isIpLiteral(host: string): boolean {
  return parseHost(host, { detectIp: true }).isIp === true;
}

/**
 * The registrable domain ("eTLD+1") of `host` per the Public Suffix List, or `null`
 * when `host` IS a public suffix / is not a valid host. Private-section entries count
 * (`foo.github.io` → `foo.github.io`), which is the stricter and safer reading.
 */
function registrableDomain(host: string): string | null {
  return parseHost(host, { allowPrivateDomains: true, detectIp: true }).domain ?? null;
}

/** Rule 1: rpID is a syntactically valid DNS host. Throws a boot error otherwise. */
function assertHostSyntax(rp: string): void {
  if (rp.length > 253) {
    throw new Error(`AuthConfig.rpID "${rp}" is longer than 253 characters — not a valid DNS name`);
  }
  for (const label of rp.split(".")) {
    if (label === "") {
      throw new Error(`AuthConfig.rpID "${rp}" has an empty DNS label (a stray or trailing dot)`);
    }
    if (label.length > 63) {
      throw new Error(`AuthConfig.rpID "${rp}" has a DNS label longer than 63 characters ("${label.slice(0, 16)}…")`);
    }
    if (!DNS_LABEL.test(label)) {
      throw new Error(
        `AuthConfig.rpID "${rp}" has an invalid DNS label "${label}" — labels are letters, ` +
        "digits and inner hyphens only (use the punycode form for an IDN); a browser " +
        "would refuse every ceremony under it",
      );
    }
  }
}

/**
 * Validate `cfg.rpID` on its own (rules 1 + 2, or the rule-4 dev exemption).
 * Returns the canonical lowercase rpID and its registrable domain — `null` for the
 * exempt dev hosts, which have none.
 */
function assertRpIdShape(rpID: string): { rp: string; domain: string | null } {
  const rp = rpID.trim().toLowerCase();

  // Rule 4 first: the loopback dev RP, where the PSL has nothing useful to say.
  if (isLoopback(rp)) return { rp, domain: null };

  if (isIpLiteral(rp)) {
    throw new Error(
      `AuthConfig.rpID "${rpID}" is an IP literal — WebAuthn rpIDs must be domain names ` +
      "(only the loopback dev hosts are exempt)",
    );
  }
  if (/[:/\s]/.test(rp)) {
    throw new Error(`AuthConfig.rpID must be a bare host, got ${JSON.stringify(rpID)}`);
  }
  assertHostSyntax(rp);
  if (!rp.includes(".")) {
    throw new Error(
      `AuthConfig.rpID "${rpID}" has no dot — a single label is a TLD/public suffix, not a ` +
      "registrable domain, so it would span every site under it",
    );
  }
  const domain = registrableDomain(rp);
  if (domain === null) {
    throw new Error(
      `AuthConfig.rpID "${rpID}" is a PUBLIC SUFFIX, not a registrable domain — one ` +
      "credential store would span every unrelated site under it (and a browser refuses " +
      "such an rpID outright)",
    );
  }
  // No marketing/product check on the rpID, and there cannot be one: since the collapse
  // onto a single origin the marketing site's host IS the product's host and IS the
  // registrable domain the rpID must be. Redirect-only hosts are kept out at the ORIGIN
  // level instead — see {@link NEVER_AUTH_HOSTS}.
  return { rp, domain };
}

/**
 * Rule 3: `rpID` must be the origin's host or a registrable-domain SUFFIX of it, AND
 * the two must share the same registrable domain — the WebAuthn rule that makes one
 * credential store span `ohmail.app` and `admin.ohmail.app` and nothing else. A
 * violation is unshippable: every ceremony on that origin would be rejected by the
 * browser, so it fails at construction instead.
 */
function assertRpIdCovers(rpID: { rp: string; domain: string | null }, origin: string): void {
  const host = new URL(origin).hostname.toLowerCase();
  const { rp, domain } = rpID;
  if (host !== rp && !host.endsWith(`.${rp}`)) {
    throw new Error(
      `rpID "${rp}" is not a registrable-domain suffix of auth origin ${origin} — ` +
      "WebAuthn would reject every ceremony on that origin",
    );
  }
  if (domain === null) return;                 // the loopback dev exemption (rule 4)
  const originDomain = registrableDomain(host);
  if (originDomain !== domain) {
    throw new Error(
      `auth origin ${origin} has registrable domain ${JSON.stringify(originDomain)} but ` +
      `rpID "${rp}" has ${JSON.stringify(domain)} — the rpID must not span a foreign ` +
      "registrable domain (public-suffix rule)",
    );
  }
}

const NORMALIZED = new WeakMap<AuthConfig, readonly string[]>();

/**
 * Validate + canonicalize `cfg.origin` (one string or many) into the allow-list. Memoized per
 * config object: `AuthService` is rebuilt per request in `apps/web`, and this must not re-parse
 * on every ceremony. Fails fast, at construction, on: zero origins, a
 * non-absolute/pathful/credentialed origin, non-loopback `http:`, an `rpID` that is empty,
 * malformed, an IP literal or a PUBLIC SUFFIX, an `rpID` that does not cover EVERY origin
 * (dot-boundary suffix AND the same registrable domain), and any origin whose host only ever
 * redirects ({@link NEVER_AUTH_HOSTS}).
 */
export function assertOriginConfig(cfg: AuthConfig): readonly string[] {
  const memo = NORMALIZED.get(cfg);
  if (memo) return memo;

  const raw = Array.isArray(cfg.origin) ? cfg.origin : [cfg.origin];
  if (raw.length === 0) throw new Error("AuthConfig.origin requires at least one origin");
  if (typeof cfg.rpID !== "string" || cfg.rpID.trim() === "") {
    throw new Error("AuthConfig.rpID is required");
  }
  const rpID = assertRpIdShape(cfg.rpID);

  const out: string[] = [];
  for (const o of raw) {
    const n = normalizeOrigin(o);
    assertRpIdCovers(rpID, n);
    if (!out.includes(n)) out.push(n);          // duplicates are a config typo, not an error
  }
  // The redirect-host check (see {@link NEVER_AUTH_HOSTS}). Rule 3 cannot express it —
  // these hosts share the product's registrable domain, so rule 3 admits them and only
  // an exact HOST match refuses them. Runs as a second pass so a config that is wrong in
  // both ways still reports the rpID-coverage failure first (the more fundamental one).
  for (const n of out) {
    const host = new URL(n).hostname.toLowerCase();
    if (NEVER_AUTH_HOSTS.includes(host)) {
      throw new Error(
        `auth origin ${n} is a REDIRECT-ONLY host — it serves nothing but a 308 to ` +
        "https://ohmail.app, so no ceremony can begin or complete there and it must " +
        "NEVER be an auth origin; the product is served at https://ohmail.app",
      );
    }
  }
  const frozen = Object.freeze(out);
  NORMALIZED.set(cfg, frozen);
  return frozen;
}

/** The canonical allow-list. Single-origin configs yield a one-element list. */
export function allowedOrigins(cfg: AuthConfig): readonly string[] {
  return assertOriginConfig(cfg);
}

/**
 * The origin used when the request carries none — the FIRST configured entry.
 * Native clients (macOS/Tauri/Expo) send no `Origin` header and cannot: they are
 * not browsers. Keeping the first entry as the fallback is also what makes every
 * single-origin config behave byte-identically.
 */
export function defaultOrigin(cfg: AuthConfig): string {
  return assertOriginConfig(cfg)[0]!;
}

/** Is this raw `Origin` header value one of the configured origins? */
export function isAllowedOrigin(cfg: AuthConfig, raw: string | null | undefined): boolean {
  const n = tryNormalizeOrigin(raw);
  return n !== null && assertOriginConfig(cfg).includes(n);
}

/**
 * Admission (rule 1): the origin a NEW ceremony is bound to.
 *
 * `requested` is the request's `Origin` header. Absent ⇒ {@link defaultOrigin}.
 * Present but not allow-listed ⇒ **`origin_not_allowed` (403), here, at options
 * time** — a distinct code from the generic cross-site refusal so a client can tell
 * "this deployment does not serve passkeys on this host" from "your request looked
 * forged", and distinct from the 401 a MISMATCH raises at verify time.
 */
export function resolveCeremonyOrigin(cfg: AuthConfig, requested: string | null | undefined): string {
  if (requested == null || requested.trim() === "") return defaultOrigin(cfg);
  const n = tryNormalizeOrigin(requested);
  if (n === null || !assertOriginConfig(cfg).includes(n)) {
    throw new ServiceError("origin_not_allowed", 403, "webauthn is not served on this origin");
  }
  return n;
}
