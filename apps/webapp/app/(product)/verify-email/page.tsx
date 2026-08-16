import { VerifyEmailScreen } from "./VerifyEmailScreen";
import type { SearchParamsLike } from "../../demo-mode";

/**
 * `/verify-email?token=…` — the URL the verification mail links to
 * (`MailService.issueEmailVerification` builds `${appUrl}/verify-email?token=…`, and that
 * construction is the mail service's, never a caller's).
 *
 * The token is read here and handed down as an initial value only. It is validated by NOTHING
 * until `POST /auth/verify-email` presents it together with the account password — a
 * client-side check would be a second opinion about a credential, and there is no way for this
 * page to hold the other half of the pair anyway.
 *
 * A repeated `?token=a&token=b` arrives as an array and the FIRST value wins, matching `/join`'s
 * handling of `?code=`. The safe direction: the worst outcome is one refused attempt.
 *
 * The 512-character clamp is not politeness. This value goes into a request body and into a
 * `sha256`, and an unbounded query parameter is free work for anyone who wants to send a
 * megabyte — the same reasoning as `requirePassword`'s maximum.
 */
export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams?: SearchParamsLike;
}) {
  const raw = searchParams?.token;
  const first = Array.isArray(raw) ? raw[0] : raw;
  return (
    <VerifyEmailScreen
      initialToken={typeof first === "string" ? first.trim().slice(0, 512) : ""}
    />
  );
}
