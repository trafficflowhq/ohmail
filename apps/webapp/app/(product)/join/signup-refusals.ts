import { ApiError } from "../../api-client";

/**
 * THE SIGNUP'S REFUSALS IN THE SCREEN'S OWN WORDS. The server writes its refusals as English
 * diagnostics ("email must be a valid address", "invalid TOTP code") and the signup screens showed them
 * verbatim, so a German signup met English at every mistake. These map the refusals a signup step can
 * meet to catalogue keys, by code, and by the field a `validation_failed` names (the server's sentence
 * names it; there is no structured field yet). Anything not named here keeps the server's sentence: this
 * maps presentation and re-derives no taxonomy, like `loginError`.
 */

/** `join.*` keys for `POST /auth/register`'s refusals, the invite's included (it is consumed there). */
export type RegisterRefusal =
  | "refusedEmail" | "refusedPassword" | "refusedName" | "refusedTooMany" | "refusedTaken"
  | "refusedUnavailable" | "refusedFull" | "inviteInvalid" | "inviteUsed" | "inviteExpired";

export function registerRefusal(err: unknown): RegisterRefusal | null {
  if (!(err instanceof ApiError)) return null;
  switch (err.code) {
    case "validation_failed":
      if (/\bemail\b/.test(err.message)) return "refusedEmail";
      if (/\bpassword\b/.test(err.message)) return "refusedPassword";
      if (/\bdisplayName\b/.test(err.message)) return "refusedName";
      return null;
    case "rate_limited": return "refusedTooMany";
    case "email_taken": return "refusedTaken";
    case "signup_unavailable": return "refusedUnavailable";
    case "signup_capacity": return "refusedFull";
    case "invite_invalid": return "inviteInvalid";
    case "invite_used": return "inviteUsed";
    case "invite_expired": return "inviteExpired";
    default: return null;
  }
}

/** `join.refusedTotpCode` for a code the authenticator step's activation refused. */
export function totpRefusal(err: unknown): "refusedTotpCode" | null {
  return err instanceof ApiError && err.code === "unprocessable" && /\bTOTP\b/i.test(err.message)
    ? "refusedTotpCode" : null;
}

/** `POST /auth/verify-email`'s refusals: `verify.*` keys, and the sign-in throttle's own `login.*` two. */
export type VerifyRefusal =
  | { ns: "verify"; key: "refusedLink" | "refusedPassword" | "unavailableBody" }
  | { ns: "login"; key: "tooManyAttempts" | "signInSlowed" };

export function verifyRefusal(err: unknown): VerifyRefusal | null {
  if (!(err instanceof ApiError)) return null;
  switch (err.code) {
    case "invalid_token": return { ns: "verify", key: "refusedLink" };
    case "credential_refused": return { ns: "verify", key: "refusedPassword" };
    case "mail_unconfigured": return { ns: "verify", key: "unavailableBody" };
    // The same keys `login` claims, so the same two sentences the sign-in screen says.
    case "account_locked": return { ns: "login", key: "tooManyAttempts" };
    case "sign_in_slowed": return { ns: "login", key: "signInSlowed" };
    default: return null;
  }
}
