/**
 * Does THIS deployment let a stranger open an account?
 *
 * One variable, `TF_PUBLIC_SIGNUP`, read on the server in exactly one place. The API is the
 * authority (`AuthConfig.publicSignup`); this is the webapp's copy of the same decision, and
 * the two are armed together on the same deploy.
 *
 * ── WHY AN ENVIRONMENT VARIABLE AND NOT AN API CALL ────────────────────────────────────
 *
 * The obvious "ask the server" design does not survive contact with the page that needs the
 * answer. The landing (`/`) is PRERENDERED and CDN-cached — measured as a static
 * route, and the anonymous path costs zero upstream requests — which is why a stranger
 * gets a cached page and no session lookup. A per-request call to the API to decide what the
 * primary CTA says would turn `/` into a dynamic route for every visitor and every crawler,
 * to answer a question whose value changes about once in the product's life.
 *
 * So it is read at BUILD time for the marketing surface and at REQUEST time for `/join`
 * (which is already dynamic), from the same variable, in this one function — which is what
 * makes "the CTA and the wizard cannot disagree with each other" a fact rather than a hope.
 *
 * ── AND THE CLIENT STILL DOES NOT TRUST IT ─────────────────────────────────────────────
 *
 * The remaining disagreement is webapp-vs-API: this deployment could say "open" while the
 * API still demands a code. That is a deploy mistake, not a state to design for, but it must
 * not be a dead end — so `JoinScreen` treats a `validation_failed` on registration as "the
 * server wants a code after all" and shows the invite step. The server decides; this only
 * decides where the wizard STARTS.
 *
 * Never `NEXT_PUBLIC_`: inlining it into the client bundle would publish the deployment's
 * signup posture to every reader and buy nothing — the server components below already know.
 */
export const PUBLIC_SIGNUP_VAR = "TF_PUBLIC_SIGNUP";

/**
 * `true` only for the exact string `"1"`.
 *
 * Deliberately not "any truthy string": `TF_PUBLIC_SIGNUP=false` and
 * `TF_PUBLIC_SIGNUP=off` both read as "on" under a truthiness check, and an operator who
 * types either of those is trying to CLOSE registration. `TF_SSE` on the API host uses the
 * same rule for the same reason, and `apps/api-vercel/src/config.ts` parses this very
 * variable identically — the two must agree, and they agree by both being this strict.
 */
export function publicSignupEnabled(
  // `Record<string, string | undefined>` and not `NodeJS.ProcessEnv`: Next augments that
  // type with a REQUIRED `NODE_ENV`, so a test could not hand this function a two-key object
  // without inventing one. The parameter exists to be substituted; a type that only
  // `process.env` satisfies would defeat it.
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[PUBLIC_SIGNUP_VAR]?.trim() === "1";
}
