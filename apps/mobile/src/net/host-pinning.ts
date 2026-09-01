/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  PINNING A DESKTOP HOST'S KEY — the JS side of the trust the pairing ceremony carries
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A desktop's same-network door serves TLS with a self-signed key of its own, because no
 * certificate authority issues for the address a router handed that machine. The pairing link
 * carries that key's fingerprint; this module is where the phone remembers it, and the native
 * half (`modules/host-pinning`) is what makes the TLS stack honour it.
 *
 * ── THE ORDER IS NOT NEGOTIABLE: PIN, THEN ASK ──────────────────────────────────────────────
 *
 * `pin()` must be called BEFORE the first request to that host — including the `/hello`
 * negotiation, which happens before anything is redeemed. A request that goes out first would
 * be judged by the platform trust store, fail, and produce a refusal sentence about the network
 * for a reason that is not the network. That is why this surface is synchronous.
 *
 * ── AND WHERE THE NATIVE HALF IS ABSENT, THIS SAYS SO ───────────────────────────────────────
 *
 * The registry arrives through {@link installPinning} and is `null` until it does — which is the
 * state on the two surfaces where the native module genuinely is not there: the node test suite,
 * and **iOS, whose half is not built** (see below). {@link canPin} is what the pairing seam
 * checks, and a `false` there REFUSES a pairing that would need a pin — it never falls through to
 * an unpinned connection. Refusing to pair is a sentence somebody can act on; pairing without the
 * pin would be the app quietly accepting any key on the local network.
 *
 * The default being "cannot pin" rather than "pin somehow" is deliberate: a composition that
 * forgets to install the registry refuses same-network pairing loudly, instead of pairing over
 * TLS nobody checked.
 *
 * ── THE iOS HALF, NAMED RATHER THAN GUESSED ────────────────────────────────────────────────
 *
 * The platform-parity rule says a mobile change lands on both platforms. This one has landed on
 * Android and is NAMED for iOS, because there is no Mac in the environment it was built in and
 * uncompiled Swift asserting a security property is worse than an honest gap.
 *
 * What the iOS half is, precisely, so it is a task and not a research project:
 *
 *  · React Native's iOS networking runs through `RCTHTTPRequestHandler`, whose `NSURLSession` is
 *    created with itself as delegate. The seam is
 *    `URLSession:didReceiveChallenge:completionHandler:` with
 *    `NSURLAuthenticationMethodServerTrust`: read `challenge.protectionSpace.serverTrust`, take
 *    the leaf via `SecTrustCopyCertificateChain`, `SecCertificateCopyKey` +
 *    `SecKeyCopyExternalRepresentation`, wrap that raw key in the SPKI DER header for its
 *    algorithm, SHA-256 it, and compare against the pin recorded for
 *    `challenge.protectionSpace.host` + `.port`. A match calls back with
 *    `.useCredential(URLCredential(trust:))`; an unpinned host calls back `.performDefaultHandling`.
 *  · The delegate cannot be replaced from a module, so the iOS half is an
 *    `NSURLProtocol`-free swizzle-free approach: register the module's own
 *    `RCTHTTPRequestHandler` subclass ahead of RN's via `RCT_EXPORT_MODULE` priority, or supply
 *    the session delegate through `RCTSetCustomNSURLSessionConfigurationProvider` and keep the
 *    trust decision in the app delegate. Which of the two is a real decision to make against the
 *    RN version in the lockfile, with a device to test on.
 *  · Until it exists, {@link canPin} is `false` on iOS and same-network pairing is refused there
 *    with the sentence below. Tailscale pairing is unaffected on both platforms — that origin is
 *    a real name with a real certificate.
 */

/**
 * The native registry, behind a seam — the `servers-native.ts` idiom, and for the same reason:
 * the module that reaches for the platform API is separate, so the node suite can drive every
 * rule in this file without loading the Expo runtime, and can install a FAKE to exercise the
 * pinned path. `host-pinning-native.ts` is the real one; `connection.tsx` installs it once.
 */
