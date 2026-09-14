/**
 * THE THREE AI REFUSALS, SAID IN THE READER'S LANGUAGE.
 *
 * The server's `message` is English written for a log and was being rendered verbatim — a German
 * account read an English sentence about its own standing. The `code` is the actionable fact, so
 * it selects the sentence and the catalogue holds it. Only three, because every other refusal
 * keeps the server's own words: "this deployment has no AI classifier connected" is a fact about
 * a host, and re-deriving a taxonomy for it is how somebody with an empty balance is told the
 * model is down.
 */

/** `error.code` → the key under the `aiRefusal` namespace. The whole mapping, as data. */
const BY_CODE: Readonly<Record<string, "insufficientCredits" | "aiDisabled" | "aiUnavailable">> = {
  insufficient_credits: "insufficientCredits",
  ai_disabled: "aiDisabled",
  ai_unavailable: "aiUnavailable",
};

/**
 * The `aiRefusal` key for this refusal, or `null` when this client has nothing better to say than
 * the server did.
 *
 * It reads `code` off the value rather than narrowing to one error class, because the two
 * transports throw two classes for the same wire — `ApiError` in the browser, `SuggestRefused`
 * over the desktop bridge — and both carry the code verbatim out of the same envelope. Anything
 * without a string `code`, or with one that is not among the three, is `null`.
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
