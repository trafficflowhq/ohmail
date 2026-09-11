import { isIPv4 } from "node:net";
import { createTransport, type Transporter } from "nodemailer";
import {
  assertUsableFrom, normalizeRecipient, underTestRunner,
  type MailerPort, type MailSendResult, type OutboundEmail, type SendOptions,
} from "./port.js";
import { renderTemplate, type TemplateDataMap, type TemplateName } from "./templates.js";

/**
 * `MailerPort` over plain SMTP — the self-host transport, same closed templates, never-throws
 * contract and scrubbed errors as {@link ResendMailer}. Exported from the FULL barrel only: the
 * one module importing `nodemailer`, and the desktop engine bundles `/mail` —
 * `mail-entry-census.test.ts` pins both facts. `sent` means THE SERVER TOOK THE MESSAGE:
 * `markInviteDelivered` keys `confers_verified` on it, so an optimistic `sent` would stamp
 * receipt-proof for an inbox that received nothing. Precisely: 250 to DATA, no recipient
 * rejected. Retryability is SMTP's polarity: 4yz transient, 5yz permanent (RFC 5321 §4.2.1).
 * `idempotencyKey` is accepted and unused. Under a test runner, only loopback hosts construct.
 */
export interface SmtpMailerConfig {
  /**
   * `smtp://user:pass@host:port` or `smtps://…` — nodemailer's URL grammar, parsed here so the
   * refusals can name the variable without echoing a value that embeds a credential.
   * `smtp:` defaults to port 587, `smtps:` (TLS from the first byte) to 465.
   */
  url: string;
  /** RFC5322 From — display-name form welcome. Guarded against header injection at construction. */
  from: string;
  /** Where a reply goes, when the operator has a mailbox a human reads. */
  replyTo?: string;
  connectionTimeoutMs?: number;
  socketTimeoutMs?: number;
}

const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_SOCKET_TIMEOUT_MS = 30_000;

/**
 * Loopback is an ADDRESS, never a name shape. The first version also accepted any hostname
 * `startsWith("127.")`, and the independent review named what that admits: `127.smtp.vendor.com`
 * is a perfectly resolvable DNS name that would have bypassed BOTH the test-runner egress
 * refusal AND the requireTLS arming below — credentials to a remote host, in clear, from a
 * predicate that thought it was talking to itself. The 127/8 block is honoured only for a
 * literal IPv4 address; names get exactly one spelling, `localhost`.
 */
const isLoopback = (hostname: string): boolean => {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "::1" || (isIPv4(h) && h.startsWith("127."));
};

export class SmtpMailer implements MailerPort {
  private readonly transporter: Transporter;
  /** Kept ONLY for scrubbing error strings — never logged, never re-serialized. */
  private readonly password: string;

  constructor(private readonly cfg: SmtpMailerConfig) {
    assertUsableFrom("SmtpMailer", cfg.from);

    let url: URL;
    try {
      url = new URL(cfg.url);
    } catch {
      throw new Error("SmtpMailer: `url` must be of the form smtp[s]://user:pass@host:port");
    }
    if (url.protocol !== "smtp:" && url.protocol !== "smtps:") {
      throw new Error("SmtpMailer: `url` must use the smtp: or smtps: scheme");
    }
    // WHATWG parses `smtp:///` happily with an EMPTY host, and nodemailer defaults an empty
    // host to localhost — which would turn a malformed block into transactional mail handed to
    // whatever relay answers on the box, instead of the boot refusal this constructor owes.
    // The brackets come off an IPv6 literal here too: `[::1]` is URL syntax, and node's dialer
    // wants the bare `::1` (the bracketed form goes to DNS and fails every send).
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host === "") {
      throw new Error("SmtpMailer: `url` must name a host");
    }
    if (underTestRunner() && !isLoopback(host)) {
      throw new Error(
        "SmtpMailer: refusing a non-loopback SMTP host under a test runner — the suite performs " +
        "zero external requests. Point the URL at a loopback sink; see smtp-mailer.test.ts.",
      );
    }