export interface PinningNative {
  /**
   * Whether the native half actually installed its trust decision into the networking stack —
   * NOT merely whether the module loaded. The two came apart once and the cost was a failed
   * pairing reported as a changed key: see `HostPinningModule.installed`. {@link canPin} reads
   * this, so a module that loaded and did not install refuses the pairing instead of recording
   * a pin nothing honours.
   */
  isInstalled(): boolean;
  /**
   * How many clients the pinning factory has actually built. `0` with `isInstalled()` true is a
   * decision that exists and is never consulted — the exact state that made a real pairing fail
   * and be reported as a changed key. Read by the census; nothing in the product branches on it.
   */
  factoryUses(): number;
  setPin(host: string, port: number, spki: string): number;
  clearPin(host: string, port: number): number;
  clearAllPins(): number;
  pinnedCount(): number;
}

let native: PinningNative | null = null;

/**
 * Install the platform's pinning registry. `null` — the default, and what a build whose native
 * half is absent resolves to — means {@link canPin} is false and a pinned pairing is REFUSED.
 * Idempotent; the app calls it once at composition.
 */
export function installPinning(impl: PinningNative | null): void {
  native = impl;
}

/**
 * Can this build pin a key at all? `false` ⇒ a pinned pairing must be REFUSED, never attempted.
 *
 * Asks the native half whether it INSTALLED, not merely whether it exists — the distinction is
 * the whole of `PinningNative.isInstalled`'s docstring, and it is the difference between a pin
 * that is enforced and a pin that is merely remembered.
 */
export function canPin(): boolean {
  try {
    return native !== null && native.isInstalled();
  } catch {
    // A native surface that cannot answer is one that cannot be relied on to enforce anything.
    return false;
  }
}

/** `host` and `port` out of an origin, with the scheme's default port when none is written. */
export function hostPortOf(origin: string): { host: string; port: number } | null {
  const m = /^(https?):\/\/([^/:?#\s]+|\[[^\]]+\])(?::(\d+))?$/i.exec(origin.trim().replace(/\/+$/, ""));
  if (m === null) return null;
  const [, scheme, host, port] = m;
  return {
    host: host!.toLowerCase(),
    port: port !== undefined ? Number(port) : scheme!.toLowerCase() === "https" ? 443 : 80,
  };
}

/**
 * Accept `spki` — and nothing else — as the key for `origin`, from now until it is dropped.
 * Answers `false` when this build cannot pin, so a caller cannot mistake "not pinned" for
 * "pinned".
 */
export function pin(origin: string, spki: string): boolean {
  const at = hostPortOf(origin);
  if (native === null || at === null) return false;
  native.setPin(at.host, at.port, spki);
  return true;
}

/**
 * Drop the pin for `origin` — what forgetting a server owes the TLS stack. Best-effort by
 * design: a pin left behind cannot open anything (it only ever NARROWS what is accepted), so a
 * failure here must not hold a forget open.
 */
export function unpin(origin: string): void {
  const at = hostPortOf(origin);
  if (native === null || at === null) return;
  native.clearPin(at.host, at.port);
}

/** How many pins this phone holds. The forget guard reads it; nothing in the product does. */
export function pinnedCount(): number {
  return native?.pinnedCount() ?? 0;
}

/**
 * THE SENTENCE FOR A HANDSHAKE THAT FAILED THE PIN — the honest half of "a changed key un-pairs".
 *
 * When the desktop's key changes (its data directory was moved, restored from a backup, or
 * genuinely re-keyed), every request to it fails at the handshake. The platform's own words for
 * that are unreadable (`javax.net.ssl.SSLHandshakeException: Chain validation failed`), and worse
 * they are indistinguishable from "the wifi is bad" to anybody reading them. So the transport
 * error is recognised and replaced.
 *
 * Recognised by SHAPE rather than by an exact string: the wording differs across Android
 * versions and providers, and a failed match here degrades to the generic "could not reach"
 * sentence — wrong, but not misleading, which is the right direction to be wrong in.
 */
const HANDSHAKE = /SSLHandshake|CertPathValidator|Chain validation|Trust anchor|certificate|SSLPeerUnverified|hostname/i;

export function isPinFailure(error: unknown): boolean {
  return HANDSHAKE.test(String(error));
}

/** What to show when a paired desktop presents a key this phone did not agree to. */
export const PIN_CHANGED_SENTENCE =
  "This computer's identity has changed since you paired with it, so ohmail stopped rather than " +
  "trusting it. If you reinstalled ohmail on that computer or restored it from a backup, open " +
  "Settings → Devices there and pair this phone again with a fresh code. If you did not, " +
  "something on your network is answering for it.";
