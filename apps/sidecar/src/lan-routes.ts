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

/** The route, closed over nothing — the answer is the machine's, read fresh per request. */
export function localLanRoutes(): Route[] {
  return [
    {
      method: "GET",
      pattern: "/local/lan/candidates",
      cost: "read",
      handler: async () => jsonResponse({ items: lanCandidates() }, { status: 200 }),
    },
  ];
}
