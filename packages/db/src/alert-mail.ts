import { createHash } from "node:crypto";
import {
  classifyTransportError, nodePostJson,
  DEFAULT_ALERT_FLAP_FLOOR_MS, DEFAULT_ALERT_RENOTIFY_UNCHANGED_MS, DEFAULT_ALERT_REPEAT_MS,
  DEFAULT_CRITICAL_HOURLY_PAGES,
  type AlertDeliveryResult, type AlertSink, type PostJson, type ResolutionNotice,
} from "./alerts.js";

/**
 * The mail arm of the worker's pager — one JSON POST to the product's own transactional mailer,
 * no SDK, no `packages/services` import. Measured need: the webhook arm's host blackholes the
 * worker's egress while the mailer answered 200; the failure streak reached 199 on a real firing
 * alert. Its own module: `alerts.ts` stays "drizzle plus one fetch", and the worker imports core
 * + db only. `TF_ALERT_EMAIL` arms it: unset ⇒ null (a deliberate disarm); set but unusable ⇒ a
 * sink refusing every delivery naming the fault. Divergent from the API host's all-or-nothing
 * block: no customer mail to protect here. The mail is {@link renderAlertMail}'s, from `Alert`
 * fields only; five payload keys (pinned); the key redacted; the cadence is the retry.
 */

/** Where the mail arm posts. Fixed rather than configurable — the credential picks the account. */
export const RESEND_EMAILS_URL = "https://api.resend.com/emails";

/**
 * The three variables behind the worker's mail arm, spelled exactly as the API host spells
 * them (`RESEND_API_KEY`, `MAIL_FROM`, `TF_ALERT_EMAIL`) — the `msOAuthEnv` rule: two hosts
 * that accept different names for one mailer is a split-brain reached through spelling.
 */
export interface ResendAlertSinkConfig {
  /** `RESEND_API_KEY` — a bearer credential for the product's transactional mailer. */
  apiKey?: string | undefined;
  /** `MAIL_FROM` — the From the product already sends transactional mail as. */
  from?: string | undefined;
  /** `TF_ALERT_EMAIL` — the operator address alert mail goes to. The arming variable. */
  to?: string | undefined;
  /** `TF_ADMIN_URL` — the console the mail links to, the API host's spelling. Absent: no link. */
  consoleUrl?: string | undefined;
}

/* ════════════════════════════════════════════════════════════════════════════════════════
   THE ALERT MAIL — one renderer for both hosts' mail arms
   ════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * One alert mail. Both drivers run the pass on one `alert_state` and whichever wins the claim
 * mails, so both mail arms send these bytes: this worker sink, and the API host's operator
 * template, which returns this unchanged. A pure function of its input — no clock, no host.
 */
export interface AlertMail { subject: string; text: string; html: string }

export interface AlertMailInput {
  /** The fields a mail prints. `severity` is a string: the API host's template data carries one. */
  alerts: ReadonlyArray<{ severity: string; title: string; detail: string }>;
  environment: string;
  /** Which driver observed it: `worker` or `api`. */
  source: string;
  /** The admin console. An https URL (http on localhost) renders a link; anything else, none. */
  consoleUrl?: string | null;
}

const hours = (ms: number): string => `${ms / 3_600_000} h`;

/** The page schedule, from the constants the pass runs on — the footer every alert mail carries. */
export const ALERT_MAIL_SCHEDULE =
  "Sent when an alert starts and when it gets worse than any earlier mail about it said (for " +
  "example a higher severity, or its count past the next doubling). A falling count sends " +
  "nothing. While " +
  `it stands, a critical alert is sent again after ${hours(DEFAULT_ALERT_REPEAT_MS)} until it ` +
  `has been sent ${DEFAULT_CRITICAL_HOURLY_PAGES} times, then every ` +
  `${hours(DEFAULT_ALERT_RENOTIFY_UNCHANGED_MS)}; a warning every ` +
  `${hours(DEFAULT_ALERT_RENOTIFY_UNCHANGED_MS)}.`;

const RESOLVED_MAIL_SCHEDULE =
  `Sent once, after the alert has stayed resolved for ${hours(DEFAULT_ALERT_FLAP_FLOOR_MS)}.`;

const escHtml = (v: string): string => v
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The console link, normalised so both hosts print one spelling, or null. */
function consoleLink(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    return u.protocol === "https:" || (u.protocol === "http:" && local) ? u.toString() : null;
  } catch { return null; }
}

