import { createHash } from "node:crypto";

/**
 * The CSRF token is derived from the session it protects, not drawn at random. A double-submit
 * guard that only compares cookie and header accepts any pair of equal values: script on a
 * same-site sibling origin can plant a parent-domain copy of the CSRF cookie and ride the ambient
 * host-only session. The expected value is a function of the session token, recomputed by the
 * guard — a planted cookie matches nothing. A domain-separated digest, not an HMAC under a
 * deployment secret (absence selecting a permissive branch is refused by policy); unguessability
 * comes from the access token behind HttpOnly, rotating with every refresh. Verifying is not
 * minting: this module belongs to the pipeline every host runs.
 */
export function csrfTokenFor(sessionToken: string): string {
  return createHash("sha256").update(`ohmail-csrf:v1:${sessionToken}`).digest("base64url");
}
