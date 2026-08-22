import {
  classifyTransportError, nodePostJson, redactEndpoint, renderAlertText,
  type AlertSink, type PostJson,
} from "./alerts.js";

/**
 * The PUSH arm of the pager — one JSON POST to the Telegram Bot API, no vendor SDK, no new
 * dependency, and no relationship with the vendor that carries the other arm.
 *
 * ## Why a second vendor at all, and why THIS one — measured, not preferred
 *
 * The pager has been single-vendor since the webhook arm was removed: `TF_ALERT_WEBHOOK_URL`
 * pointed at ntfy.sh, ntfy.sh blackholes this deployment's hosting egress, and after that was
 * proven the dead variable was deleted rather than left as permanent noise. Correct, and it
 * left every page in the world travelling through one transactional-mail account. That account
 * going down — an outage, a suspension, a revoked key, a bounced domain — takes the pager with
 * it, at exactly the moment something is wrong.
 *
 * The candidates were probed from inside the running container, not chosen from memory:
 *
 * ```
 *   api.telegram.org   → 200   86 ms      discord.com     → 200    65 ms
 *   api.resend.com     → 200  110 ms      hooks.slack.com → 200   566 ms
 *   ntfy.sh            → ETIMEDOUT 258 ms (still blackholed — the control)
 * ```
 *
 * Telegram wins on the axes that matter for a pager and on no others:
 *
 *  · **A different failure domain, on every axis.** Different company, different network,
 *    different credential (a bot token, not the mail key), and a different DELIVERY CHANNEL:
 *    a push to a device rather than a message into a mailbox. That last one is not a detail
 *    here — the operator address is a mailbox this very product serves, so "the product's mail
 *    path is broken" is both a thing worth paging about and a reason the page may never be
 *    seen. An arm that does not touch mail at all is the only arm that survives that.
 *  · **No billing relationship**, so it cannot be suspended alongside anything else, and
 *    nothing about it expires quietly.
 *  · **One JSON POST**, so it obeys the constraint that shaped every sink here: the worker may
 *    import `core` + `db` only, and this file reaches for nothing but `fetch`.
 *
 * Slack and Discord are equally reachable and were rejected for needing a workspace or a
 * server to exist and stay owned; ntfy is dead on evidence, not on assumption.
 *
 * ## Arming, and why it differs from the mail arm's rule
 *
 * `resendAlertSink` treats its DESTINATION as the arming variable: `RESEND_API_KEY` and
 * `MAIL_FROM` exist for customer mail regardless, so an operator clearing `TF_ALERT_EMAIL` has
 * deliberately disarmed the arm and must not be escalated at.
 *
 * Neither Telegram variable exists for any other purpose. So EITHER of them present means
 * somebody meant to arm this, and the missing half is a fault to be named rather than a
 * disarm to be respected:
 *
 *  · neither set ⇒ **null** — the arm is not configured, quietly. The pass reports how many
 *    arms it has, and the worker says so at startup;
 *  · one set, the other missing ⇒ a sink that refuses every delivery NAMING the missing
 *    variable. Set-but-unusable is not the same state as unset — the `webhookAlertSink`
 *    lesson, and a half-configured second arm that looked like an absent one would be the
 *    single-vendor state wearing a two-vendor label;
 *  · both set but one of them malformed (the quoted-env trap, a chat title instead of an id)
 *    ⇒ the same, with the fault named. Parsed once, at build time, like the other two arms.
 *
 * ## What it may say and send
 *
 * Subject and body come from `Alert` fields only — counts, ages and rule names, never mail —
 * via {@link renderAlertText}, and the text is capped to Telegram's own limit rather than left
 * to be refused as a 400 on the day an incident fires several rules at once. The bot token is
 * a URL-PATH credential, exactly like the webhook arm's endpoint, so diagnostics go through
 * {@link redactEndpoint} plus a token-shaped scrub for anything the API echoes back. No retry
 * loop: `runAlertPass` releases an undelivered claim and the driver's cadence is the retry.
 */

/** Where the push arm posts. The token picks the bot, so the origin is fixed. */
export const TELEGRAM_API_ORIGIN = "https://api.telegram.org";

/**
 * Telegram refuses a `sendMessage` whose text exceeds 4096 characters with a 400.
 *
 * A cap rather than a hope: {@link renderAlertText} renders every firing alert with its full
 * detail sentence, and the four rules' details are long enough that three or four firing at
 * once clears 4096 comfortably. Uncapped, the push arm would fail EXACTLY during a multi-rule
 * incident — the one it exists for — and the failure would read as a vendor refusal.
 */
export const TELEGRAM_TEXT_LIMIT = 4096;

/** What is dropped to leave room for the marker. Characters, matching Telegram's own unit. */
const TELEGRAM_TEXT_BUDGET = TELEGRAM_TEXT_LIMIT - 32;

export interface TelegramAlertSinkConfig {
  /** `TF_ALERT_TELEGRAM_BOT_TOKEN` — the bot credential, from BotFather. */
  botToken?: string | undefined;
  /** `TF_ALERT_TELEGRAM_CHAT_ID` — where it posts: a numeric chat id, or an `@channel`. */
  chatId?: string | undefined;
}

/**
 * A BotFather token: a numeric bot id, a colon, then the secret half.
 *
 * Pinned at build time for `webhookAlertSink`'s reason — a value that is present but unusable
 * produced, before that rule existed, an arm that failed forever with no stated cause. The
 * commonest way to get one here is an env value that kept its surrounding quotes.
 */
