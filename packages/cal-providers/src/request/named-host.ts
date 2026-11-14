/**
 * The request port for a host a person named: a subscription's address, a CalDAV server. It follows
 * a few redirects itself, each through the gate again; the pinned request below it follows none.
 */
import { pinnedHttpRequest, type HostResolver } from "@trafficflow/core/net";
import { ANSWER_TIMEOUT_MS, CONNECT_TIMEOUT_MS, FETCH_BODY_MAX_BYTES, MAX_REDIRECTS } from "../limits.js";
import { guardedRequest, type AddressPolicy } from "./guarded.js";
import type { HttpPort } from "./index.js";

export type { AddressPolicy } from "./guarded.js";

/** What the composing program names. Neither has a default: an absent policy must not select the open one, nor an absent resolver the refusing branch alone. */
export interface RequestDeps {
  readonly resolver: HostResolver;
  readonly policy: AddressPolicy;
}

export function namedHostRequest(deps: RequestDeps): HttpPort {
  return guardedRequest({
    resolver: deps.resolver,
    policy: deps.policy,
    request: pinnedHttpRequest,
    hosts: null,
    limits: { connectMs: CONNECT_TIMEOUT_MS, totalMs: ANSWER_TIMEOUT_MS, maxRedirects: MAX_REDIRECTS, maxBodyBytes: FETCH_BODY_MAX_BYTES },
  });
}
