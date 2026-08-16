import { JoinScreen } from "./JoinScreen";
import type { SearchParamsLike } from "../../demo-mode";
import { publicSignupEnabled } from "../../signup-mode";

/**
 * `/join?code=…` — the URL the invite mail links to (`MailService.sendInvite` builds
 * `${appUrl}/join?code=…`, and that construction is the mail service's, not a caller's).
 *
 * The code is read here and handed to the client as an initial value only: it prefills the
 * field and skips the "paste your code" step, and it is validated by nothing until
 * `POST /auth/register` consumes it inside the transaction that creates the account. A
 * client-side check would be a second opinion about the one credential that gates the beta.
 *
 * A repeated `?code=a&code=b` arrives as an array; the FIRST value wins and the rest are
 * ignored, which is the safe direction — the worst outcome is a prefilled field the user
 * corrects, and the server refuses anything wrong regardless.
 *
 * `?billing=success|cancelled` is the OTHER way into this page: Stripe Checkout redirects
 * back here (`BillingService.createCheckout` builds `${appUrl}/join?billing=…`) because the
 * plan step now sits mid-wizard rather than at the end. Anything other than those two
 * literals is dropped — it is a value a stranger can put in a link, and the only thing it
 * is allowed to influence is whether the wizard waits for the subscription webhook.
 *
 * `publicSignup` decides where the wizard STARTS and nothing else — the server still
 * validates every code and still refuses a missing one when the deployment is gated. It is
 * read here, on the server, rather than passed down from the landing, so a visitor who
 * bookmarks `/join` gets the same answer as one who followed the CTA.
 */
export default async function JoinPage({
  searchParams,
}: {
  searchParams?: SearchParamsLike;
}) {
  const raw = searchParams?.code;
  const first = Array.isArray(raw) ? raw[0] : raw;
  const rawBilling = searchParams?.billing;
  const billing = Array.isArray(rawBilling) ? rawBilling[0] : rawBilling;
  return (
    <JoinScreen
      initialCode={typeof first === "string" ? first.trim().slice(0, 64) : ""}
      billingReturn={billing === "success" || billing === "cancelled" ? billing : undefined}
      publicSignup={publicSignupEnabled()}
    />
  );
}
