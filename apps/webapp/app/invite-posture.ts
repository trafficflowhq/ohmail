/**
 * WHICH SENTENCE ABOUT INVITE CODES IS TRUE HERE — one table, read by both screens that say it.
 *
 * A deployment is in exactly one of three postures, and each makes a different sentence true. The
 * login screen used to state the managed-OPEN sentence unconditionally, so an invite-only managed
 * deployment told a visitor on `/login` that no code was needed and on `/join` that one was: two
 * surfaces of one product contradicting each other about the one credential that gates the beta.
 * Claims are contracts, so the claim is selected by the posture rather than assumed.
 */

/** The three postures. `managed-invite` is the beta's own, and the one that had no sentence. */
export type SignupPosture = "selfhost" | "managed-open" | "managed-invite";

/**
 * `selfHost` is the COMPILE-time flavor (`SELF_HOST_BUILD`) and wins: invitation is that build's
 * permanent design, not a beta condition, so `TF_PUBLIC_SIGNUP` cannot open it.
 */
export function signupPosture(selfHost: boolean, publicSignup: boolean): SignupPosture {
  if (selfHost) return "selfhost";
  return publicSignup ? "managed-open" : "managed-invite";
}

/** `login.*` — the note under the sign-in form. One key per posture, and the keys are distinct. */
export const LOGIN_INVITE_KEY: Readonly<Record<SignupPosture, string>> = {
  selfhost: "inviteOnlySelfhost",
  "managed-open": "inviteOnly",
  "managed-invite": "inviteOnlyBeta",
};

/** `join.*` — the lead on the wizard's invite step. Same three postures, this surface's wording. */
export const JOIN_INVITE_KEY: Readonly<Record<SignupPosture, string>> = {
  selfhost: "step_invite_lead_selfhost",
  "managed-open": "step_invite_lead_open",
  "managed-invite": "step_invite_lead",
};