/** Plain text and a minimal html from the same blocks: no remote resource, every value escaped. */
function mailOf(subject: string, blocks: ReadonlyArray<{ strong?: string; body: string }>,
  link: string | null, footer: string): AlertMail {
  const text = [
    subject, "",
    ...blocks.flatMap((b) => [b.strong ? `${b.strong}\n  ${b.body}` : b.body, ""]),
    ...(link ? [`Admin console: ${link}`, ""] : []),
    "—", footer, "",
  ].join("\n");
  const P = '<p style="margin:0 0 12px;">';
  const html = [
    "<!doctype html>", '<html lang="en">', "<head>", '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escHtml(subject)}</title>`, "</head>",
    '<body style="margin:0;padding:24px 16px;background:#ffffff;color:#1e1a16;' +
      "font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;\">",
    `<h1 style="margin:0 0 16px;font-size:18px;">${escHtml(subject)}</h1>`,
    ...blocks.map((b) => b.strong
      ? `${P}<strong>${escHtml(b.strong)}</strong><br><span>${escHtml(b.body)}</span></p>`
      : `${P}${escHtml(b.body)}</p>`),
    ...(link ? [`${P}<a href="${escHtml(link)}">Open the admin console</a></p>`] : []),
    `<p style="margin:24px 0 0;color:#5c534b;font-size:13px;">${escHtml(footer)}</p>`,
    "</body>", "</html>", "",
  ].join("\n");
  return { subject, text, html };
}

/** The firing mail. Every value comes from `Alert` fields, which are counts, ages and rule names. */
export function renderAlertMail(input: AlertMailInput): AlertMail {
  const n = input.alerts.length;
  return mailOf(
    `[${input.environment}] ohmail: ${n} alert${n === 1 ? "" : "s"} firing`,
    [
      { body: `Observed by the ${input.source} alert pass.` },
      ...input.alerts.map((a) => ({ strong: `[${a.severity}] ${a.title}`, body: a.detail })),
    ],
    consoleLink(input.consoleUrl), ALERT_MAIL_SCHEDULE,
  );
}

/** The resolved mail: key, kind, the firing's span and its page count. No clock, no driver. */
export function renderResolvedMail(
  notices: readonly ResolutionNotice[], environment: string, consoleUrl?: string | null,
): AlertMail {
  return mailOf(
    `[${environment}] ohmail: resolved — ${notices.map((n) => n.key).join(", ")}`,
    notices.map((n) => ({
      body: `${n.key} (${n.kind}) — firing since ${n.openedAt}, resolved at ${n.resolvedAt}, ` +
        `paged ${n.pages} time(s). It has stayed resolved since.`,
    })),
    consoleLink(consoleUrl), RESOLVED_MAIL_SCHEDULE,
  );
}

/**
 * How long one notification's Idempotency-Key stays stable across delivery retries. A POST the
 * provider accepted whose response was lost looks like a failure, and the retry must dedupe
 * rather than mail again; a stored key blocking a page that never sent is bounded to one bucket.
 * The key also carries a digest of the exact body: the provider refuses a reused key with a new
 * body, and a count that moved between two sends inside one bucket silenced the pager for it.
 */
export const ALERT_IDEMPOTENCY_BUCKET_MS = 10 * 60 * 1000;

const digest = (body: string): string => createHash("sha256").update(body).digest("hex").slice(0, 32);

/**
 * What redaction scrubs BEYOND the one key this sink holds.
 *
 * Review finding: exact-string replacement misses every variant the sink did not configure —
 * a rotated old key the provider echoes back, or a whole Authorization line quoted in an
 * error body. Anything SHAPED like a Resend key or a bearer value goes, whether or not it is
 * ours; the message's prose survives, which is the whole reason this sink reports bodies.
 */
const SECRET_SHAPES: readonly RegExp[] = [
  /\bre_[A-Za-z0-9_]{8,}\b/g,                       // any Resend-shaped key, not just ours
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_.-]{8,}/gi,   // an echoed Authorization value
];

/**
 * Make a failure sentence safe to log when the secret is a HEADER credential, not a URL.
 *
 * The sibling of `redactEndpoint`: the endpoint here is a fixed public URL and diagnostic,
 * but the API key rides in `Authorization`, and a thrown transport error or an echoing error
 * body could quote the request. Exact key first, then the {@link SECRET_SHAPES} patterns.
 * Same 200-character bound, same reason — this lands in every `alert_notified` line.
 */
function redactCredential(raw: string, secret: string): string {
  let out = raw.replace(/\s+/g, " ").trim();
  if (secret) out = out.split(secret).join("<redacted>");
  for (const shape of SECRET_SHAPES) out = out.replace(shape, "<redacted>");
  return out.length > 200 ? `${out.slice(0, 200)}…` : out;
}

/**
 * Stringify a value that came out of a `catch`, without the formatter itself throwing.
 *
 * Review finding: template interpolation of a Symbol throws, so a transport rejecting with
 * `{ message: Symbol(...) }` made the FORMATTER the thing that threw — `deliver()`'s belt
 * caught it, but this sink's own never-reject contract was violated. `String()` handles
 * symbols explicitly; a toString that itself throws falls through to the tag.
 */
