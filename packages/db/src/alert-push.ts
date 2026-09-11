import {
  classifyTransportError, nodePostJson, redactEndpoint, renderAlertText,
  type AlertSink, type PostJson,
} from "./alerts.js";

/**
 * The push arm of the pager — one JSON POST to the Telegram Bot API, no SDK, no shared vendor
 * with the other arm. Measured: candidates probed from inside the container; Telegram wins on a
 * different failure domain on every axis — company, network, credential, channel (a device push,
 * not a message into a mailbox this very product serves); no billing relationship. Arming differs
 * from the mail arm: neither variable exists for any other purpose, so either present means
 * somebody meant to arm it — neither ⇒ null; one missing or malformed ⇒ a sink refusing every
 * delivery naming the fault. Text capped to Telegram's limit; the token is a URL-path credential,
 * redacted plus a token-shaped scrub. No retry loop: the cadence is the retry.
 */

/** Where the push arm posts. The token picks the bot, so the origin is fixed. */
export const TELEGRAM_API_ORIGIN = "https://api.telegram.org";

/**
 * Telegram refuses a `sendMessage` whose text exceeds 4096 characters with a 400.
 *
 * A cap rather than a hope: {@link renderAlertText} renders every firing alert with its full
 * detail sentence, and those details are long enough that three or four firing at
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
 * What redaction scrubs beyond the endpoint — anything shaped like a bot token, ours or not:
 * exact-string replacement misses a rotated token the API echoes back. No boundary assertions at
 * all; every boundary written here leaked. `\b` on the right: the secret may legally end in a
 * hyphen, and at the `{30,}` floor dropping it breaks the quantifier and redacts nothing. A left
 * lookbehind excludes the commonest delimiters in error prose (`token:<token>` matched nothing —
 * 12 of 21 shapes leaked). A left boundary cannot be right, and it is not needed: the tail is
 * greedy, so a match extends to the end of the run; starting mid-run costs a few leading digits
 * of the bot id, not the secret. Over-redaction is the safe direction.
 */
const TOKEN_SHAPE = /\d{5,}:[A-Za-z0-9_-]{30,}/g;

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
