import type { RenderedEmail, TemplateDataMap, TemplateName } from "./templates.js";

/**
 * The transactional-mail seam. `MailerPort` is injected like `RemoteFetch` and `DraftPort`:
 * production talks to Resend, tests inject a spy — "zero external requests in the suite",
 * provable. Two load-bearing properties: (1) `send` NEVER THROWS — a transactional mail is a side
 * effect, never a request's purpose: a waitlist row must not roll back because the provider had a
 * bad minute. (2) `send` is generic over the closed template set, so no path turns user content
 * into outbound mail from our domain. A port is a TRANSPORT and enforces no policy: the limiter,
 * link construction and token lifecycle live in `MailService` — a bare `MailerPort` is an
 * unthrottled mail-bomb primitive; `mail-service.test.ts` pins the boundary.
 */
export interface MailerPort {
  send<K extends TemplateName>(
    to: string, template: K, data: TemplateDataMap[K], opts?: SendOptions,
  ): Promise<MailSendResult>;
}

export interface SendOptions {
  /**
   * Provider-side dedup key. Resend honours an `Idempotency-Key` header on `POST /emails`; a
   * provider that ignores it leaves us where we are today. We do not retry, but a serverless
   * invocation can be killed after the provider accepted the send and re-driven by the client,
   * and this is what stops that being two mails. `MailService` supplies one for the three
   * templates whose triggering EVENT has a stable identity: waitlist (recipient + tier), invite
   * (code + recipient), sign-in notice (recipient + device + instant). Deliberately none for
   * email verification — each re-execution mints a fresh token, so suppressing the second mail
   * would strand the user with a link they never received.
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
