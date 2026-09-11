import { networkInterfaces } from "node:os";
import { jsonResponse, type Route } from "@trafficflow/api/local";

/**
 * The one route the LAN ceremony needs — which addresses this computer could serve on
 * (`GET /local/lan/candidates`, the IPv4 addresses of real interfaces). The rule is "an explicit
 * second bind to a CHOSEN interface, never `0.0.0.0` blindly", so the window must OFFER the choice,
 * and the process that owns the sockets can enumerate them (`os.networkInterfaces()`). Window-only,
 * stdio door only — mounted beside `localAiRoutes`, never in `desktopHostRoutes`, so a paired device
 * cannot enumerate the host's interfaces — and mounted UNARMED, since the ceremony offers LAN before
 * host mode exists. Filtered: internal/non-IPv4 (loopback is the host door's bind), 169.254/16
 * link-local, and 100.64/10 (Tailscale's CGNAT, where the real HTTPS path already exists).
 */

/** One offerable interface address. */
export interface LanCandidate {
  address: string;
  /** The interface's own name (`en0`, `eth0`, `Wi-Fi`) — the operator's handle on "which one". */
  name: string;
}

/** Is this IPv4 address in 100.64.0.0/10 — the CGNAT range Tailscale uses? */
function isCgnat(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

/** The addresses this machine could serve same-network access on, filtered as the header says. */
export function lanCandidates(
  interfaces: () => ReturnType<typeof networkInterfaces> = networkInterfaces,
): LanCandidate[] {
  const out: LanCandidate[] = [];
  for (const [name, list] of Object.entries(interfaces())) {
    for (const iface of list ?? []) {
      if (iface.internal || iface.family !== "IPv4") continue;
      if (iface.address.startsWith("169.254.") || isCgnat(iface.address)) continue;
      out.push({ address: iface.address, name });
    }
  }
  return out;
}

/**
 * The two routes the LAN ceremony needs. `candidates` is closed over nothing — the answer is the
 * machine's, read fresh per request. `pin` is closed over a THUNK, not a value, so the window always
 * reads the identity the engine actually holds; a captured value would let a route mounted before the
 * identity resolved answer `null` for the life of the process. The fingerprint is not a secret (a
 * public key's hash is public — anything completing a handshake learns it), so the route protects
 * nothing by being narrow; it is narrow anyway for `candidates`' reason — `desktopHostRoutes` is what
 * a paired device reaches, and adding anything it does not need is how that surface grows one
 * reasonable-looking route at a time.
 */
export function localLanRoutes(fingerprint: () => string | null): Route[] {
  return [
    {
      method: "GET",
      pattern: "/local/lan/candidates",
      relay: false,  /* served by this engine; never forwarded */
      cost: "read",
      handler: async () => jsonResponse({ items: lanCandidates() }, { status: 200 }),
    },
    {
      method: "GET",
      pattern: "/local/lan/pin",
      relay: false,  /* served by this engine; never forwarded */
      cost: "read",
      // `null` is the honest answer in three different states — same-network access was never
      // turned on, it was refused at config, or its key could not be established — and the
      // window renders the same thing for all three: no pairing link for this address. Which of
      // the three it is is `lanState`'s to say, and it says it in one sentence.
      handler: async () => jsonResponse({ fingerprint: fingerprint() }, { status: 200 }),
    },
  ];
}
