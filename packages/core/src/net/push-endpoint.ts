import {
  SsrfRefusal, assertPublicHttpUrl, resolvePinUnchecked, type HostResolver,
} from "./ssrf-guard.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE UNIFIEDPUSH ENDPOINT GATE — ONE policy, read at registration AND at every send
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A UnifiedPush endpoint is a URL the DEVICE chose: the user picks a distributor (ntfy, NextPush,
 * Sunup, a self-hosted one), the distributor mints an endpoint, and the app registers that string
 * with us. From the server's point of view it is a caller-supplied URL that a background process
 * will POST to, unattended, for as long as the registration lives. That is the SSRF shape exactly,
 * with two aggravations an ordinary webhook does not have:
 *
 *  · it is dialled REPEATEDLY and by a process with database credentials and KEK material
 *    (`apps/worker`), not once by a request handler;
 *  · the dial happens long after the registration was validated, so a name that resolved to a
 *    public address in January can resolve to `169.254.169.254` in March. **Registration-time
 *    clearance is not send-time clearance**, which is why this guard is called in BOTH places and
 *    why it returns the PIN rather than a boolean.
 *
 * ── WHY IT LIVES IN `core` AND NOT BESIDE EITHER CALLER ───────────────────────────────────────
 *
 * `PushService.subscribe` (in `packages/services`) validates at registration; the wake sender (in
 * `apps/worker`) validates at send. The worker may import `@trafficflow/core` and
 * `@trafficflow/db` and nothing else, enforced by that app's own dependency test. So a policy
 * written beside the registration would have to be copied to reach the sender — and the copy that
 * matters is the one where a range is added on one side only. One policy, two callers.
 *
 * ── THE TWO ARMS, AND WHY THE ABSENT VALUE PICKS THE STRICT ONE ───────────────────────────────
 *
 * STRICT (managed, and every self-host that has not said otherwise): https only, public addresses
 * only, an explicit port allowed. The port allowance is not a hole — a self-hosted distributor
 * behind a reverse proxy on 8443 is ordinary, and the address rules are untouched by it. The
 * https-only rule is a PRIVACY rule as much as a security one: a plaintext wake tells anyone on
 * the path that this account just received mail, which is the one fact the content-free payload
 * exists to withhold.
 *
 * RELAXED (`allowPrivate`): the address rules are skipped and `http:` is permitted, for the
 * operator whose distributor is on their own LAN — the same decision, and the same shape, as
 * `TF_PROBE_ALLOW_PRIVATE` for the add-mailbox probe. It is reached ONLY by an explicit operator
 * value; the absent value selects STRICT, because a security default obtained by omission is not a
 * default anyone chose. What the relaxed arm does NOT skip: the URL must parse, be http(s), carry
 * no userinfo, and RESOLVE — because the return value is still the pin, and dialling by name would
 * put the rebinding window back on the one arm that was meant to be the operator's own network.
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
