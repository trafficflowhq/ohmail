/**
 * The first-run gate — which surface owns the screen, decided from the connection state; pure, so the suite
 * holds it without a renderer. `boot`: the launch instant, before the keystore has answered — render nothing,
 * since painting welcome here would flash onboarding at every cold start of a paired phone. `welcome`:
 * nothing paired, nothing wrong — the connect flow, never an empty mail UI. `connecting`: a boot or switch in
 * flight — the instant shell with the list silhouette, never a text screen, and never long (the boot is
 * local). `servers`: not live with something to say — disconnected with pairings, a refusal, an ended
 * session; a refusal lands here even with zero pairings, because the welcome screen has no status panel to
 * explain what happened. `mail`: live — the tabs render the mirror.
 */
import type { ConnectionState } from "../net/connection";

export type GateVerdict =
  | { to: "boot" }
  | { to: "welcome" }
  | { to: "connecting"; origin: string }
  | { to: "servers" }
  | { to: "mail" };

export function gateFor(state: ConnectionState, profileCount: number): GateVerdict {
  if (state.k === "live") return { to: "mail" };
  if (state.k === "starting") return { to: "boot" };
  if (state.k === "connecting") return { to: "connecting", origin: state.origin };
  // A refusal or a death carries a sentence the reader must be able to see — Servers
  // renders it whatever the pairing count. Idle carries nothing: with no pairing the
  // connect flow starts over; with one, Servers holds the remedies.
  if (state.k === "refused" || state.k === "ended") return { to: "servers" };
  return profileCount === 0 ? { to: "welcome" } : { to: "servers" };
}
