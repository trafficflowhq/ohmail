/**
 * The request port for a provider whose hosts are fixed names in code (Google, Microsoft). The same
 * gate, pin, headers and ceilings as for a host a person named; on top of them no host outside the
 * set is dialled, and no redirect is followed: a 3xx comes back as the answer it is.
 */
import { canonicalHost, pinnedHttpRequest } from "@trafficflow/core/net";
import { ANSWER_TIMEOUT_MS, CONNECT_TIMEOUT_MS, FETCH_BODY_MAX_BYTES } from "../limits.js";
import { guardedRequest } from "./guarded.js";
import type { HttpPort } from "./index.js";
import type { RequestDeps } from "./named-host.js";

export function fixedHostRequest(hosts: ReadonlySet<string>, deps: RequestDeps): HttpPort {
  return guardedRequest({
    resolver: deps.resolver,
    policy: deps.policy,
    request: pinnedHttpRequest,
    hosts: new Set([...hosts].map(canonicalHost)),
    limits: { connectMs: CONNECT_TIMEOUT_MS, totalMs: ANSWER_TIMEOUT_MS, maxRedirects: 0, maxBodyBytes: FETCH_BODY_MAX_BYTES },
  });
}
