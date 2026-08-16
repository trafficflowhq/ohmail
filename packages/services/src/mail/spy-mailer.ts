import {
  normalizeRecipient,
  type MailerPort, type MailSendResult, type SendOptions,
} from "./port.js";
import {
  renderTemplate, type RenderedEmail, type TemplateDataMap, type TemplateName,
} from "./templates.js";

/** One recorded send. `rendered` is the REAL template output, not a stand-in. */
export interface SpiedSend<K extends TemplateName = TemplateName> {
  to: string;
  template: K;
  data: TemplateDataMap[K];
  rendered: RenderedEmail;
  idempotencyKey?: string;
}

/**
 * The test `MailerPort`. Lives in `src/` (like `makeTestAuthDeps`) so `packages/api`
 * and any end-to-end walkthrough can inject it without reaching into another package's
 * test folder.
 *
 * It RENDERS. A spy that only recorded `(to, template, data)` would let a template
 * that throws on its own data pass every test in the suite, so the spy runs exactly
 * the same `renderTemplate` the Resend implementation runs, and stores the output for
 * assertions. What it does not do is anything network-shaped — there is no HTTP client
 * in this file, which is the structural half of "zero external requests in the suite".
 *
 * `failNext`/`skipNext` let a test drive the failure branches of a caller without
 * mocking a transport.
 */
export class SpyMailer implements MailerPort {
  readonly sent: SpiedSend[] = [];
  /** Queued outcomes; each `send` shifts one, and an empty queue means "sent". */
  private readonly queued: MailSendResult[] = [];
  private nextId = 0;

  async send<K extends TemplateName>(
    to: string, template: K, data: TemplateDataMap[K], opts: SendOptions = {},
  ): Promise<MailSendResult> {
    const recipient = normalizeRecipient(to);
    if (!recipient) return { status: "skipped", reason: "invalid_recipient" };

    let rendered: RenderedEmail;
    try {
      rendered = renderTemplate(template, data);
    } catch (e) {
      return {
        status: "failed", retryable: false,
        error: `render_failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    const outcome = this.queued.shift() ?? {
      status: "sent" as const, providerId: `spy-${++this.nextId}`,
    };
    // A queued FAILURE still records the attempt: "we tried to mail this person"
    // is the fact a caller's test is usually asserting.
    this.sent.push({ to: recipient, template, data, rendered, idempotencyKey: opts.idempotencyKey });
    return outcome;
  }

  /** Make the next `send` come back as a failure without a transport in the picture. */
  failNext(error = "spy_failure", retryable = true): void {
    this.queued.push({ status: "failed", retryable, error });
  }

  /** Make the next `send` come back as skipped. */
  skipNext(reason: Extract<MailSendResult, { status: "skipped" }>["reason"] = "mailer_disabled"): void {
    this.queued.push({ status: "skipped", reason });
  }

  /** Every send of one template, in order. */
  ofTemplate<K extends TemplateName>(template: K): SpiedSend<K>[] {
    return this.sent.filter((s) => s.template === template) as SpiedSend<K>[];
  }

  /** The one send this test expects, or a failure loud enough to read. */
  only<K extends TemplateName>(template: K): SpiedSend<K> {
    const hits = this.ofTemplate(template);
    if (hits.length !== 1) {
      throw new Error(
        `SpyMailer: expected exactly 1 "${template}" send, saw ${hits.length} ` +
        `(all sends: ${this.sent.map((s) => s.template).join(", ") || "none"})`,
      );
    }
    return hits[0]!;
  }

  reset(): void {
    this.sent.length = 0;
    this.queued.length = 0;
  }
}

/**
 * The mailer a deployment with no Resend credentials gets: it renders nothing, sends
 * nothing, and answers `skipped`. Preview deployments and local dev use it so a
 * developer cannot mail a stranger from their laptop by running a route.
 */
export const disabledMailer: MailerPort = {
  async send(): Promise<MailSendResult> {
    return { status: "skipped", reason: "mailer_disabled" };
  },
};
