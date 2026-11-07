import type { ThrottleKeys } from "./auth/throttle-keys.js";
import { bridgeTx, type ServiceContext } from "./context.js";
import { reserveIpSlot } from "./ip-throttle.js";
import { LIVE_BODY_PER_HOUR } from "./live-body.js";

/** The window {@link LIVE_BODY_PER_HOUR} counts over. */
export const LIVE_BODY_WINDOW_MS = 60 * 60 * 1000;

/**
 * LOAD IT NOW's admission on a host that empties letters for space: the one slot limiter, under its
 * own namespace and keyed by the ACCOUNT (the keyed hash, as every key there is), {@link
 * LIVE_BODY_PER_HOUR} an hour. A claim that could not be counted refuses, as the limiter does.
 */
export function liveBodyAdmitter(keys: ThrottleKeys): (ctx: ServiceContext) => Promise<boolean> {
  return (ctx) => reserveIpSlot(bridgeTx(ctx.db), keys, {
    namespace: "live-body", ip: ctx.accountId, now: ctx.now(), max: LIVE_BODY_PER_HOUR, windowMs: LIVE_BODY_WINDOW_MS,
  });
}
