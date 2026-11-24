/**
 * The sign-in's states, by the design reference's addresses: the onboarding's step `login` (form, wrong, factor, code,
 * recovery, refused, server) and the door states it is handed (locked, slowed, busy, passkey).
 */
import type { SignInState } from "./door.js";

export const SIGN_IN_STATES = [
  "form",
  "wrong",
  "factor",
  "code",
  "recovery",
  "refused",
  "server",
  "locked",
  "slowed",
  "busy",
  "passkey",
  "unavailable",
] as const;
export type SignInStateId = (typeof SIGN_IN_STATES)[number];

/** The reference's state a door's state draws. `server` is the form under the self-hosted posture; `busy` is a said refusal. */
export function signInStateOf(state: SignInState, selfHosted: boolean): SignInStateId {
  if (state.at === "unavailable") return "unavailable";
  const refusal = state.refusal?.word ?? null;
  if (refusal === "locked" || refusal === "slowed") return refusal;
  if (refusal === "said") return "busy";
  if (state.at === "password")
    return refusal === "bad_credentials" ? "wrong" : selfHosted ? "server" : "form";
  if (refusal === "bad_passkey") return "passkey";
  if (refusal === "bad_code") return "refused";
  return state.factor === "passkey" ? "factor" : state.factor;
}
