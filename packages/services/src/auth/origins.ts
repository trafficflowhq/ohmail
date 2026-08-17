import { parse as parseHost } from "tldts";
import { ServiceError } from "../errors.js";
import type { AuthConfig } from "./config-types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Multi-origin WebAuthn.
//
// ONE relying party (`rpID = "ohmail.app"`), SEVERAL browser origins
// (`https://ohmail.app`, `https://admin.ohmail.app`). WebAuthn permits this: the
// rpID may be the origin's own host OR a registrable-domain suffix of it, and a
// credential scoped to `ohmail.app` is therefore usable from every subdomain of
// `ohmail.app` — staff do NOT need a second passkey for the admin console.
//
// Two rules make the allow-list safe, and they are different rules:
//
//  1. **Admission** (this module, at OPTIONS time): the request's `Origin` must be
//     a member of the allow-list, or the ceremony never starts —
//     `origin_not_allowed` (403). Rejecting at verify time instead would let an
//     unknown origin mint challenge rows.
//  2. **Binding** (auth-service `consumeChallenge`, at VERIFY time): the ceremony is
//     pinned to the origin that OPENED it. The origin recorded on the stored
//     challenge row is what `expectedOrigin` receives — never the raw header of the verify
//     request. Both `https://ohmail.app` and `https://admin.ohmail.app` are allowed,
//     yet a ceremony begun on one may not be completed on the other.
//
// NOT an auth origin, ever: hosts that only ever REDIRECT — see
// {@link NEVER_AUTH_HOSTS}, which is also where the history of this rule lives.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hosts under the product's own registrable domain that must never appear in the
 * allow-list, because none of them SERVES anything — each is a 308 to `ohmail.app`.
 *
 * Unconditional, deliberately: there is no deployment flag under which a redirect host
 * becomes an auth surface, so there is nothing to key this on. Every `AuthConfig` —
 * `makeAuthConfig`'s output AND a hand-built literal handed to `new AuthService(...)` —
 * passes through {@link assertOriginConfig}, so this is the prod-config assertion.
 *
 * ## THE RULE THIS REPLACES, AND WHY IT COULD NOT SURVIVE
 *
 * The original invariant was **"the landing is never an auth origin"**, and it has now
 * been through three states. It is written out in full because the third state is a
 * genuine LOSS, and a comment that quietly restated the rule about different hosts would
 * be describing a guarantee that no longer exists.
 *
 *  1. **Two-domain era — a registrable-domain rule on the rpID.** The landing and the
 *     product lived on two DIFFERENT registrable domains, so the check sat on the rpID
 *     and it was total. An origin under the landing's domain
 *     could only be admitted by an rpID whose registrable domain was the landing's, so
 *     refusing that one rpID shape refused every landing origin by construction. The
 *     per-origin pass below was a redundant tripwire.
 *
 *  2. **Single-domain rename — an exact HOST list.** `ohmail.app` (landing),
 *     `app.ohmail.app` (product) and `admin.ohmail.app` (console) came to share one
 *     registrable domain, and the rpID that had to cover the last two IS `ohmail.app` —
 *     the landing's own host. "Reject an rpID under the landing's registrable domain"
 *     would have rejected the only rpID the product could use, so the rule became
 *     unstateable at the rpID and moved DOWN to an exact host match on the origin list.
 *     Weaker, but still a real mechanism: no landing host could be admitted.
 *
 *  3. **One origin — THE RULE IS GONE, and nothing can restate it.**
 *     `ohmail.app` now serves the marketing page to a stranger and the mail client to a
 *     session, from one deployment. It is the product's origin. It mints the session
 *     cookie, it serves the passkey ceremonies, it IS the auth origin. "The landing is
 *     never an auth origin" is no longer a rule that has a subject: there is no landing
 *     host distinct from the product host to keep out.
 *
 * ## WHAT ACTUALLY ENFORCES WHAT NOW — stated plainly, including the losses
 *
 * **Lost, with no replacement at this layer.** The marketing surface and the app share
 * one cookie scope, one credential scope and one script origin. An XSS in a marketing
 * component is an XSS in the app's origin; it can read the non-HttpOnly `tf_csrf` and
 * issue same-origin authenticated requests. Under state 1 the registrable domain made
 * that impossible; under state 3 nothing at the origin layer can. This is the accepted
 * price of the single origin and it is accepted DELIBERATELY, not by omission.
 *
 * **What carries the risk instead**, and neither of these is an origin rule:
 *   • the marketing surface is now the same codebase, the same deploy and the same
 *     review gate as the product — it is not a separately-deployed site that can acquire
 *     a tag manager without anyone noticing. A test in the browser app enforces the
 *     replacement rule mechanically: **the marketing surface loads nothing off-origin** —
 *     no tag manager, no analytics, no font CDN, no embedded widget. Adding one is a change
 *     to the security posture of the mail client, and it turns that test red.
 *   • the session cookie stays HOST-ONLY (no `Domain=`), so the scope shared is exactly
 *     one host and never `*.ohmail.app`. That is the whole reason the collapse onto one
 *     origin was worth doing rather than widening the cookie across two.
 *
 * **What this list still does**, and it is a smaller and honest job: it keeps hosts that
 * REDIRECT out of the allow-list. `www.ohmail.app` and `app.ohmail.app` both 308 to
 * `ohmail.app`; a browser can never complete a ceremony on either (it follows the
 * redirect and the ceremony happens on `ohmail.app`), so admitting them would widen the
 * allow-list by hosts that cannot legitimately use it. Adding a redirect host means
 * adding it here.
 *
 * Exact host matching, not suffix matching: `ohmail.app` and `admin.ohmail.app` are
 * subdomains of — or equal to — entries' parents and MUST stay admissible, so a suffix
 * test would refuse the whole product.
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

