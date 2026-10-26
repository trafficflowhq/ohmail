import { silentLogger, type Logger } from "@trafficflow/core";
import { isMailboxErrorCode, type Tx } from "@trafficflow/db";
import {
  faultClassOf, recordConnectAttempt, type ConnectAttemptRow, type ConnectDoorWord, type ConnectPreset,
  type ConnectReason,
} from "@trafficflow/db/cloud";
import type { ConnectAttemptFacts, ConnectDoor } from "./deps.js";

/**
 * HOW CONNECTING A MAILBOX ENDED, recorded on the managed host (cloud 0054). HOSTED ONLY: the preset
 * table, the reason words and the insert live here, so the local engine's route table, which mounts
 * the doors, never carries them. `apps/api-vercel` alone composes {@link connectAttemptRecorder}.
 */

/** The doors are the table's closed set; a door the column refuses does not compile. */
const DOOR_WORD: Readonly<Record<ConnectDoor, ConnectDoorWord>> = {
  test: "test", connect: "connect", oauth_start: "oauth_start", oauth_complete: "oauth_complete",
};

/** Each preset's IMAP host (`PROVIDERS`; `provider-presets-parity.test.ts` holds them equal), and Gmail's other name. */
export const CONNECT_PRESET_IMAP_HOSTS: Readonly<Record<string, ConnectPreset>> = {
  "imap.gmail.com": "gmail",
  "imap.googlemail.com": "gmail",
  "outlook.office365.com": "microsoft",
  "imap.mail.me.com": "icloud",
  "imap.mail.yahoo.com": "yahoo",
  "imap.fastmail.com": "fastmail",
  "imap.gmx.net": "gmx",
  "mail.infomaniak.com": "infomaniak",
  "imap.web.de": "webde",
  "secureimap.t-online.de": "tonline",
  "imaps.bluewin.ch": "bluewin",
};

/** The preset a typed host names, by exact match after case and a trailing dot; any other host is `imap`. */
export function presetOfImapHost(host: unknown): ConnectPreset {
  if (typeof host !== "string") return "imap";
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  return Object.hasOwn(CONNECT_PRESET_IMAP_HOSTS, h) ? CONNECT_PRESET_IMAP_HOSTS[h]! : "imap";
}

const GOOGLE_HINT_REASON: Readonly<Record<string, ConnectReason>> = {
  app_password_required: "auth_app_password_required",
  web_login: "auth_web_login",
  imap_disabled: "auth_imap_disabled",
};

const OAUTH_REASONS: ReadonlySet<string> = new Set<ConnectReason>([
  "state_invalid", "state_expired", "account_mismatch", "provider_unavailable", "exchange_failed",
  "no_refresh_token", "no_address",
]);

const CODE_REASON: Readonly<Record<string, ConnectReason>> = {
  oauth_unconfigured: "oauth_unconfigured",
  mailbox_limit_reached: "at_limit",
  payment_required: "payment_required",
  account_suspended: "suspended",
  mailbox_not_permitted: "not_permitted",
  mailbox_busy: "busy",
  rate_limited: "rate_limited",
};

/** `ServiceError` by name (two copies of the package must still match), and the subclass that renames itself. */
const SERVICE_ERROR_NAMES: ReadonlySet<string> = new Set(["ServiceError", "MailboxAllowanceError"]);

/** A `ServiceError`'s code and details, or `null` for any other thrown value. */
function serviceErrorOf(err: unknown): { code: unknown; d: Record<string, unknown> } | null {
  if (!(err instanceof Error) || !SERVICE_ERROR_NAMES.has(err.name)) return null;
  const { code, details } = err as { code?: unknown; details?: unknown };
  return { code, d: (details !== null && typeof details === "object" ? details : {}) as Record<string, unknown> };
}

/** Why a door refused, as one word: from the error's name, code and details, never its message. */
export function connectAttemptReason(err: unknown): ConnectReason {
  const e = serviceErrorOf(err);
  if (e === null) return "internal";
  const { code, d } = e;
  if (code === "mailbox_probe_failed") {
    if (d.reason === "auth" && typeof d.authHint === "string" && Object.hasOwn(GOOGLE_HINT_REASON, d.authHint)) {
      return GOOGLE_HINT_REASON[d.authHint]!;
    }
    return isMailboxErrorCode(d.reason) ? d.reason : "unknown";
  }
  if (typeof d.reason === "string" && OAUTH_REASONS.has(d.reason)) return d.reason as ConnectReason;
  if (typeof code === "string" && Object.hasOwn(CODE_REASON, code)) return CODE_REASON[code]!;
  if (code === "validation_failed") return d.port !== undefined ? "port_refused" : "invalid";
  return "other";
}

/**
 * The row one door's facts become: closed words only, whatever the facts carried. `null` for a
 * connect the address index refuses as already made: a replay of a landed press, not a new attempt.
 */
export function connectAttemptRow(accountId: string, facts: ConnectAttemptFacts): ConnectAttemptRow | null {
  const door = DOOR_WORD[facts.door];
  const preset = door === "oauth_start" || door === "oauth_complete" ? "microsoft" : presetOfImapHost(facts.imapHost);
  if ("error" in facts) {
    const e = serviceErrorOf(facts.error);
    if (e?.code === "mailbox_exists") return null;
    // Which leg refused: only a mail server's refusal names one.
    const leg = e?.code === "mailbox_probe_failed" ? e.d.transport : null;
    const transport = leg === "imap" || leg === "smtp" ? leg : null;
    return { accountId, door, preset, outcome: "refused", reason: connectAttemptReason(facts.error), transport };
  }
  if (facts.smtpRefused !== undefined) {
    const reason = isMailboxErrorCode(facts.smtpRefused) ? facts.smtpRefused : "unknown";
    return { accountId, door, preset, outcome: "refused", reason, transport: "smtp" };
  }
  return { accountId, door, preset, outcome: "ok", reason: null, transport: null };
}

/**
 * The managed host's port: the row, through the erasure fence and the daily cap. Never throws; a row
 * not written is one `connect_attempt_not_recorded` line with the door and the error's class only.
 */
export function connectAttemptRecorder(
  db: Tx, now: () => Date, log: Logger = silentLogger,
): (accountId: string, facts: ConnectAttemptFacts) => Promise<void> {
  return async (accountId, facts) => {
    try {
      const row = connectAttemptRow(accountId, facts);
      if (row !== null) await recordConnectAttempt(db, row, now());
    } catch (err) {
      log.warn("connect_attempt_not_recorded", { door: facts.door, errorClass: faultClassOf(err) });
    }
  };
}
