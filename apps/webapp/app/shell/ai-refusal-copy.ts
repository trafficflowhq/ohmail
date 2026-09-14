/**
 * THE THREE AI REFUSALS, SAID IN THE READER'S LANGUAGE.
 *
 * The server's `message` is English, written for an operator reading a log. It was being
 * rendered verbatim: a German account saw "no AI actions remain on this account" on an otherwise
 * German screen, for a refusal that was not even true of it. What the client can act on is the
 * `code` — three of them, each a different, actionable fact — so the code selects the sentence
 * and the catalogue holds it.
 *
 * WHY ONLY THREE. Every other refusal keeps the server's own words, and that is not an oversight:
 * `suggest_unconfigured` ("this deployment has no AI classifier connected") is a fact about a
 * host, and re-deriving a taxonomy for it here is how somebody with an empty balance gets told
 * the model is down. These three are the ones every deployment can produce and every reader can
 * act on.
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
 * A card that said "no AI actions remain" at nine in the evening was still saying it at a
 * quarter to nine the next morning, on an account that had spent credits in between. What clears
 * a line has to be evidence about the same thing the line claims:
 *
 *  · `ai_unavailable` — a fault. Access saying AI is available on this account IS the evidence
 *    it has passed.
 *  · `ai_disabled` — the account's own switch. `aiEnabled: true` is that switch, read back.
 *  · `insufficient_credits` — an empty BALANCE, which no access read describes: the plan may
 *    permit AI while the balance is nil, so clearing on `aiEnabled: true` would erase a sentence
 *    that is still true. It clears on the next press, which is evidence about the balance.
 */
export function clearedByAccess(err: unknown): boolean {
  const key = aiRefusalKey(err);
  return key === "aiUnavailable" || key === "aiDisabled";
}
