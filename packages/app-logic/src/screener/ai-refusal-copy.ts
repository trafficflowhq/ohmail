/**
 * THE AI REFUSALS, SAID IN THE READER'S LANGUAGE.
 *
 * The server's `message` is English written for a log and was being rendered verbatim — a German
 * account read an English sentence about its own standing. The `code` is the actionable fact, so
 * it selects the sentence and the catalogue holds it. One code per fact: no model connected has
 * its own sentence, apart from an empty balance and a model that is down, so none of the three
 * people is told another's remedy. Every other refusal keeps the server's own words.
 */

/** `error.code` → the key under the `aiRefusal` namespace. The whole mapping, as data. */
const BY_CODE: Readonly<Record<string, "insufficientCredits" | "aiDisabled" | "aiUnavailable" | "noModel">> = {
  insufficient_credits: "insufficientCredits",
  ai_disabled: "aiDisabled",
  ai_unavailable: "aiUnavailable",
  suggest_unconfigured: "noModel",
};

/**
 * The `aiRefusal` key for this refusal, or `null` when this client has nothing better to say than
 * the server did.
 *
 * It reads `code` off the value rather than narrowing to one error class, because Cloud and
 * Desktop transports use different error classes — `ApiError`, `SuggestRefused` and
 * `DraftReplyRefused` — and all carry the code verbatim out of the same envelope. Anything
 * without a string `code`, or with one that is not mapped above, is `null`.
 */
export function aiRefusalKey(err: unknown): string | null {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  if (typeof code !== "string") return null;
  return BY_CODE[code] ?? null;
}

/**
 * True for a refusal an ACCESS READ can lift — and false for the one it cannot.
 *
 * What clears a line must be evidence about the thing the line claims. `ai_unavailable` is a
 * fault and `ai_disabled` is the account's switch: an access read describes both. An empty
 * BALANCE it does not describe — a plan may permit AI while the balance is nil — so clearing
 * that one on `aiEnabled: true` would erase a sentence still true. It clears on the next press.
 */
export function clearedByAccess(err: unknown): boolean {
  const key = aiRefusalKey(err);
  return key === "aiUnavailable" || key === "aiDisabled";
}

/** The server reports whether a stopped draft's credits were returned, owed, or used. */
export function draftFailureKey(
  err: unknown,
): "creditsUsed" | "creditsReturned" | "creditsOwed" | "declined" | "declinedCreditsReturned" | "declinedCreditsOwed" | null {
  const e = err as { code?: unknown; details?: { credits?: unknown } } | null | undefined;
  const credits = e?.details?.credits;
  if (credits === "used" && (e?.code === "ai_draft_declined" || e?.code === "ai_draft_failed")) return "creditsUsed";
  if (e?.code === "ai_draft_declined") {
    return credits === "returned" ? "declinedCreditsReturned" : credits === "owed" ? "declinedCreditsOwed" : "declined";
  }
  if (e?.code !== "ai_draft_failed") return null;
  if (credits === "returned") return "creditsReturned";
  if (credits === "owed") return "creditsOwed";
  return null;
}
