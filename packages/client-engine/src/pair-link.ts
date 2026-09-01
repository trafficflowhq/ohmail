/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PAIRING LINK — one shape, composed on the desktop, parsed on the phone
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `${origin}/pair#${fragment}` is the QR the Devices pane draws and the string the phone's
 * scanner (or the paste field) reads. It lives HERE — in the one package both sides already
 * compile (`apps/desktop/src` aliases it to source in its vite config; `apps/mobile` has it as a
 * workspace dependency) — because the composer and the parser drifting apart is a pairing that
 * fails on a stranger's kitchen table with nothing to look at.
 *
 * ── THE FRAGMENT, AND WHY THE TOKEN IS STILL IN IT ──────────────────────────────────────────
 *
 * The token rides the FRAGMENT and not the query or the path, for the reasons the Invites pane
 * established: a fragment is not sent in the page request, cannot land in an access log, and
 * never rides a `Referer`. That rule is unchanged and the parser still refuses a token moved
 * anywhere else.
 *
 * What is new is the KEY FINGERPRINT beside it. The desktop's same-network door serves TLS with
 * a key of its own (`apps/sidecar/src/host-lan-tls.ts`), because a release build of the mobile
 * app cannot open a cleartext socket at all — and no certificate authority will vouch for a DHCP
 * address. So the ceremony carries the trust: the fingerprint the person scans is the key the
 * phone will accept, and nothing else.
 *
 * Two forms, and the parser reads both:
 *
 *   `#<token>`                    the original. No pin. Still correct for every origin whose
 *                                 certificate a phone can check on its own — the hosted service,
 *                                 and a self-host box with a real name and a real certificate.
 *   `#k1.<fingerprint>.<token>`   pinned. `k1` is the pin format's version, so a later scheme
 *                                 (a second key, a different hash) is `k2` and an old phone
 *                                 refuses it by name instead of misreading it.
 *
 * ── WHY A VERSIONED PREFIX RATHER THAN "SPLIT ON THE DOT" ───────────────────────────────────
 *
 * The token is `generateToken()` — 32 random bytes, base64url — whose alphabet contains no dot,
 * so a bare split would work today. It is not what happens today that decides this: a fragment
 * with no self-description is one whose next revision cannot be distinguished from a corrupted
 * copy of this one. With the prefix, a phone that has never heard of `k2` says so; without it,
 * the same phone would hand a `k2` fingerprint to a server as a pairing token and report
 * "that pairing code was not accepted".
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
 * Hermes parse identically. Refused, deliberately:
 *  · a non-http(s) scheme (nothing else can be redeemed against);
 *  · any path but `/pair` (a token in the path would ride access logs);
 *  · ANY query string — `?token=` is the regression the fragment rule exists to prevent;
 *  · an empty fragment (there is no token to redeem);
 *  · a `k<n>` fragment this build does not understand, and a `k1` one whose fingerprint is not
 *    the right shape or whose token half is empty. Refusing a malformed pinned link is the
 *    point: the alternative is redeeming the token with NO pin, which is the unencrypted
 *    pairing this whole shape exists to make impossible.
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
 * DOES THIS ORIGIN NEED A PIN TO BE SAFE TO PAIR WITH?
 *
 * The rule is the host's SHAPE, and it is the honest line rather than a convenient one:
 *
 *  · **An IP literal cannot have a certificate anybody can check.** No public authority issues
 *    for `192.168.1.10`, so a TLS connection to one is either pinned or unverified — and
 *    unverified is worth nothing at all. These MUST carry a pin.
 *  · **A DNS name can.** The hosted service (`api.ohmail.app`) and a self-host box behind the
 *    operator's own certificate are verified by the platform's trust store exactly as any other
 *    site is, and a pin there would add a way for the pairing to break on renewal without adding
 *    any security the trust store does not already provide.
 *  · **LOOPBACK is exempt, and it is an exemption rather than an oversight.** `127.0.0.1` and
 *    `localhost` are an IP literal and a name that no authority issues for either — but there is
 *    no network path to attack: the packets never leave the machine, so there is nothing for a
 *    pin to authenticate against an attacker who by construction is already inside. It is also
 *    where the node test suite's servers live, which means the rule is exercised rather than
 *    merely stated.
 *
 * Note what this deliberately does NOT do: decide anything about the scheme. `http:` is refused
 * separately and for a different reason (the platform will not open the socket, and a downgrade
 * must be refused loudly by us rather than obscurely by the OS) — see `pairWithServer`.
 */
export function originNeedsPin(origin: string): boolean {
  const host = normalize(origin).replace(/^https?:\/\//, "").replace(/:\d+$/, "");
  if (host === "localhost" || host === "[::1]" || /^127\./.test(host)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // A bracketed IPv6 literal is the same case; the LAN door is IPv4-only today, so this is here
  // so that the day it is not, the answer is already the safe one.
  return host.startsWith("[");
}
