import { AuthorizeDesktopScreen } from "./AuthorizeDesktopScreen";
import type { SearchParamsLike } from "../../demo-mode";

/**
 * `/authorize-desktop` — the confirmation the native sign-in now goes through.
 *
 * `GET /oauth/authorize` used to mint an authorization code and redirect straight back to the app,
 * on nothing but the session cookie the browser was carrying: a link somebody else composed and a
 * signed-in person clicked authorized a long-lived native credential as them. That GET now writes
 * the request down unspendable and sends the browser here; the code exists only once the person
 * looking at this page says so, and the press carries the session's CSRF token.
 *
 * One parameter is read, and it is a HANDLE rather than a credential: it names a request that only
 * the session which opened it can confirm, so it is worth nothing to anyone else. Shape-checked
 * here and dropped to the empty string otherwise; repeated values take the FIRST, matching
 * `/link-desktop` and `/join`.
 */

/** `generateToken()` is 32 bytes base64url — the same shape `/join` and `/verify-email` carry. */
const HANDLE_RE = /^[A-Za-z0-9_-]{20,512}$/;

export default async function AuthorizeDesktopPage({
  searchParams,
}: {
  searchParams?: SearchParamsLike;
}) {
  const raw = searchParams?.request;
  const first = Array.isArray(raw) ? raw[0] : raw;
  const handle = typeof first === "string" ? first.trim() : "";
  return <AuthorizeDesktopScreen request={HANDLE_RE.test(handle) ? handle : ""} />;
}
