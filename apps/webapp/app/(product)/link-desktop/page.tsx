import { LinkDesktopScreen } from "./LinkDesktopScreen";
import type { SearchParamsLike } from "../../demo-mode";

/**
 * `/link-desktop` — the browser half of signing the desktop app in.
 *
 * The desktop app opens this address in the user's own browser (via its `open_link` key table,
 * so the app names a PLACE and never a URL). This page mints a one-use handoff code from the
 * session the browser already holds, shows it, and either hands it back to the app over the
 * `ohmail://` scheme or lets the person retype it. The app exchanges it at
 * `POST /auth/desktop-claim` for a session of its own.
 *
 * ── WHY A PAGE AND NOT A ROW IN SETTINGS ────────────────────────────────────────────────────
 *
 * Because the app is what opens it. "Go to Settings, find the desktop section, press the button"
 * is three instructions a person has to carry across two windows; an address the app can open
 * directly is none. The Settings pane is where you'd look for it later, and this is where the app
 * puts you now — the same reasoning `/verify-email` is a page rather than a settings row.
 *
 * ── ONE PARAMETER IS READ FROM THE URL, AND IT IS A COMMITMENT RATHER THAN A CREDENTIAL ─────
 *
 * This header said NOTHING IS READ FROM THE URL, and that was true for as long as the only way
 * out of this page was a person's fingers. It is no longer true, so it is rewritten rather than
 * left standing: `?challenge=` is read, and nothing else is.
 *
 * The old sentence's reasoning — "adding a parameter would mean this page could be linked in a
 * way that changes what it does" — was right about credentials and is the wrong test for this
 * value. `/join?code=` and `/verify-email?token=` carry SECRETS: possession of the parameter is
 * possession of the thing, so a crafted link hands an attacker's credential to a victim's
 * browser. A PKCE challenge is the opposite shape. It is `sha256(verifier)` — the PUBLIC half of
 * a pair whose secret half never leaves the process that invented it — and what it does to this
 * page is to make the minted code STRICTLY LESS USEFUL: without it the code is spendable by
 * anyone who reads it, and with it the code is spendable only by whoever holds the verifier.
 *
 * So the question a crafted link raises is not "what did an attacker gain" but "what did the
 * visitor lose", and the answer is: a code bound to a verifier they do not hold, which therefore
 * cannot be claimed — by them or by anybody. The failure mode of a poisoned challenge is a
 * handoff that does not work, and the remedy is the one already on screen (ask for another code,
 * or type it in). It cannot become a session on somebody else's machine, because the code is
 * never sent anywhere: it is printed here, and the only party that can spend it is the one
 * holding the verifier. That is a denial of a linking attempt, not an escalation.
 *
 * The parameter is validated HERE, to the exact shape a PKCE SHA-256 code challenge has (43 characters of
 * base64url), and anything else is dropped to the empty string — so a URL carrying junk mints an
 * ordinary retypable code rather than reaching the API with a value it would refuse. A repeated
 * `?challenge=a&challenge=b` arrives as an array and the FIRST value wins, matching `/join`'s
 * handling of `?code=` and `/verify-email`'s of `?token=`.
 *
 * Middleware still serves this page under the credential-page headers — `no-referrer`,
 * `no-store`, and the strict nonce policy — because what it PRINTS is a live credential. The
 * `no-referrer` matters more now than it did: it is what stops the challenge, and the fact that
 * a link ceremony happened at all, from being handed to any other origin.
 *
 * A thin server shell over a client component: the code is minted by a `fetch` the browser makes
 * with its own cookies, so there is nothing to render on the server. Reading `searchParams` makes
 * this route server-rendered on demand rather than prerendered, which is what `/join`,
 * `/login` and `/verify-email` already are — and the right answer for a page whose whole output
 * is a live credential, since there is nothing here that a cache should ever hold.
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
