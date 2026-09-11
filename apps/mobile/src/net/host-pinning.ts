/**
 * Pinning a desktop host's key — the JS side of the trust the pairing ceremony carries. The
 * desktop's same-network door serves TLS with a self-signed key; the pairing link carries its
 * fingerprint, this module remembers it, and the native half (`modules/host-pinning`) makes the
 * TLS stack honour it. `pin()` runs before the first request (`/hello` included), or the
 * platform trust store fails it with a network-shaped sentence — why this is synchronous. The
 * registry ({@link installPinning}) is `null` where the native half is absent (the node suite,
 * and iOS, not yet built): {@link canPin} false refuses a pairing that needs a pin, never
 * unpinned. The iOS half is named precisely (`NSURLSession` server-trust seam, SPKI SHA-256); Tailscale is unaffected.
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
 * The sentence for a handshake that failed the pin — the honest half of "a changed key
 * un-pairs". When the desktop's key changes (data directory moved, restored, re-keyed), every
 * request fails at the handshake, and the platform's own words are unreadable and
 * indistinguishable from bad wifi. So the transport error is recognised and replaced —
 * recognised by shape rather than exact string, since the wording differs across Android
 * versions; a failed match degrades to the generic "could not reach" sentence — wrong, but
 * not misleading, which is the right direction to be wrong in.
 */
const HANDSHAKE = /SSLHandshake|CertPathValidator|Chain validation|Trust anchor|certificate|SSLPeerUnverified|hostname/i;

export function isPinFailure(error: unknown): boolean {
  return HANDSHAKE.test(String(error));
}

/**
 * An address that answers without TLS — the failed dial {@link isPinFailure} does not
 * recognise. Plain http on the typed port is the likeliest self-hosting mistake, and its first
 * bytes are not a TLS record: Android says `SSLException: Unable to parse TLS packet header`,
 * which nothing in `HANDSHAKE` matches, so the raw exception reached a screen. The two sets
 * are disjoint, and `test/host-pinning.test.ts` asserts it rather than trusting the reading.
 * Android's wording names the cause; iOS's `NSURLErrorSecureConnectionFailed` (-1200) covers
 * cipher and version mismatches too and is taken from documented constants, so
 * `Copy.notEncrypted` names the usual cause without asserting it.
 */
const NOT_TLS =
  /Unable to parse TLS packet|NSURLErrorSecureConnectionFailed|Code=-1200|An SSL error has occurred/i;

export function isNotTls(error: unknown): boolean {
  return NOT_TLS.test(String(error));
}

/*
 * The sentence that used to stand here is now `Copy.pinChanged`: prose is translated, and
 * leaving it beside {@link isPinFailure} would have made it the single refusal on the phone
 * that could not be German — the two callers (`net/pairing.ts` and the deck's own
 * `connectSyncFailed`) read it from the deck. The regex stayed: it matches a platform's own
 * error text (`javax.net.ssl.SSLHandshakeException` and neighbours), which has no language of
 * ours in it and must not acquire one.
 */
