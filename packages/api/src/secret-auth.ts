import { timingSafeEqual } from "node:crypto";

/**
 * Shared-secret authentication for the two endpoints whose caller is not a person: `POST
 * /internal/alerts` (a scheduler) and `GET /admin/*` (the console's server-side proxy). Neither
 * has a session, and a service account would be phishable. Bearer secret in constant time is the
 * whole story. Its own module because a second caller would have made a second copy, and the
 * third copy is where somebody writes `presented === expected` — a length-and-prefix-leaking
 * compare on a value an attacker can retry indefinitely. Not a rate limit or lockout — there is
 * none behind either endpoint, so the only thing between a guesser and the secret is its length;
 * both loaders refuse one under 24 characters.
 */

/**
 * Constant-time compare of two secrets. A length difference is not leaked by timing.
 *
 * `timingSafeEqual` THROWS on a length mismatch, which would itself be a timing oracle if the
 * throw were caught at a different point. Both values are copied into fixed-size buffers of the
 * longer length, compared, and the length equality is ANDed in afterwards so a padded match
 * cannot pass.
 */
export function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  const len = Math.max(a.length, b.length, 1);
  const pa = Buffer.alloc(len);
  const pb = Buffer.alloc(len);
  a.copy(pa);
  b.copy(pb);
  return timingSafeEqual(pa, pb) && a.length === b.length;
}

/** The `Authorization: Bearer <value>` token, or null. Scheme match is case-insensitive. */
export function bearerOf(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const [scheme, ...rest] = header.split(" ");
  if ((scheme ?? "").toLowerCase() !== "bearer") return null;
  const value = rest.join(" ").trim();
  return value.length > 0 ? value : null;
}

/**
 * Does this request present the configured secret?
 *
 * The two callers answer 401 on `false` and MUST NOT distinguish "no header" from "wrong
 * secret" in the response: on an `anonymous` route the absence of a credential and the presence
 * of the wrong one are the same fact — this caller is not the one the endpoint is for.
 */
export function presentsSecret(req: Request, expected: string): boolean {
  const presented = bearerOf(req);
  return presented !== null && secretMatches(presented, expected);
}

/** The `no-store` JSON response both shared-secret routes answer with. */
export function secretRouteJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
