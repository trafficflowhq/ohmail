/**
 * THE LAN DOOR'S TLS IDENTITY, ON A BUILD WITH NO LAN DOOR — substituted for `../host-lan-tls.js`.
 *
 * The desktop's module mints and persists a key and certificate in the data directory and derives
 * the fingerprint a paired phone pins. Both halves are impossible and unwanted here: this build
 * writes no PEM files (it has no filesystem module) and pins nothing to itself.
 *
 * REFUSES, and may: `ensureLanIdentity` is called only when `resolveLanBind` returned an address,
 * and the substitute above never returns one. The refusal is shaped as the desktop's own
 * `LanIdentityOutcome` refusal arm rather than as a throw, so that a caller which somehow reached
 * it degrades exactly as it does for a real refusal — with a sentence in `lanState.reason` — rather
 * than failing the whole composition.
 */
import type { LanIdentity, LanIdentityOutcome } from "../host-lan-tls.js";

export type { LanIdentity };

export function ensureLanIdentity(_dataDir: string, _log?: unknown): LanIdentityOutcome {
  return {
    kind: "refused",
    refusal: {
      reason:
        "this build has no same-network door, so it mints no certificate for one",
    },
  };
}
