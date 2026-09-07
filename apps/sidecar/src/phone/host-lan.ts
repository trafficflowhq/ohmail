/**
 * SAME-NETWORK ACCESS, ON A BUILD THAT SERVES NOBODY — the phone's answer to `resolveLanBind`.
 *
 * Substituted for `../host-lan.js`. The desktop's module validates an interface literal, binds a
 * TLS listener on it and serves a script-free explainer to anything that is not the API. This build
 * has no listener and no second door, so LAN is off with no reason: the field means "asked for and
 * refused", and `startPhoneEngine` refuses a `lanBind` before this is reached.
 *
 * ANSWERS RATHER THAN THROWS — `resolveLanBind(config)` is called unconditionally at composition.
 * `serveLanFallback` is the opposite case and refuses by name: it is reachable only from the LAN
 * door's request path, and there is no LAN door here.
 */
import type { LanState } from "../host-lan.js";

export function resolveLanBind(cfg: { hostMode?: boolean; lanBind?: string }): LanState {
  if ((cfg.lanBind?.trim() ?? "") !== "") {
    return {
      address: null,
      reason:
        "this build has no same-network door: a phone organizes its own mailbox and never serves " +
        "one to another device",
    };
  }
  return { address: null, reason: null };
}

/**
 * Unreachable: no LAN address is ever resolved above, so no LAN listener exists to route into this.
 * A refusal rather than a `Response` because a 404 would suggest a door that is merely empty.
 */
export function serveLanFallback(_req: Request): Response {
  throw new Error(
    "serveLanFallback was reached on a build with no same-network door. This is a composition " +
      "error, not a request: a phone serves no door, so nothing should be able to route here.",
  );
}
