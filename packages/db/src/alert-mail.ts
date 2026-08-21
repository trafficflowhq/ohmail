import {
  nodePostJson, renderAlertText,
  type AlertSink, type PostJson,
} from "./alerts.js";

/**
 * The MAIL arm of the worker's pager — one JSON POST to the product's own transactional
 * mailer (Resend), no vendor SDK, no `packages/services` import.
 *
 * ## Why the worker needs a second arm at all, measured not imagined
 *
 * 2026-08-21: `TF_ALERT_WEBHOOK_URL` pointed at ntfy.sh, and ntfy.sh blackholes the worker's
 * hosting platform's egress IPs — probed from inside the worker's own container, ports 443
 * and 80 both `ETIMEDOUT` while `https://example.com` and `https://api.resend.com` answered
 * 200. `sinkFailureStreak` reached 199 on a REAL firing `billing_events_failed` alert. The
 * escalation fired exactly as designed, into the same void. A pager with one arm is only as
 * alive as that arm's network path, and the product IS mail: the mailer the API host already
 * sends transactional mail through is reachable from the exact container the webhook was not.
 *
 * ## Why it is its own module, and not in `alerts.ts` or `packages/services`
 *
 * Not `alerts.ts`: that file's header states "everything here is drizzle over the schema plus
 * one fetch", comments here are contracts, and a vendor mail client falsifies it — so the
 * vendor lives one module over and `alerts.ts` keeps only the seam (`AlertSink`, `PostJson`).
 * Not `packages/services`: the WORKER may import `core` + `db` only (its dependency test pins
 * it), so `MailService` and the richer `mailAlertSink` are out of reach from the process that
 * needs this most. The API host keeps composing that one; this one is the worker's, and both
 * answer to the same `AlertSink` seam under the same name.
 *
 * ## `TF_ALERT_EMAIL` is the ARMING variable — the states, ruled explicitly
 *
 *  · `to` unset/blank ⇒ **null**, whatever the mailer halves say: an operator who clears the
 *    alert address has disarmed the mail arm on purpose, and a deployment whose mailer exists
 *    for OTHER mail must not page-escalate forever because the pager is deliberately off.
 *    This matches the API host's arming semantics for its own mail sink.
 *  · `to` set but `RESEND_API_KEY` or `MAIL_FROM` missing ⇒ a sink that refuses every
 *    delivery NAMING the missing variable — the `webhookAlertSink` lesson: set-but-unusable
 *    must not look like unset (the pass would tell the operator to set a variable that IS
 *    set) and must not be a bare `false` forever (the state the ntfy outage spent its whole
 *    life in).
 *  · `to` set but not a single plain address (the quoted-env trap, or a comma list) ⇒ the
 *    same, with the fault named. Parsed once, at build time, like the webhook URL.
 *
 * Deliberately DIVERGENT from `apps/api-vercel`'s all-or-nothing mail block: there, arming
 * the pager must not be able to toggle customer mail, so a partial block builds nothing. The
 * worker has no customer mail to protect and a misconfiguration here must be named by the
 * escalation, not silent.
 *
 * ## What a sink may say and send
 *
 * The subject and text are built from `Alert` fields only — counts, ages and rule names,
 * never mail content — via {@link renderAlertText}, and the subject leads with the
 * environment so nobody pages on staging. The payload carries exactly `from`, `to`,
 * `subject`, `text` and nothing else; a guard test pins the key set. Failure diagnostics are
 * drain-bound, so the API key — a HEADER credential, unlike the webhook's URL-path one — is
 * redacted from them and the text is bounded. No retry loop lives here: `runAlertPass`
 * releases an undelivered claim, and the worker's 60 s cadence IS the retry.
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
 * Make a failure sentence safe to log when the secret is a HEADER credential, not a URL.
 *
 * The sibling of `redactEndpoint`: the endpoint here is a fixed public URL and diagnostic,
 * but the API key rides in `Authorization`, and a thrown transport error or an echoing error
 * body could quote the request. Same 200-character bound, same reason — this lands in every
 * `alert_notified` line.
 */
function redactCredential(raw: string, secret: string): string {
  let out = raw.replace(/\s+/g, " ").trim();
  if (secret) out = out.split(secret).join("<redacted>");
  return out.length > 200 ? `${out.slice(0, 200)}…` : out;
}

/** One plain address: has an `@`, and none of the characters a quoted value or a list has. */
const SINGLE_ADDRESS = /^[^\s,"'<>]+@[^\s,"'<>]+$/;

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
    : !SINGLE_ADDRESS.test(to)
      ? "TF_ALERT_EMAIL is set but is not a single plain address (surrounding quotes, a " +
        "display name, or a comma list in the value?)"
      : null;
  if (configError) {
    return { name: "mail", notify: () => Promise.resolve({ ok: false, error: configError }) };
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
        const res = await post(RESEND_EMAILS_URL, body, { authorization: `Bearer ${apiKey}` });
        if (res.status >= 200 && res.status < 300) return { ok: true };
        return {
          ok: false,
          error: redactCredential(
            `HTTP ${res.status}${res.body ? ` — ${res.body}` : ""}`, apiKey,
          ),
        };
      } catch (err) {
        // Never throws — the other sink must still get its chance — and it says what
        // happened, because "the mail arm refused" with no reason attached is the state the
        // webhook arm spent months in.
        const e = err as { name?: string; message?: string; cause?: { message?: string; code?: string } };
        const cause = e?.cause?.code ?? e?.cause?.message ?? "";
        const text = `${e?.name ?? "Error"}: ${e?.message ?? String(err)}${cause ? ` (${cause})` : ""}`;
        return { ok: false, error: redactCredential(text, apiKey) };
      }
    },
  };
}