    const secure = url.protocol === "smtps:";
    const user = decodeURIComponent(url.username);
    this.password = decodeURIComponent(url.password);
    this.transporter = createTransport({
      host,
      port: url.port !== "" ? Number(url.port) : secure ? 465 : 587,
      secure,
      ...(user !== "" ? { auth: { user, pass: this.password } } : {}),
      /**
       * With a credential bound for a non-loopback server over `smtp:`, STARTTLS stops being
       * opportunistic and becomes REQUIRED — nodemailer would otherwise send the password in
       * clear when the server simply does not advertise the extension, which is also what a
       * downgrade attacker makes the server appear to do. The same rule the add-mailbox probe
       * enforces for user credentials, applied to the operator's. A loopback sink (mailpit, the
       * test suite) authenticates nothing and may stay cleartext.
       */
      requireTLS: !secure && user !== "" && !isLoopback(host),
      connectionTimeout: cfg.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      greetingTimeout: cfg.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
      socketTimeout: cfg.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS,
      // The templates are a closed set and reference no files or URLs as attachment sources;
      // these make that a property of the transport rather than a review obligation.
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  async send<K extends TemplateName>(
    to: string, template: K, data: TemplateDataMap[K], _opts: SendOptions = {},
  ): Promise<MailSendResult> {
    const recipient = normalizeRecipient(to);
    if (!recipient) return { status: "skipped", reason: "invalid_recipient" };

    let mail: OutboundEmail;
    try {
      mail = { ...renderTemplate(template, data), from: this.cfg.from, to: recipient, replyTo: this.cfg.replyTo };
    } catch (e) {
      // A template that cannot render is OUR bug, never the server's weather.
      return { status: "failed", retryable: false, error: `render_failed: ${this.safe(e)}` };
    }

    let info: { accepted?: unknown[]; rejected?: unknown[]; messageId?: string };
    try {
      info = await this.transporter.sendMail({
        from: mail.from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
        ...(mail.headers ? { headers: mail.headers } : {}),
      });
    } catch (e) {
      const code = (e as { responseCode?: unknown }).responseCode;
      if (typeof code === "number" && code >= 400) {
        // The server SAID no. 4yz would succeed later; 5yz will not. The error string is a
        // status plus nodemailer's bounded error class — never the response line, which quotes
        // the recipient back (`550 … <member@…>`).
        return { status: "failed", retryable: code < 500, error: `smtp_${code}: ${errClass(e)}` };
      }
      // No SMTP reply to blame: refused connection, DNS, timeout, TLS. Transient by class.
      return { status: "failed", retryable: true, error: `transport: ${this.safe(e)}` };
    }

    // The resolve path still gets audited: nodemailer resolves on partial acceptance for
    // multi-recipient envelopes, and `sent` here must mean OUR one recipient was taken.
    if ((info.rejected ?? []).length > 0 || (info.accepted ?? []).length === 0) {
      return { status: "failed", retryable: false, error: "smtp_recipient_refused" };
    }
    // The Message-ID nodemailer minted — a locally-chosen correlation id (SMTP replies carry no
    // provider id worth parsing), which is what a mail log or maildir search keys on.
    return { status: "sent", providerId: info.messageId ?? null };
  }

  /** One line, capped, scrubbed of every secret this class can name. */
  private safe(value: unknown): string {
    return scrub(short(value), this.password);
  }
}

/** Nodemailer's bounded error class (`EENVELOPE`, `EMESSAGE`, …) — or a fixed word, never prose. */
function errClass(e: unknown): string {
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z]{1,24}$/.test(code) ? code : "unrecognised_error";
}

/** One line, capped. Collapsing whitespace first keeps a log line a log line. */
function short(value: unknown): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  return text.replace(/\s+/g, " ").slice(0, 200);
}

/**
 * Mask every secret shape a transport error could carry — the SMTP password above all, since it
 * rides inside `SMTP_URL` and node's connection errors love to echo the target. Same belt and
 * braces as ResendMailer's scrub, minus the Resend-key shapes that cannot occur here.
 */
function scrub(text: string, password: string): string {
  let out = text;
  if (password && password.length >= 4) out = out.split(password).join("[redacted]");
  return out
    .replace(/\b[^\s<>@]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[address]")
    .replace(/(smtps?:\/\/)[^\s@/]+@/gi, "$1[redacted]@")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]")
    .slice(0, 200);
}
