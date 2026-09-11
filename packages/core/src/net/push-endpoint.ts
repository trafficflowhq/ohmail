import {
  SsrfRefusal, assertPublicHttpUrl, resolvePinUnchecked, type HostResolver,
} from "./ssrf-guard.js";

/**
 * The UnifiedPush endpoint gate — one policy, read at registration AND at every send. An endpoint
 * is a URL the DEVICE chose, POSTed to unattended by a process holding database credentials and
 * KEK material — the SSRF shape, dialled long after validation: a name public in January can
 * resolve to `169.254.169.254` in March. Registration-time clearance is not send-time clearance,
 * which is why this returns the PIN, not a boolean. In `core` because the worker may import core
 * + db only. STRICT (absent-means-strict): https only, public addresses, an explicit port
 * allowed. RELAXED (`allowPrivate`): the operator's own LAN — the URL must still parse, be
 * http(s), carry no userinfo, and RESOLVE.
 */

/**
 * How long an endpoint URL may be. Distributor endpoints are short (an origin plus a topic or an
 * opaque token); 2 KB is generous and it is here because the string is stored, indexed by a
 * coalesced UNIQUE, and read by a background sender — an unbounded one is a row nobody can index
 * and a log line nobody can read.
 */
export const PUSH_ENDPOINT_MAX_LEN = 2048;

/**
 * The gate. `check` RETURNS THE PIN — the validated addresses the socket may connect to — and
 * throws {@link SsrfRefusal} to refuse. It deliberately does not return a boolean: a caller that
 * got `true` would then hand the hostname to a dialler that resolves it again, which is the
 * time-of-check/time-of-use hole the pin exists to close.
 */
export interface PushEndpointGuard {
  check(endpoint: string): Promise<string[]>;
}

/**
 * Build the gate for a deployment. `allowPrivate` is REQUIRED rather than defaulted, so that a new
 * composition root has to state its policy instead of inheriting one by silence.
 */
export function makePushEndpointGuard(
  resolver: HostResolver, opts: { allowPrivate: boolean },
): PushEndpointGuard {
  return {
    async check(endpoint: string): Promise<string[]> {
      if (endpoint === "") throw new SsrfRefusal("endpoint is empty");
      if (endpoint.length > PUSH_ENDPOINT_MAX_LEN) throw new SsrfRefusal("endpoint is too long");
      // `httpsOnly` is passed EXPLICITLY on the strict arm rather than relied on as a default —
      // the gate's default is both schemes, because that is what every other caller has always
      // had, and a scheme rule this transport wants is this transport's to state.
      return opts.allowPrivate
        ? resolvePinUnchecked(endpoint, resolver)
        : assertPublicHttpUrl(endpoint, resolver, { allowExplicitPort: true, httpsOnly: true });
    },
  };
}
