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
import type { AccessRefusedFacts } from "../net/access-lock";
import type { UpdateAnswerFacts } from "../net/update-answer";
import type { BootMigrating } from "../ui/boot-migrating";

export type GateVerdict =
  | { to: "boot" }
  | { to: "update"; answer: UpdateAnswerFacts["answer"]; origin: string }
  | { to: "wall"; facts: AccessRefusedFacts }
  | { to: "welcome" }
  | { to: "connecting"; origin: string; migrating?: BootMigrating }
  | { to: "servers" }
  | { to: "mail" };

export function gateFor(
  state: ConnectionState,
  profileCount: number,
  /**
   * What the 402 sink is holding, or `null`. THIRD ARGUMENT AND NOT A FOURTH STATE: a refused
   * account still has a live session — the mirror is intact, the doors it may still reach answer
   * — so this is not a connection that ended, and folding it into `ConnectionState` would put a
   * billing fact in the module that owns the credential. Absent (every existing caller) reads as
   * "no wall", so nothing that does not pass it changes.
   */
  lock: AccessRefusedFacts | null = null,
  /**
   * What the update-answer sink is holding, or `null`: the server said this app is too old for it, or that
   * it is being updated. FOURTH ARGUMENT for the wall's reason, and AHEAD of it: an app too old to speak to
   * its server cannot read that server's account verdict, so the sentence about the app comes first. Only a
   * LIVE session can be answered so. Absent (every existing caller) reads as "no answer", so nothing that
   * does not pass it changes.
   */
  update: UpdateAnswerFacts | null = null,
): GateVerdict {
  if (state.k === "live" && update !== null) return { to: "update", answer: update.answer, origin: update.origin };
  /* AHEAD OF `mail` AND BEHIND EVERYTHING ELSE. A wall over a boot instant would be a screen
     about an account before the keystore has said which one; a wall over `welcome` would be one
     about an account this phone is not paired with. Only a LIVE session can be refused. */
  if (state.k === "live" && lock !== null) return { to: "wall", facts: lock };
  if (state.k === "live") return { to: "mail" };
  if (state.k === "starting") return { to: "boot" };
  if (state.k === "connecting") {
    return state.migrating === undefined
      ? { to: "connecting", origin: state.origin }
      : { to: "connecting", origin: state.origin, migrating: state.migrating };
  }
  // A refusal or a death carries a sentence the reader must be able to see — Servers
  // renders it whatever the pairing count. Idle carries nothing: with no pairing the
  // connect flow starts over; with one, Servers holds the remedies.
  if (state.k === "refused" || state.k === "ended") return { to: "servers" };
  return profileCount === 0 ? { to: "welcome" } : { to: "servers" };
}