// ── rpID validation: structural, then PUBLIC-SUFFIX-LIST-aware ───────────────
//
// A dot-boundary suffix test alone is NOT the WebAuthn rule, and the gap is a real
// cross-origin hole rather than a cosmetic one. `rpID: "app"` with origins
// `https://app.ohmail.app` + `https://evil.app` passes `host.endsWith("." + rp)` for both,
// and `rpID: "co.uk"` spans `acme.co.uk` + `evil.co.uk` the same way — at which point
// `withRequestGuard` treats a FOREIGN registrable domain as first-party and one
// credential store spans two owners. A browser would refuse such an rpID at ceremony
// time (so would malformed labels and IP literals), which means the deployment is
// green and every passkey on a user's device fails. Both must fail at BOOT.
//
// The rule enforced here, against the real PSL (`tldts`, private section included so
// e.g. `github.io` / `pages.dev` count as suffixes):
//
//   1. rpID is a syntactically valid DNS host: LDH labels, 1–63 chars each, ≤253
//      total, no empty/leading/trailing-hyphen label, not an IPv4/IPv6 literal.
//   2. rpID contains a dot AND is not itself a public suffix — so never a TLD
//      (`app`, `io`), never a multi-label suffix (`co.uk`, `s3.amazonaws.com`).
//   3. For EVERY origin: the origin's host is rpID or a dot-boundary subdomain of it
//      (the WebAuthn suffix relation — this is what rejects an rpID MORE specific
//      than the origin), and the origin's REGISTRABLE DOMAIN equals rpID's. Rule 3's
//      second half is independent of rule 2: rpID `amazonaws.com` structurally
//      "covers" `bucket.s3.amazonaws.com`, whose registrable domain is the whole
//      thing — a different owner.
//   4. ONE narrow exemption, for dev: an rpID of `localhost` (or `*.localhost`) or
//      the loopback literals, where the PSL treats `localhost` as a public suffix and
//      rules 2–3 would reject the config the whole test suite and `pnpm dev` use.
//      Only rule 1's IP/label checks are skipped; the suffix relation in rule 3 still
//      applies, so `rpID: "localhost"` still cannot cover `https://app.ohmail.app`.

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
 * Validate + canonicalize `cfg.origin` (one string or many) into the allow-list.
 * Memoized per config object: `AuthService` is rebuilt per request in `apps/web`,
 * and this must not re-parse on every ceremony.
 *
 * Fails fast, at construction, on: zero origins, a non-absolute/pathful/credentialed
 * origin, non-loopback `http:`, an `rpID` that is empty / malformed / an IP literal /
 * a PUBLIC SUFFIX, an `rpID` that does not cover EVERY origin (dot-boundary suffix AND
 * the same registrable domain), and any origin whose host only ever REDIRECTS
 * ({@link NEVER_AUTH_HOSTS}).
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
