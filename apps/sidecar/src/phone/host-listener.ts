/**
 * HOST MODE, ON A BUILD THAT HAS NO HOST DOOR — the phone's answer to `resolveHostConfig`.
 *
 * Substituted for `../host-listener.js` in the phone's engine bundle. The desktop's module resolves
 * three shell-supplied knobs into an armed or degraded state and builds the served origin's auth
 * config; it also owns the loopback listener that binds the door. A phone serves no door to anyone
 * — invariant: the phone is never a host — so the honest answer is a permanently disarmed state.
 *
 * ANSWERS RATHER THAN THROWS, and that is not a style choice: `createSidecar` calls
 * `resolveHostConfig(config)` unconditionally, before it knows anything about the install. A
 * thrower here is a phone that cannot start.
 *
 * `reason` is `null` because the field means "host mode was asked for and refused", and on this
 * build it is never asked for: `startPhoneEngine` REFUSES a config carrying `hostMode`,
 * `hostOrigin`, `hostPort`, `hostAssetsDir` or `lanBind` before any of this runs. The `hostMode`
 * arm below is therefore unreachable, and it is written as a named refusal rather than left out so
 * that a future caller who bypasses that check gets a sentence instead of a silently disarmed door.
 */
import type { HostState } from "../host-listener.js";

/** No auth config, for the reason the desktop's own field states: there is no served origin. */
export interface ResolvedHostConfig {
  state: HostState;
  authConfig: null;
}

/**
 * THE BYTE CEILING FOR A SEND THROUGH THE HOST DOOR, duplicated by value.
 *
 * `engine.ts` reads this constant into the send surface's options on every composition, host mode
 * or not, so the phone needs a number here. It is deliberately the SAME number as the desktop's
 * (32 MiB) rather than a phone-specific one: this bundle's send surface is the same code with the
 * same adapter budget behind it, and a quieter ceiling here would be a second limit nobody chose.
 *
 * A duplicated constant is a drift hazard, so it is not left to a comment: the suite that checks
 * the phone's substitutions reads BOTH modules and fails if the two numbers stop agreeing.
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