const BOT_TOKEN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

/**
 * A chat id: the numeric form Telegram hands out (negative for groups and channels), or a
 * public `@username`. A chat TITLE is neither, and it is what someone reaches for first.
 */
const CHAT_ID = /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

/**
 * What redaction scrubs beyond the endpoint itself.
 *
 * The same reasoning `alert-mail.ts` records for its own shapes: exact-string replacement
 * misses every variant this sink did not configure — a rotated token the API echoes back, or a
 * whole URL quoted inside an error body that {@link redactEndpoint} did not match verbatim.
 * Anything SHAPED like a bot token goes, whether or not it is ours.
 */
const TOKEN_SHAPE = /\b\d{5,}:[A-Za-z0-9_-]{30,}\b/g;

/** Endpoint redaction plus the token shape. Bounded to 200 like every other sink's. */
function redact(raw: string, endpoint: string): string {
  const out = redactEndpoint(raw, endpoint).replace(TOKEN_SHAPE, "<redacted>");
  return out.length > 200 ? `${out.slice(0, 200)}…` : out;
}

/**
 * Stringify a `catch` value without the formatter itself throwing.
 *
 * The same fix `alert-mail.ts` carries, for the same reviewed reason: template interpolation
 * of a Symbol throws, so a transport rejecting with a symbol-valued `message` made THIS
 * function the thing that violated the never-throws contract.
 */
function asText(v: unknown): string {
  try { return String(v); } catch {
    try { return Object.prototype.toString.call(v); } catch { return "unprintable"; }
  }
}

/** See the module header for the whole design; the arming states are ruled there. */
export function telegramAlertSink(
  cfg: TelegramAlertSinkConfig, post: PostJson = nodePostJson,
): AlertSink | null {
  const botToken = cfg.botToken?.trim() ?? "";
  const chatId = cfg.chatId?.trim() ?? "";
  if (!botToken && !chatId) return null;

  const missing = [
    ...(botToken ? [] : ["TF_ALERT_TELEGRAM_BOT_TOKEN"]),
    ...(chatId ? [] : ["TF_ALERT_TELEGRAM_CHAT_ID"]),
  ];
  const configError = missing.length > 0
    ? `the Telegram alert arm is half-configured: missing ${missing.join(", ")}`
    : !BOT_TOKEN.test(botToken)
      ? "TF_ALERT_TELEGRAM_BOT_TOKEN is set but is not a BotFather token of the form " +
        "<botid>:<secret> (surrounding quotes or whitespace in the value?)"
      : !CHAT_ID.test(chatId)
        ? "TF_ALERT_TELEGRAM_CHAT_ID is set but is neither a numeric chat id nor an " +
          "@channelusername (a chat TITLE is neither; surrounding quotes in the value?)"
        : null;
  if (configError) {
    return {
      name: "telegram",
      notify: () => Promise.resolve({ ok: false, error: configError, outcome: "misconfigured" }),
    };
  }

  const endpoint = `${TELEGRAM_API_ORIGIN}/bot${botToken}/sendMessage`;

  return {
    name: "telegram",
    async notify(alerts, ctx) {
      try {
        const full = `ohmail ${ctx.environment}\n\n${renderAlertText(alerts, ctx)}`;
        const text = full.length > TELEGRAM_TEXT_LIMIT
          ? `${full.slice(0, TELEGRAM_TEXT_BUDGET)}\n… (truncated)`
          : full;
        const body = JSON.stringify({
          // A STRING, never a number: chat ids for channels run past 2^53 and `JSON.stringify`
          // of a rounded double would post to a chat that does not exist. Telegram accepts both
          // forms; only one of them survives a large id.
          chat_id: chatId,
          text,
          // An alert's detail sentences name no URL, but a rule that grows one later must not
          // turn a page into a preview fetch from the pager's own infrastructure.
          disable_web_page_preview: true,
        });
        const res = await post(endpoint, body);
        // Telegram's HTTP status mirrors the `ok` field of its envelope: a 2xx is always
        // `{"ok":true,...}` and a refusal is a 4xx carrying `description`. So the status is
        // the whole verdict here, and the description arrives through `PostJson`'s body, which
        // is read on refusals only.
        if (res.status >= 200 && res.status < 300) return { ok: true, outcome: "ok" };
        return {
          ok: false,
          outcome: "refused",
          error: redact(`HTTP ${res.status}${res.body ? ` — ${res.body}` : ""}`, endpoint),
        };
      } catch (err) {
        // Never throws — the other arms must still get their chance — and it says what
        // happened, with a closed code beside the sentence so a dead arm is machine-visible
        // and not merely readable.
        const e = err as { name?: unknown; message?: unknown; cause?: { message?: unknown; code?: unknown } };
        const causeRaw = e?.cause?.code ?? e?.cause?.message;
        const cause = causeRaw === undefined || causeRaw === "" ? "" : asText(causeRaw);
        const name = e?.name === undefined ? "Error" : asText(e.name);
        const message = e?.message === undefined ? asText(err) : asText(e.message);
        const text = `${name}: ${message}${cause ? ` (${cause})` : ""}`;
        return { ok: false, outcome: classifyTransportError(err), error: redact(text, endpoint) };
      }
    },
  };
}
