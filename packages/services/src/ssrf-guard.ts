import {
  SsrfRefusal,
  assertPublicHttpUrl as coreAssertPublicHttpUrl,
  assertPublicHost as coreAssertPublicHost,
  type PublicUrlOptions,
} from "@trafficflow/core/net";
import { ServiceError } from "./errors.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE SSRF GATE, AS THIS PACKAGE'S CALLERS HAVE ALWAYS SEEN IT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The IMPLEMENTATION moved to `@trafficflow/core/net` — parsers, refusal sets, the pin, all of it
 * verbatim — because `apps/worker` needs the same gate for the UnifiedPush wake sender and may not
 * import this package (its dependency test forbids it; the services barrel in the worker's boot
 * graph is a measured Node-23 `ERR_REQUIRE_CYCLE_MODULE`). The full argument is at the top of
 * `packages/core/src/net/ssrf-guard.ts`.
 *
 * What stayed here is the ERROR CONTRACT, and it stayed because it is a wire contract: three
 * callers (`unsubscribe-service`, `privacy-service`, `packages/api/src/imap-probe`) let this throw
 * reach a route, where it becomes `validation_failed` / 400 / `u is not a permitted url: <why>`.
 * The core gate cannot produce that — it sits below HTTP and has no `ServiceError` — so these two
 * functions map {@link SsrfRefusal} onto it and re-throw anything else untouched. Every existing
 * import of these names is unchanged, deliberately: a security refactor that also edits its
 * callers is a refactor whose blast radius nobody can bound by reading it.
 *
 * `isBlockedAddress`, `nodeHostResolver` and `HostResolver` are pure re-exports — they never threw
 * a `ServiceError` and have nothing to map.
 */

export {
  isBlockedAddress, nodeHostResolver,
  type HostResolver, type PublicUrlOptions,
} from "@trafficflow/core/net";

/**
 * Re-wrap a core refusal as the `ServiceError` this package's callers have always caught. Anything
 * that is NOT a refusal is rethrown as itself — a resolver that blew up in some novel way is a
 * fault, not a 400, and flattening it into one would tell a user their URL is malformed when the
 * truth is that our own DNS port is broken.
 */
function asServiceError(err: unknown): unknown {
  if (err instanceof SsrfRefusal) {
    return new ServiceError("validation_failed", 400, `u is not a permitted url: ${err.why}`);
  }
  return err;
}

/**
 * The SSRF gate for every caller-supplied URL this service is willing to fetch. See
 * `@trafficflow/core/net`'s `assertPublicHttpUrl` for the whole argument, including why the return
 * value — the validated addresses — is load-bearing and must be handed to `pinnedHttpRequest`
 * rather than thrown away.
 */
export async function assertPublicHttpUrl(
  raw: string, resolver: { resolve(hostname: string): Promise<string[]> }, opts: PublicUrlOptions = {},
): Promise<string[]> {
  try {
    return await coreAssertPublicHttpUrl(raw, resolver, opts);
  } catch (err) {
    throw asServiceError(err);
  }
}

/**
 * The host half of {@link assertPublicHttpUrl}, for a caller that has a HOSTNAME rather than a URL
 * (the IMAP/SMTP add-time probe dials `host:port` on transports the gate knows nothing about).
 */
export async function assertPublicHost(
  hostname: string, resolver: { resolve(hostname: string): Promise<string[]> },
): Promise<string[]> {
  try {
    return await coreAssertPublicHost(hostname, resolver);
  } catch (err) {
    throw asServiceError(err);
  }
}
