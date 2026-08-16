import { timingSafeEqual } from "node:crypto";

/**
 * SHARED-SECRET AUTHENTICATION for the two endpoints whose caller is not a person.
 *
 * `POST /internal/alerts` is called by a scheduler; `GET /admin/*` is called by the admin
 * console's own server-side proxy. Neither has a session to resolve, neither has a user to be,
 * and inventing a service account for either would mean a credential in `users` that can be
 * phished. `Authorization: Bearer <secret>`, compared in constant time, is the whole story.
 *
 * ── WHY THIS IS ITS OWN MODULE ────────────────────────────────────────────────────────────
 * The comparison used to live inside `routes/internal.ts`. A second route needing it would
 * have made a second copy, and the third copy is where somebody writes `presented === expected`
 * because it is shorter — a length-and-prefix-leaking compare on a value an attacker can retry
 * indefinitely is exactly the shape of a recoverable secret. One implementation, two callers,
 * and a suite is where its properties are pinned.
 *
 * What this is NOT: a rate limit or a lockout. There is none behind either endpoint, so the
 * only thing standing between a guesser and the secret is its LENGTH — which is why both
 * host-side loaders refuse a secret shorter than 24 characters rather than trusting the
 * operator who typed it.
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
