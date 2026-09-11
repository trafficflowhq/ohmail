import {
  classifyTransportError, nodePostJson, renderAlertText,
  type AlertSink, type PostJson,
} from "./alerts.js";

/**
 * The mail arm of the worker's pager — one JSON POST to the product's own transactional mailer,
 * no SDK, no `packages/services` import. Measured need: the webhook arm's host blackholes the
 * worker's egress while the mailer answered 200; the failure streak reached 199 on a real firing
 * alert. Its own module: `alerts.ts` stays "drizzle plus one fetch", and the worker imports core
 * + db only. `TF_ALERT_EMAIL` arms it: unset ⇒ null (a deliberate disarm); set but unusable ⇒ a
 * sink refusing every delivery naming the fault. Divergent from the API host's all-or-nothing
 * block: no customer mail to protect here. Text from `Alert` fields only; exactly four payload
 * keys (pinned); the API key redacted; no retry loop — the cadence is the retry.
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
}

/**
 * How long one notification's Idempotency-Key stays stable across delivery retries. The failure
 * this closes: a POST the provider accepted whose response was lost looks like a failure, the
 * pass releases its claim, and the cadence sends another mail — per minute, for as long as the
 * response path is broken. The design direction stands (a duplicate page beats a swallowed one),
 * so the key is bucketed rather than per-notification-forever: retries inside one window dedupe
 * on the provider, and the inverse hazard — a stored key blocking a page that never sent — is
 * bounded to one bucket. Ten minutes: an order larger than the retry cadence, an order smaller
 * than the one-hour repeat.
 */
export const ALERT_IDEMPOTENCY_BUCKET_MS = 10 * 60 * 1000;

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

  return {
    name: "mail",
    async notify(alerts, ctx) {
      try {
        const body = JSON.stringify({
          from,
          to: [to],
          subject: `ohmail ${ctx.environment}: ${alerts.length} alert(s) firing`,
          text: renderAlertText(alerts, ctx),
        });
        // The Idempotency-Key makes a lost RESPONSE distinguishable from a lost SEND on the
        // provider's side: retries inside one bucket replay the stored result instead of
        // mailing again. Sorted keys, so evaluation order cannot split one page into two.
        const bucket = Math.floor(ctx.now.getTime() / ALERT_IDEMPOTENCY_BUCKET_MS);
        const idem = `tf-alert/${ctx.source}/${bucket}/${alerts.map((a) => a.key).sort().join("+")}`;
        const res = await post(RESEND_EMAILS_URL, body, {
          authorization: `Bearer ${apiKey}`,
          "Idempotency-Key": idem,
        });
        if (res.status >= 200 && res.status < 300) return { ok: true, outcome: "ok" };
        return {
          ok: false,
          outcome: "refused",
          error: redactCredential(
            `HTTP ${res.status}${res.body ? ` — ${res.body}` : ""}`, apiKey,
          ),
        };
      } catch (err) {
        // Never throws — the other sink must still get its chance — and it says what
        // happened, because "the mail arm refused" with no reason attached is the state the
        // webhook arm spent months in. Every property goes through {@link asText}: a thrown
        // value owes this formatter nothing, least of all string-typed fields.
        const e = err as { name?: unknown; message?: unknown; cause?: { message?: unknown; code?: unknown } };
        const causeRaw = e?.cause?.code ?? e?.cause?.message;
        const cause = causeRaw === undefined || causeRaw === "" ? "" : asText(causeRaw);
        const name = e?.name === undefined ? "Error" : asText(e.name);
        const message = e?.message === undefined ? asText(err) : asText(e.message);
        const text = `${name}: ${message}${cause ? ` (${cause})` : ""}`;
        return { ok: false, outcome: classifyTransportError(err), error: redactCredential(text, apiKey) };
      }
    },
  };
}
