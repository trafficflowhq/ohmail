import { createHash } from "node:crypto";
import {
  classifyTransportError, nodePostJson,
  type Alert, type AlertDeliveryResult, type AlertSink, type PostJson,
} from "./alerts.js";
import { DIGEST_INTERVAL_MS, MAIL_COOLDOWN_MS, type AlertDigest } from "./alert-mail-policy.js";

/**
 * The mail arm of the worker's pager — one JSON POST to the product's own transactional mailer,
 * no SDK, no `packages/services` import. Measured need: the webhook arm's host blackholes the
 * worker's egress while the mailer answered 200; the failure streak reached 199 on a real firing
 * alert. Its own module: the worker imports core + db only. `TF_ALERT_EMAIL` arms it: unset ⇒
 * null; set but unusable ⇒ a sink refusing every delivery naming the fault (no customer mail to
 * protect here, unlike the API host). The mail is {@link renderAlertMail}'s, from `Alert` fields
 * only; five payload keys (pinned); the key redacted. A `channel: "mail"` sink: the pass hands it
 * pages only (`alert-mail-policy.ts`) and a daily digest, never a resolution.
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

/** The mail schedule, from the constants the pass runs on — the footer every alert mail carries. */
export const ALERT_MAIL_SCHEDULE =
  "Sent when an alert starts. Another mail about the same kind of alert waits at least " +
  `${hours(MAIL_COOLDOWN_MS)} unless its severity rises. Nothing is mailed when an alert ` +
  "clears, and lesser alerts wait for the daily summary.";

const DIGEST_MAIL_SCHEDULE =
  `Sent at most once every ${hours(DIGEST_INTERVAL_MS)}, listing every incident that opened, stood ` +
  "or cleared since the last summary. Nothing is sent when there is nothing to list.";

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

/** The daily summary: one line per incident, from the digest alone. No clock, no driver. */
export function renderDigestMail(
  digest: AlertDigest, environment: string, consoleUrl?: string | null,
): AlertMail {
  const n = digest.lines.length + digest.more;
  return mailOf(
    `[${environment}] ohmail: daily alert summary — ${n} incident${n === 1 ? "" : "s"}`,
    [
      { body: `Incidents since ${digest.since}.` },
      ...digest.lines.map((l) => ({
        body: `[${l.severity}] ${l.title ?? l.kind} — ${l.key} — opened ${l.openedAt}` +
          (l.resolvedAt ? ` — resolved ${l.resolvedAt}` : ""),
      })),
      ...(digest.more > 0 ? [{ body: `${digest.more} more — open the console.` }] : []),
    ],
    consoleLink(consoleUrl), DIGEST_MAIL_SCHEDULE,
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

/**
 * A lone `schema_behind` has no `alert_state` row to hold a cooldown, and its body is constant per
 * host, so its key holds for the page window instead: the provider replays the first result.
 */
export function alertIdempotencyBucketMs(alerts: readonly Pick<Alert, "kind">[]): number {
  return alerts.length === 1 && alerts[0]!.kind === "schema_behind"
    ? MAIL_COOLDOWN_MS : ALERT_IDEMPOTENCY_BUCKET_MS;
}

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
    const refuse = () => Promise.resolve({ ok: false, error: configError, outcome: "misconfigured" as const });
    return { name: "mail", channel: "mail", notify: refuse, notifyDigest: refuse };
  }

  // The belt for a lone `schema_behind`: once one was accepted, its key stays put for the page
  // window even across a clock bucket's edge. In-process; the bucket alone covers a restart.
  let behindAnchor: { bucket: number; acceptedAt: number } | null = null;

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
    channel: "mail",
    async notify(alerts, ctx) {
      const mail = renderAlertMail({
        alerts, environment: ctx.environment, source: ctx.source, consoleUrl,
      });
      const body = JSON.stringify({ from, to: [to], subject: mail.subject, text: mail.text, html: mail.html });
      // Retries of the same page inside one bucket replay the stored result instead of mailing
      // again; a different body or alert set is a different key, so nothing is refused.
      const bucketMs = alertIdempotencyBucketMs(alerts);
      const now = ctx.now.getTime();
      const behind = bucketMs !== ALERT_IDEMPOTENCY_BUCKET_MS;
      const bucket = behind && behindAnchor && now - behindAnchor.acceptedAt < bucketMs
        ? behindAnchor.bucket : Math.floor(now / bucketMs);
      const keys = alerts.map((a) => a.key).sort().join("+");
      const out = await send(body, `tf-alert/${ctx.source}/${bucket}/${digest(`${keys}\n${body}`)}`);
      if (behind && out.ok && behindAnchor?.bucket !== bucket) behindAnchor = { bucket, acceptedAt: now };
      return out;
    },
    async notifyDigest(d, ctx) {
      // Built from the digest and the environment only, so a retry sends the same bytes.
      const mail = renderDigestMail(d, ctx.environment, consoleUrl);
      const body = JSON.stringify({ from, to: [to], subject: mail.subject, text: mail.text, html: mail.html });
      return send(body, `tf-alert/digest/${d.since}/${digest(body)}`);
    },
  };
}
