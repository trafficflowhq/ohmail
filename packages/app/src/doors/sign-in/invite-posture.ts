/** The compile-time self-hosted build stays invite-only regardless of the managed signup setting. */
export type SignupPosture = "selfhost" | "managed-open" | "managed-invite";

/**
 * `selfHost` is the COMPILE-time flavor (`SELF_HOST_BUILD`) and wins: invitation is that build's
 * permanent design, not a beta condition, so `TF_PUBLIC_SIGNUP` cannot open it.
 */
export function signupPosture(selfHost: boolean, publicSignup: boolean): SignupPosture {
  if (selfHost) return "selfhost";
  return publicSignup ? "managed-open" : "managed-invite";
}
