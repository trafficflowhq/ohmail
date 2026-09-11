import { VerifyEmailScreen } from "./VerifyEmailScreen";
import type { SearchParamsLike } from "../../demo-mode";

/**
 * `/verify-email?token=…` — the URL the verification mail links to (`MailService.issueEmailVerification` builds it;
 * the construction is the mail service's, never a caller's). The token is read here and handed down as an initial
 * value only: it is validated by NOTHING until `POST /auth/verify-email` presents it with the account password — a
 * client-side check would be a second opinion about a credential this page cannot hold the other half of.
 */

/**
 * A repeated `?token=a&token=b` takes the FIRST value, matching `/join`; the worst outcome is one refused attempt.
 * The 512-character clamp is not politeness: the value goes into a request body and a `sha256`, and an unbounded
 * query parameter is free work for anyone sending a megabyte — `requirePassword`'s own reasoning.
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
