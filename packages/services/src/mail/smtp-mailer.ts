import { createTransport, type Transporter } from "nodemailer";
import {
  assertUsableFrom, normalizeRecipient, underTestRunner,
  type MailerPort, type MailSendResult, type OutboundEmail, type SendOptions,
} from "./port.js";
import { renderTemplate, type TemplateDataMap, type TemplateName } from "./templates.js";

/**
 * `MailerPort` over plain SMTP — the self-host transport, where the operator brings their own
 * submission server (`SMTP_URL` + `MAIL_FROM` on the standalone server's config) instead of a
 * Resend account. Same closed template set, same never-throws contract, same scrubbed error
 * grammar as {@link ResendMailer}; only the wire differs.
 *
 * ── EXPORTED FROM THE FULL BARREL ONLY — never from `./index.ts` beside ResendMailer ─────────
 *
 * This file is the ONE module in the package that imports `nodemailer`, and the desktop engine
 * bundles `@trafficflow/services/mail`. The engine already carries its own nodemailer — for
 * sending the USER's mail through the user's own server — but this class must never ride along:
 * a transactional system mailer inside a local-first engine is dead weight at best and a
 * mail-bomb primitive at worst. `mail-entry-census.test.ts` walks the `/mail` module graph and
 * pins both facts: no `nodemailer` specifier in that graph, and no importer of this file other
 * than the package's full barrel.
 *
 * ── `sent` MEANS THE SERVER TOOK THE MESSAGE FOR THIS RECIPIENT ───────────────────────────────
 *
 * The one semantic that must not drift, because a DATABASE FACT keys on it:
 * `markInviteDelivered` upgrades an invite row to `confers_verified: true` exactly when the
 * mailer answers `sent` — the claim "a mail carried this code to the bound address", which is
 * what lets the account registering through that code start email-verified. An optimistic `sent`
 * (connection opened, or message merely handed to nodemailer) would stamp receipt-proof for an
 * inbox that never received anything — the forged-verification hole the column closes, re-opened
 * from the transport layer. So `sent` here is precisely: the SMTP dialogue completed and the
 * server answered 250 to DATA with this recipient accepted and none rejected. A refused RCPT, a
 * rejected DATA, a dropped connection — all `failed`, never `sent`.
 *
 * SMTP acceptance is still acceptance-for-DELIVERY-ATTEMPT, not delivery — a later bounce is
 * invisible to this process. That is the same epistemic position `ResendMailer` is in (Resend's
 * 200 precedes its own delivery attempt), so `sent` means the same thing on both transports:
 * the message left our hands and a server took responsibility for it.
 *
 * ── Retryability is SMTP's polarity, not HTTP's ───────────────────────────────────────────────
 *
 * 4yz is "transient, try later" and 5yz is "permanent, do not" (RFC 5321 §4.2.1) — the inverse
 * of the HTTP intuition where 4xx is final. Connection-level failures (refused, timeout, DNS)
 * are retryable by class, exactly like ResendMailer's transport arm.
 *
 * ── What SMTP does not have ───────────────────────────────────────────────────────────────────
 *
 * `SendOptions.idempotencyKey` is provider-side dedup and SMTP has no such header; the option is
 * accepted and unused, stated here rather than silently. The callers that rely on it
 * (`MailService`'s three keyed templates) degrade to exactly the pre-key behaviour: a re-driven
 * invocation may send twice. On a self-host box that is one duplicate mail in one operator's
 * family, not a fleet-scale incident.
 *
 * ── Under a test runner, only loopback ────────────────────────────────────────────────────────
 *
 * The suite performs zero external requests, structurally. `ResendMailer` enforces that by
 * refusing its default HTTP transport; the SMTP equivalent of "inject a double" is a loopback
 * sink, so construction under vitest refuses any host that is not 127.0.0.1/::1/localhost.
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

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const isLoopback = (hostname: string): boolean =>
  LOOPBACK.has(hostname.toLowerCase()) || hostname.startsWith("127.");

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
    if (underTestRunner() && !isLoopback(url.hostname)) {
      throw new Error(
        "SmtpMailer: refusing a non-loopback SMTP host under a test runner — the suite performs " +
        "zero external requests. Point the URL at a loopback sink; see smtp-mailer.test.ts.",
      );
    }

    const secure = url.protocol === "smtps:";
    const user = decodeURIComponent(url.username);
    this.password = decodeURIComponent(url.password);
    this.transporter = createTransport({
      host: url.hostname,
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
      requireTLS: !secure && user !== "" && !isLoopback(url.hostname),
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
