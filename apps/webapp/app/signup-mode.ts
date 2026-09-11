/**
 * Does THIS deployment let a stranger open an account? One variable, `TF_PUBLIC_SIGNUP`, read on the server in
 * exactly one place; the API is the authority and the two are armed together. An environment variable and not an API
 * call because the landing is prerendered and CDN-cached — a per-request call to decide what the CTA says would make
 * `/` dynamic for every visitor, to answer a question that changes about once in the product's life.
 */

/**
 * Read at BUILD time for the marketing surface and at REQUEST time for `/join` (already dynamic), from the same
 * variable in this one function — what makes "the CTA and the wizard cannot disagree" a fact. The client still does
 * not trust it: `JoinScreen` treats a `validation_failed` on registration as "the server wants a code after all".
 * Never `NEXT_PUBLIC_`: inlining would publish the deployment's signup posture to every reader and buy nothing.
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
