/**
 * The pairing link — one shape, composed on the desktop, parsed on the phone:
 * `${origin}/pair#${fragment}`. Composer and parsers drifting apart is a pairing that fails with
 * nothing on either machine to look at, so there is one of each, here. In `core` because a THIRD
 * graph parses these links and cannot reach `client-engine`; that package re-exports this file.
 * The token rides the FRAGMENT — not sent in the page request, never in an access log or a
 * `Referer`. Beside it, the KEY FINGERPRINT: the LAN door serves TLS with its own key, and the
 * ceremony carries the trust. Two forms: `#<token>` and `#k1.<fingerprint>.<token>` — a versioned
 * prefix, so a phone that has never heard of `k2` says so instead of misreading it.
 */

/** The pin format this build composes and understands. */
export const PAIR_PIN_VERSION = "k1";

/** A parsed pairing link. `pin` is `null` for the unpinned form. */
export interface PairLink {
  /** Lower-cased scheme + host (+ port), no trailing slash. */
  origin: string;
  /** The raw single-use pairing token — the credential. Never logged, never put in a URL. */
  token: string;
  /** base64url `SHA-256(SubjectPublicKeyInfo)` of the door's key, or `null` when unpinned. */
  pin: string | null;
}

/**
 * base64url, unpadded, of a 32-byte hash: 43 characters. Pinned as a SHAPE rather than merely
 * "some string" so a truncated QR read produces a refusal here instead of a pin that can never
 * match anything and a handshake failure three screens later.
 */
const FINGERPRINT = /^[A-Za-z0-9_-]{43}$/;

/** Is this a well-formed SPKI fingerprint as the ceremony carries it? */
export function isPairPin(value: string): boolean {
  return FINGERPRINT.test(value);
}

/** Lower-case scheme+host, no trailing slash — so `Https://Host/` and `https://host` are one. */
function normalize(origin: string): string {
  return origin.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * Compose the link the QR encodes. `pin` present ⇒ the pinned form.
 *
 * The origin is taken as given and only normalised: WHICH address the link names is the pane's
 * decision (the tailnet origin where there is one, else the same-network address), and putting
 * that choice here would hide it from the screen that makes it.
 */
export function pairLink(origin: string, token: string, pin: string | null): string {
  const fragment = pin === null ? token : `${PAIR_PIN_VERSION}.${pin}.${token}`;
  return `${normalize(origin)}/pair#${fragment}`;
}

/**
 * Parse `${origin}/pair#${fragment}`. A hand regex rather than `new URL`, so node tests and
 * Hermes parse identically. Refused, deliberately: a non-http(s) scheme (nothing else can be
 * redeemed against); any path but `/pair` (a token in the path would ride access logs); ANY query
 * string — `?token=` is the regression the fragment rule exists to prevent; an empty fragment; a
 * `k<n>` fragment this build does not understand, and a `k1` one whose fingerprint is the wrong
 * shape or whose token half is empty. Refusing a malformed pinned link is the point: the
 * alternative is redeeming the token with NO pin, the unencrypted pairing this shape exists to
 * make impossible.
 */
export function parsePairLink(text: string): PairLink | null {
  const m = /^(https?):\/\/([^/?#\s]+)(\/[^?#\s]*)?(\?[^#\s]*)?(?:#(\S+))?$/i.exec(text.trim());
  if (!m) return null;
  const [, scheme, host, path, query, fragment] = m;
  if (query !== undefined) return null;
  // The scheme match is case-insensitive (a QR encoder may upcase) and `normalize` lower-cases
  // the result, so one server stays one profile. The PATH comparison stays exact — /pair is a
  // route, and routes are case-sensitive.
  if ((path ?? "").replace(/\/+$/, "") !== "/pair") return null;
  const raw = (fragment ?? "").trim();
  if (raw === "") return null;
  const origin = normalize(`${scheme}://${host}`);

  // A VERSION PREFIX IS RECOGNISED BY ITS SHAPE, NOT BY EQUALITY WITH THE ONE WE KNOW. `k2.…`
  // must be refused as "a newer code than this app understands", never mistaken for a token.
  const versioned = /^(k\d+)\.(.*)$/s.exec(raw);
  if (versioned === null) return { origin, token: raw, pin: null };
  const [, version, rest] = versioned;
  if (version !== PAIR_PIN_VERSION) return null;
  const dot = rest!.indexOf(".");
  if (dot < 0) return null;
  const pin = rest!.slice(0, dot);
  const token = rest!.slice(dot + 1).trim();
  if (!isPairPin(pin) || token === "") return null;
  return { origin, token, pin };
}

/**
 * Does this origin need a pin to be safe to pair with? The rule is the host's SHAPE: an IP
 * literal cannot have a certificate anybody can check — TLS to one is either pinned or
 * unverified, and unverified is worth nothing; these MUST carry a pin. A DNS name can — the
 * hosted service and a self-host behind a real certificate are verified by the platform's trust
 * store, and a pin there only adds a way for pairing to break on renewal. LOOPBACK is exempt: no
 * network path to attack — the packets never leave the machine — and it is where the test suite's
 * servers live, so the rule is exercised. This decides nothing about the scheme: `http:` is
 * refused separately, loudly, by us.
 */
export function originNeedsPin(origin: string): boolean {
  const host = normalize(origin).replace(/^https?:\/\//, "").replace(/:\d+$/, "");
  if (host === "localhost" || host === "[::1]" || /^127\./.test(host)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // A bracketed IPv6 literal is the same case; the LAN door is IPv4-only today, so this is here
  // so that the day it is not, the answer is already the safe one.
  return host.startsWith("[");
}

/**
 * The twelve characters a person actually compares — first six, an ellipsis, last six. The
 * fingerprint is forty-three base64url characters; shown whole it is a credential-shaped string
 * nobody reads to the end, and a check nobody performs is worse than no check because it looks
 * like one. Twelve fits in one glance across two screens. It lives here because the comparison
 * has THREE ends: the desktop window shows this computer's key, the desktop's client door shows
 * the same twelve, and the PHONE is the third — a phone computing them by another rule makes the
 * desktop's sentence false. One function, in the package all three graphs compile. A value
 * shorter than the twelve it would elide is returned whole.
 */
export function shortPin(pin: string): string {
  return pin.length <= 13 ? pin : `${pin.slice(0, 6)}…${pin.slice(-6)}`;
}
