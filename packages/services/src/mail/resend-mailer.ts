import {
  assertUsableFrom, normalizeRecipient, underTestRunner,
  type MailerPort, type MailSendResult, type OutboundEmail, type SendOptions,
} from "./port.js";
import { renderTemplate, type TemplateDataMap, type TemplateName } from "./templates.js";

/**
 * The HTTP seam, so `ResendMailer` never touches a global.
 *
 * Same shape of argument as `RemoteFetch` in `privacy-service.ts` and for the same
 * reason: the implementation is injected, so the suite can prove no request left the
 * process by simply not providing one that can. `nodeHttpPost` is the production
 * adapter; tests pass a recording double.
 */
export interface HttpPost {
  post(url: string, init: {
    headers: Record<string, string>;
    body: string;
    timeoutMs: number;
  }): Promise<{ status: number; body: string }>;
}

/** Production `HttpPost` over `globalThis.fetch`, with a hard timeout. */
export const nodeHttpPost: HttpPost = {
  async post(url, init) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), init.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST", headers: init.headers, body: init.body, signal: ac.signal,
      });
      return { status: res.status, body: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  },
};

export interface ResendMailerConfig {
  apiKey: string;
  /**
   * RFC5322 From. The dedicated transactional SUBDOMAIN, not the marketing domain:
   * `ohmail <no-reply@mail.ohmail.app>`. A bounce storm from a verification mail must
   * not be able to move `ohmail.app`'s reputation, and the two have entirely separate
   * DKIM keys and DMARC policies as a result.
   */
  from: string;
  /** Where a reply goes. `no-reply@…` is not a mailbox; this is. */
  replyTo?: string;
  /** Injected transport. Defaults to {@link nodeHttpPost}; tests always pass a double. */
  http?: HttpPost;
  /** Provider endpoint — overridable so a test double never needs a real hostname. */
  endpoint?: string;
  timeoutMs?: number;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * `MailerPort` over Resend's REST API.
 *
 * It renders the template itself (via the shared `renderTemplate`, so the spy and the
 * snapshots see byte-identical output) and posts `{from,to,subject,html,text,headers}`.
 *
 * It NEVER throws from `send`. A network error, a timeout, a 4xx and a 5xx all come back
 * as `{status:"failed"}` with `retryable` set from the class of failure.
 *
 * ── The error string is a CODE, never a body ─────────────────────────────────────
 *
 * This class used to put a truncated copy of the provider's response into
 * `MailSendResult.error`, and the doc comment right here told callers that value goes to
 * logs. An independent review pointed out what that combination is: an
 * attacker-influenced, provider-authored string, copied verbatim into our log stream.
 * Resend's own 401 body echoes the API key back (`"API key re_… is invalid"`), a 422
 * echoes the recipient, and nothing stops a future error class from echoing a header we
 * sent. So the provider's body is now reduced to an **allow-listed machine code** —
 * `[a-z_]{1,40}` taken from Resend's `name` field, or `unrecognised_error` — and every
 * remaining error string (transport throws, render failures) goes through {@link scrub},
 * which masks the API key, `re_…` keys, email addresses, URL query strings and
 * token-shaped runs. `mail-resend.test.ts` asserts the exact secrets are absent rather
 * than asserting a length.
 *
 * ── It refuses to construct with a real socket under a test runner ───────────────
 *
 * The standing rule is "the suite performs zero external requests". `cfg.http` defaulting to
 * `nodeHttpPost` meant one future `new ResendMailer({apiKey: env.RESEND_API_KEY, …})` in
 * a route test would have made a real send to a real inbox. Under vitest the
 * default transport is therefore a construction ERROR: a test must inject one. The
 * suite-wide network trap in `test/setup/no-external-network.ts` is the second layer.
 *
 * Open and click tracking must stay OFF on the sending domain. Open tracking injects a
 * remote 1×1 into the HTML and click tracking rewrites every href through the provider —
 * i.e. exactly the two things `privacy-service.ts` strips out of other people's mail. The
 * flags live in the Resend dashboard, not in this code, so they are a deployment
 * readiness gate rather than something this class can enforce.
 */
export class ResendMailer implements MailerPort {
  private readonly http: HttpPost;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(private readonly cfg: ResendMailerConfig) {
    assertUsableFrom("ResendMailer", cfg.from);
    if (!cfg.http && underTestRunner()) {
      throw new Error(
        "ResendMailer: refusing to construct with the real network transport under a test " +
        "runner — the suite performs zero external requests. Inject `http` — see SpyMailer, " +
        "or the recorder in mail-resend.test.ts.",
      );
    }
    this.http = cfg.http ?? nodeHttpPost;
    this.endpoint = cfg.endpoint ?? RESEND_ENDPOINT;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async send<K extends TemplateName>(
    to: string, template: K, data: TemplateDataMap[K], opts: SendOptions = {},
  ): Promise<MailSendResult> {
    const recipient = normalizeRecipient(to);
    if (!recipient) return { status: "skipped", reason: "invalid_recipient" };

    let mail: OutboundEmail;
    try {
      mail = { ...renderTemplate(template, data), from: this.cfg.from, to: recipient, replyTo: this.cfg.replyTo };
    } catch (e) {
      // A template that cannot render is OUR bug, not a provider outage: never retryable.
      // `safeUrl` no longer echoes the URL it rejected, but scrub it anyway — this string
      // is log-destined and the next template author does not read that comment.
      return { status: "failed", retryable: false, error: `render_failed: ${this.safe(e)}` };
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      "Content-Type": "application/json",
    };
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

    const body = JSON.stringify({
      from: mail.from,
      to: [mail.to],
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      ...(mail.replyTo ? { reply_to: mail.replyTo } : {}),
      ...(mail.headers ? { headers: mail.headers } : {}),
    });

    let res: { status: number; body: string };
    try {
      res = await this.http.post(this.endpoint, { headers, body, timeoutMs: this.timeoutMs });
    } catch (e) {
      // Network error, DNS failure, or our own AbortController firing. Transient by class.
      return { status: "failed", retryable: true, error: `transport: ${this.safe(e)}` };
    }

    if (res.status >= 200 && res.status < 300) {
      return { status: "sent", providerId: idOf(res.body) };
    }
    // 429 and 5xx are the provider's problem and would succeed later; every other 4xx
    // (bad key, unverified domain, malformed payload) is ours and will not.
    const retryable = res.status === 429 || res.status >= 500;
    return { status: "failed", retryable, error: `resend_${res.status}: ${providerCode(res.body)}` };
  }

  /** One line, capped, scrubbed of every secret this class can name. */
  private safe(value: unknown): string {
    return scrub(short(value), this.cfg.apiKey);
  }
}

/** Resend answers `{ "id": "<uuid>" }`. A body we cannot parse is not a failure. */
function idOf(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { id?: unknown };
    return typeof parsed.id === "string" ? parsed.id : null;
  } catch {
    return null;
  }
}

/** One line, capped. Collapsing whitespace first keeps a log line a log line. */
function short(value: unknown): string {
  const text = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
  return text.replace(/\s+/g, " ").slice(0, 200);
}

/**
 * Reduce a provider error body to a machine code we are willing to log.
 *
 * Resend answers `{"statusCode":422,"message":"…","name":"validation_error"}`. `name` is
 * the only field that is a bounded enum rather than free prose, and the regex pins that:
 * anything that is not a short lower-snake token — including a `name` an attacker somehow
 * influenced — collapses to `unrecognised_error`. The HTTP status is already in the
 * caller's string and carries the same diagnostic weight without the body.
 *
 * Losing the provider's prose is the point. Diagnosing a 422 means reading Resend's own
 * dashboard, which has the full event; it does not mean copying an unbounded remote
 * string into our logs forever.
 */
function providerCode(body: string): string {
  try {
    const parsed = JSON.parse(body) as { name?: unknown };
    if (typeof parsed.name === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(parsed.name)) {
      return parsed.name;
    }
  } catch { /* not JSON — Cloudflare error page, empty body, HTML gateway */ }
  return "unrecognised_error";
}

/**
 * Mask every secret shape that could reach a log line, in order of specificity.
 *
 * Belt and braces: `providerCode` already means no provider body reaches here, and
 * `safeUrl` no longer echoes URLs. This is the layer that keeps holding when someone
 * adds a third error path and forgets both of those facts.
 */
function scrub(text: string, apiKey: string): string {
  let out = text;
  if (apiKey && apiKey.length >= 8) out = out.split(apiKey).join("re_[redacted]");
  return out
    // Resend keys, whoever printed them.
    .replace(/\bre_[A-Za-z0-9_-]{4,}/g, "re_[redacted]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    // Any address — ours, the recipient's, or one the provider echoed.
    .replace(/\b[^\s<>@]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[address]")
    // A URL's query and fragment are where every credential in this slice lives.
    .replace(/(https?:\/\/[^\s?#]*)[?#]\S*/gi, "$1?[redacted]")
    // A bare high-entropy run: a raw token or invite code that arrived some other way.
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]")
    .slice(0, 200);
}
