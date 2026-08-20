/**
 * THE FIRST-RUN GATE — which surface owns the screen, decided from the connection state.
 *
 * The app has two real states: NOT CONNECTED (the connect flow owns the screen) and
 * CONNECTED (the mail screens render the mirror). This function is the whole rule, kept
 * pure so the suite can hold it without a renderer; the tabs layout renders its verdict.
 *
 *  · `boot` — the launch instant, before the keystore has answered whether a pairing
 *    exists. Render NOTHING: painting the welcome screen here would flash onboarding at
 *    every cold start of a paired phone.
 *  · `welcome` — nothing is paired. The app opens into the connect flow, never into an
 *    empty mail UI and never into sample data.
 *  · `connecting` — a boot or switch in flight; a one-sentence status, not the mail UI.
 *  · `servers` — paired but not live (disconnected, refused, ended). The Servers screen
 *    carries the reason in words and every remedy: switch, re-pair, forget.
 *  · `mail` — live. The tabs render the mirror.
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
  // idle / refused / ended: with no pairing left the connect flow starts over; with one,
  // the Servers screen holds the reason and the remedies.
  return profileCount === 0 ? { to: "welcome" } : { to: "servers" };
}