function asText(v: unknown): string {
  try { return String(v); } catch {
    try { return Object.prototype.toString.call(v); } catch { return "unprintable"; }
  }
}

/**
 * One plain address, structurally: exactly one `@`, a dotted domain, and none of the characters a
 * quoted env value, a display-name form, or a list has. Two review findings pulled in opposite
 * directions: an apostrophe inside the local part is legal mail, and the first validator's
 * blanket quote-ban built a permanently-refusing sink from a valid address — with the webhook arm
 * already dead, a pager that never pages, reached through correct configuration. Meanwhile two
 * `@`s, a dotless domain, separators and escapes all passed it, surfacing as endless provider
 * refusals instead of a named `TF_ALERT_EMAIL` fault. So: apostrophes allowed inside the local
 * part only, and the structure is pinned at build time, like the webhook URL's parse.
 */
const SINGLE_ADDRESS = /^[^\s@,;<>"\\]+@[^\s@,;<>"'\\]+\.[^\s@,;<>"'\\.]+$/;

/** See the module header for the whole design; the states are ruled there. */
export function resendAlertSink(
  cfg: ResendAlertSinkConfig, post: PostJson = nodePostJson,
): AlertSink | null {
  const apiKey = cfg.apiKey?.trim() ?? "";
  const from = cfg.from?.trim() ?? "";
  const to = cfg.to?.trim() ?? "";
  if (!to) return null;
  const consoleUrl = cfg.consoleUrl ?? null;

  const missing = [
    ...(apiKey ? [] : ["RESEND_API_KEY"]),
    ...(from ? [] : ["MAIL_FROM"]),
  ];
  const configError = missing.length > 0
    ? `TF_ALERT_EMAIL is set but the mailer is not: missing ${missing.join(", ")}`
    : (/^'/.test(to) || /'$/.test(to) || !SINGLE_ADDRESS.test(to))
      ? "TF_ALERT_EMAIL is set but is not a single plain address (surrounding quotes, a " +
        "display name, or a comma list in the value?)"
      : null;
  if (configError) {
    return {
      name: "mail",
      notify: () => Promise.resolve({ ok: false, error: configError, outcome: "misconfigured" }),
    };
  }

  /** One POST under one key; the key is a function of the body, so it cannot meet another. */
  async function send(body: string, idem: string): Promise<AlertDeliveryResult> {
    try {
      const res = await post(RESEND_EMAILS_URL, body, {
        authorization: `Bearer ${apiKey}`,
        "Idempotency-Key": idem,
      });
      if (res.status >= 200 && res.status < 300) return { ok: true, outcome: "ok" };
      return {
        ok: false,
        outcome: "refused",
        error: redactCredential(`HTTP ${res.status}${res.body ? ` — ${res.body}` : ""}`, apiKey),
      };
    } catch (err) {
      // Never throws — the other sink must still get its chance — and it says what happened.
      // Every property goes through {@link asText}: a thrown value owes this formatter nothing.
      const e = err as { name?: unknown; message?: unknown; cause?: { message?: unknown; code?: unknown } };
      const causeRaw = e?.cause?.code ?? e?.cause?.message;
      const cause = causeRaw === undefined || causeRaw === "" ? "" : asText(causeRaw);
      const name = e?.name === undefined ? "Error" : asText(e.name);
      const message = e?.message === undefined ? asText(err) : asText(e.message);
      const text = `${name}: ${message}${cause ? ` (${cause})` : ""}`;
      return { ok: false, outcome: classifyTransportError(err), error: redactCredential(text, apiKey) };
    }
  }

  return {
    name: "mail",
    async notify(alerts, ctx) {
      const mail = renderAlertMail({
        alerts, environment: ctx.environment, source: ctx.source, consoleUrl,
      });
      const body = JSON.stringify({ from, to: [to], subject: mail.subject, text: mail.text, html: mail.html });
      // Retries of the same page inside one bucket replay the stored result instead of mailing
      // again; a different body or alert set is a different key, so nothing is refused.
      const bucket = Math.floor(ctx.now.getTime() / ALERT_IDEMPOTENCY_BUCKET_MS);
      const keys = alerts.map((a) => a.key).sort().join("+");
      return send(body, `tf-alert/${ctx.source}/${bucket}/${digest(`${keys}\n${body}`)}`);
    },
    async notifyResolved(notices, ctx) {
      // Built from the notices and the environment only: whichever driver retries, whenever,
      // sends these exact bytes under this exact key.
      const mail = renderResolvedMail(notices, ctx.environment, consoleUrl);
      const body = JSON.stringify({ from, to: [to], subject: mail.subject, text: mail.text, html: mail.html });
      const first = notices[0]!;
      return send(body, `tf-alert/resolved/${first.key}/${first.resolvedAt}/${digest(body)}`);
    },
  };
}
