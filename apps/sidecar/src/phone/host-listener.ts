/**
 * Host mode, on a build that has no host door — the phone's answer to `resolveHostConfig`,
 * substituted for `../host-listener.js`. The desktop's module resolves three shell knobs into an
 * armed or degraded state and owns the loopback listener; a phone serves no door to anyone (the
 * phone is never a host), so the honest answer is a permanently disarmed state. ANSWERS rather than
 * throws — `createSidecar` calls `resolveHostConfig(config)` unconditionally — so a thrower is a
 * phone that cannot start. `reason` is `null` because host mode is never asked for here
 * (`startPhoneEngine` REFUSES `hostMode`/`hostOrigin`/`hostPort`/`hostAssetsDir`/`lanBind`), so the
 * `hostMode` arm is unreachable and written as a named refusal for a future caller who bypasses that check.
 */
import type { HostState } from "../host-listener.js";

/** No auth config, for the reason the desktop's own field states: there is no served origin. */
export interface ResolvedHostConfig {
  state: HostState;
  authConfig: null;
}

/**
 * The byte ceiling for a send through the host door, duplicated by value. `engine.ts` reads this
 * constant into the send surface on every composition, host mode or not, so the phone needs a number
 * here. It is deliberately the SAME number as the desktop's (32 MiB), not a phone-specific one: this
 * bundle's send surface is the same code with the same adapter budget, and a quieter ceiling would be
 * a second limit nobody chose. A duplicated constant is a drift hazard, so it is not left to a
 * comment — the substitution suite reads BOTH modules and fails if the two numbers stop agreeing.
 */
export const HOST_SEND_MAX_TOTAL_BYTES = 32 * 1024 * 1024;

export function resolveHostConfig(
  cfg: { hostMode?: boolean; hostOrigin?: string; hostPort?: number },
): ResolvedHostConfig {
  if (cfg.hostMode === true) {
    return {
      state: {
        armed: false,
        origin: null,
        port: null,
        reason:
          "this build has no host door: a phone organizes its own mailbox and never serves one " +
          "to another device",
      },
      authConfig: null,
    };
  }
  return { state: { armed: false, origin: null, port: null, reason: null }, authConfig: null };
}
