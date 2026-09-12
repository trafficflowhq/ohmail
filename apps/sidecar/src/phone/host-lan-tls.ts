/**
 * The LAN door's TLS identity, on a build with no LAN door — substituted for `../host-lan-tls.js`.
 * The desktop's module mints and persists a key and certificate and derives the fingerprint a paired
 * phone pins; both halves are impossible and unwanted here (this build writes no PEM files, having no
 * filesystem module, and pins nothing to itself). REFUSES, and may: `ensureLanIdentity` is called
 * only when `resolveLanBind` returned an address, and the substitute never returns one. The refusal
 * is shaped as the desktop's own `LanIdentityOutcome` refusal arm rather than a throw, so a caller
 * that somehow reached it degrades with a sentence in `lanState.reason` rather than failing the
 * composition.
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
