import type { RenderedEmail, TemplateDataMap, TemplateName } from "./templates.js";

/**
 * The transactional-mail seam.
 *
 * `MailerPort` is injected exactly like `RemoteFetch` (privacy-service),
 * `DraftPort` (drafting-service) and `OpenSendAdapter` (send-service): the
 * production implementation talks to Resend, the test implementation is a spy, and
 * nothing in `packages/services` reaches for a network client on its own. That is
 * what makes "zero external requests in the suite" provable rather than
 * hoped for — a test can assert the spy saw the sends AND that the injected
 * transport was never handed a socket.
 *
 * Two properties are load-bearing:
 *
 * **1. `send` never throws.** Every failure mode — a 5xx from the provider, a DNS
 * error, a malformed template argument — comes back as a `MailSendResult`. A
 * transactional mail is a side effect of a request, never its purpose: a waitlist
 * row must not roll back because Resend had a bad minute, and a sign-in must not
 * 500 because a notice could not be delivered. Callers are free to ignore the
 * result; they are not free to be interrupted by it.
 *
 * **2. `send` is generic over the template.** `send("x@y", "invite", …)` will only
 * accept `InviteData`. The four templates are a closed set (see `templates.ts`);
 * the port cannot send a free-form body, so there is no path by which arbitrary
 * user content becomes outbound mail from our sending domain.
 *
 * **A port is a TRANSPORT and enforces no policy.** The per-recipient limiter, the
 * link construction and the token lifecycle all live in `MailService`; calling a
 * `MailerPort` directly bypasses every one of them. Composition roots must construct
 * `MailService` and hand *that* to callers — a route that holds a bare `MailerPort` has
 * an unthrottled mail-bomb primitive. `packages/api` holds no mailer today, and
 * `mail-service.test.ts` pins the boundary by exercising the limiter through the
 * service and proving the raw port has none.
 */
export interface MailerPort {
  send<K extends TemplateName>(
    to: string, template: K, data: TemplateDataMap[K], opts?: SendOptions,
  ): Promise<MailSendResult>;
}

export interface SendOptions {
  /**
   * Provider-side dedup key. Resend honours an `Idempotency-Key` header on
   * `POST /emails`; a provider that ignores it leaves us exactly where we are today.
   * We do not retry (see `mail-service.ts`), but a serverless invocation can be
   * killed after the provider accepted the send and then be re-driven by the
   * client, and this is what stops that from being two mails.
   *
   * `MailService` supplies one for the three templates whose triggering EVENT has a
   * stable identity: waitlist (recipient + tier), invite (code + recipient), sign-in
   * notice (recipient + device + instant). It deliberately supplies none for email
   * verification — each re-execution mints a fresh token, so suppressing the second
   * mail would strand the user with a link they never received. Making the verification
   * REQUEST idempotent is the wiring slice's job, not the transport's.
   */
  idempotencyKey?: string;
}

/**
 * The result union. `skipped` is not a failure and not a success: it is the mailer
 * declining to send, and the caller should treat it as "the user is fine, we chose
 * not to mail". `failed.retryable` classifies the provider error for LOGGING and
 * for a future queue; nothing in beta acts on it (see the failure-mode note in
 * `mail-service.ts`).
 */
export type MailSendResult =
  | { status: "sent"; providerId: string | null }
  | { status: "skipped"; reason: SkipReason }
  | { status: "failed"; retryable: boolean; error: string };

export type SkipReason =
  /** The per-recipient limiter refused it (`MailService`). */
  | "rate_limited"
  /** The deployment has no mailer configured — dev, preview, and the test suite. */
  | "mailer_disabled"
  /** The recipient address did not survive normalisation. */
  | "invalid_recipient"
  /**
   * The credential being mailed is bound to a user whose address is not this recipient
   * (`issueEmailVerification`). Never a normal outcome: it means a caller tried to send
   * one account's verification link to a different inbox.
   */
  | "recipient_mismatch";

/** What a transport implementation actually puts on the wire. */
export interface OutboundEmail extends RenderedEmail {
  from: string;
  to: string;
  replyTo?: string;
}

/**
 * Reject a `from` that could break the wire format — shared by every transport
 * implementation, because the risk is the port's, not one provider's. The value is
 * deployment config, but a header-injection newline in it would let the deployment (or
 * anything that can set an env var) add `Bcc:` to every mail we send. `who` names the
 * refusing constructor in the error; the VALUE is never echoed (a From line is an
 * address, and these messages reach boot logs).
 */
export function assertUsableFrom(who: string, from: string): void {
  if (typeof from !== "string" || from.trim().length === 0) {
    throw new Error(`${who}: \`from\` is required`);
  }
  if (/[\r\n\0]/.test(from)) {
    throw new Error(`${who}: \`from\` contains a control character (header injection)`);
  }
  if (!/^[^<>@]*<?[^\s<>@]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}>?$/.test(from.trim())) {
    throw new Error(`${who}: \`from\` is not an RFC5322 address or display-name form`);
  }
}

/**
 * `true` inside vitest (or any `NODE_ENV=test` runner) — the predicate behind the
 * standing rule that the suite performs zero external requests. Transport constructors
 * consult it to REFUSE a configuration that could reach a real network from a test:
 * `ResendMailer` refuses its default HTTP transport; `SmtpMailer` refuses any
 * non-loopback SMTP host.
 */
export function underTestRunner(): boolean {
  const env = globalThis.process?.env ?? {};
  return Boolean(env.VITEST ?? env.VITEST_WORKER_ID) || env.NODE_ENV === "test";
}

/**
 * Normalise + sanity-check a recipient. Returns null when the value cannot be a
 * recipient at all — the mailer answers `skipped: "invalid_recipient"` rather than
 * handing a provider something that will bounce and cost reputation.
 *
 * Deliberately permissive on the local part (the landing form already applies the
 * shape check the user sees) and strict about the things that break a wire format:
 * whitespace, CR/LF (header injection), a missing or malformed domain.
 */
export function normalizeRecipient(raw: string): string | null {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (value.length === 0 || value.length > 254) return null;
  if (/[\s<>,;"\\]/.test(value)) return null;
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return null;
  // Exactly one `@`. `lastIndexOf` alone accepts `two@@example.com` by reading the local part
  // as `two@` — the only way that is a real address is if the local part were QUOTED, and the
  // `"` in the character class above has already refused those. So a second `@` here is
  // always malformed, and letting it through hands a provider an address that bounces.
  // Reached from registration too: `requireEmail` delegates here.
  if (value.indexOf("@") !== at) return null;
  const domain = value.slice(at + 1);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) return null;
  return value;
}
