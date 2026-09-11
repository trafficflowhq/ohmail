import { LinkDesktopScreen } from "./LinkDesktopScreen";
import type { SearchParamsLike } from "../../demo-mode";

/**
 * `/link-desktop` — the browser half of signing the desktop app in. The app opens this address in
 * the user's own browser (via its `open_link` key table, so the app names a PLACE, never a URL);
 * the page mints a one-use handoff code from the session the browser holds, shows it, and either
 * hands it back over `ohmail://` or lets the person retype it; the app exchanges it at
 * `POST /auth/desktop-claim`. A page and not a Settings row because the app is what opens it: an
 * address the app can open directly is zero instructions carried across two windows — the
 * `/verify-email` reasoning.
 */

/**
 * One parameter is read from the URL, and it is a commitment rather than a credential. This header used to say
 * NOTHING IS READ, and that stopped being true, so it is rewritten: `?challenge=` is read and nothing else.
 * `/join?code=` and `/verify-email?token=` carry SECRETS — possession is the thing; a PKCE challenge is the opposite
 * shape — `sha256(verifier)`, the public half — and it makes the minted code STRICTLY LESS USEFUL: without it the
 * code is spendable by anyone who reads it, with it only by whoever holds the verifier.
 */

/**
 * A poisoned challenge is a handoff that does not work (the remedy is already on screen), never a session on somebody
 * else's machine: the code is never sent anywhere. Validated HERE to the exact PKCE shape (43 base64url characters),
 * junk dropped to the empty string; repeated values take the FIRST, matching `/join` and `/verify-email`.
 */

/**
 * Middleware still serves this page under the credential-page headers — `no-referrer`, `no-store`,
 * the strict nonce policy — because what it PRINTS is a live credential; `no-referrer` is also what
 * stops the challenge, and the fact a link ceremony happened, from reaching any other origin. A
 * thin server shell over a client component: the code is minted by a `fetch` the browser makes with
 * its own cookies, so nothing renders on the server; reading `searchParams` makes the route
 * server-rendered on demand — the right answer for a page whose whole output is a live credential.
 */

/** Exactly what the SHA-256 of anything is once base64url-encoded without padding. */
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

export default async function LinkDesktopPage({
  searchParams,
}: {
  searchParams?: SearchParamsLike;
}) {
  const raw = searchParams?.challenge;
  const first = Array.isArray(raw) ? raw[0] : raw;
  const challenge = typeof first === "string" ? first.trim() : "";
  return <LinkDesktopScreen challenge={CHALLENGE_RE.test(challenge) ? challenge : ""} />;
}
