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
 *  · `welcome` — nothing is paired and nothing went wrong. The app opens into the connect
 *    flow, never into an empty mail UI and never into sample data.
 *  · `connecting` — a boot or switch in flight; a one-sentence status, not the mail UI.
 *  · `servers` — not live with something to say or act on: disconnected with pairings, a
 *    refusal, an ended session. The Servers screen carries the reason in words and every
 *    remedy — switch, re-pair, forget, add. A refusal lands here even with ZERO pairings
 *    (a dead keystore read, a failed boot): the welcome screen has no status panel, so
 *    routing a refusal there would hide the one sentence that explains what happened.
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
  // A refusal or a death carries a sentence the reader must be able to see — Servers
  // renders it whatever the pairing count. Idle carries nothing: with no pairing the
  // connect flow starts over; with one, Servers holds the remedies.
  if (state.k === "refused" || state.k === "ended") return { to: "servers" };
  return profileCount === 0 ? { to: "welcome" } : { to: "servers" };
}
