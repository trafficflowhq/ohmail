import { networkInterfaces } from "node:os";
import { jsonResponse, type Route } from "@trafficflow/api/local";

/**
 * THE ONE ROUTE THE LAN CEREMONY NEEDS — which addresses this computer could serve on.
 *
 *   GET /local/lan/candidates   the IPv4 addresses of this machine's real network interfaces
 *
 * The rule is "an explicit second bind to a CHOSEN LAN interface, never `0.0.0.0` blindly" —
 * which means the window must be able to OFFER the choice, and the process that owns the sockets
 * is the one that can enumerate them (`os.networkInterfaces()`; the webview has no Node and the
 * shell has no interface API without a new dependency). Window-only, stdio door only: this is
 * mounted beside `localAiRoutes` and never enters `desktopHostRoutes`, so a paired device can
 * never enumerate the host machine's interfaces. It is mounted UNARMED too, deliberately — the
 * enable ceremony offers the LAN option before host mode exists, so the list has to be readable
 * first.
 *
 * What is filtered, and why each line:
 *  · internal / non-IPv4 — the LAN door itself is IPv4-only in v1 (`resolveLanBind`), and
 *    loopback is the host door's own bind.
 *  · 169.254.0.0/16 — link-local: an address the machine assigned itself when nothing answered,
 *    which is exactly the network state where handing it to another device helps nobody.
 *  · 100.64.0.0/10 — the CGNAT range Tailscale numbers its interfaces from: reachable only over
 *    the tailnet anyway, where the real Tailscale path (HTTPS, browser-capable) already exists —
 *    offering it here as "same-network" would be the pane recommending the worse spelling of a
 *    path it already serves properly.
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
 * The two routes the LAN ceremony needs.
 *
 * `candidates` is closed over nothing — the answer is the machine's, read fresh per request.
 * `pin` is closed over a THUNK rather than a value, so the window always reads the identity the
 * engine actually holds; a captured value would let a route mounted before the identity resolved
 * answer `null` for the life of the process.
 *
 * ── WHY THE FINGERPRINT IS NOT A SECRET, AND WHY THE ROUTE IS STILL WINDOW-ONLY ──────────────
 *
 * A public key's hash is public by construction — anything that completes a handshake with the
 * door learns it. So this route protects nothing by being narrow, and it is narrow anyway, for
 * the same reason `candidates` is: `desktopHostRoutes` is the surface a PAIRED DEVICE can reach,
 * and adding to it anything a paired device does not need is how that surface grows one
 * reasonable-looking route at a time. The window needs it (to compose the pairing link); a
 * paired phone already has it (it pinned it).
 */
export function localLanRoutes(fingerprint: () => string | null): Route[] {
  return [
    {
      method: "GET",
      pattern: "/local/lan/candidates",
      cost: "read",
      handler: async () => jsonResponse({ items: lanCandidates() }, { status: 200 }),
    },
    {
      method: "GET",
      pattern: "/local/lan/pin",
      cost: "read",
      // `null` is the honest answer in three different states — same-network access was never
      // turned on, it was refused at config, or its key could not be established — and the
      // window renders the same thing for all three: no pairing link for this address. Which of
      // the three it is is `lanState`'s to say, and it says it in one sentence.
      handler: async () => jsonResponse({ fingerprint: fingerprint() }, { status: 200 }),
    },
  ];
}
