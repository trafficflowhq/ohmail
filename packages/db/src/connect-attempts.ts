import { and, eq, gt, sql } from "drizzle-orm";
import { fencedAccountWrite } from "./erasure-fence.js";
import { connectAttempts } from "./schema-cloud.js";
import type { Tx } from "./change-log.js";

/**
 * HOW CONNECTING A MAILBOX ENDED (cloud 0054): the closed words a row may hold and its one writer.
 * The managed API's recorder maps a request onto these; 0054's CHECKs bound them at rest.
 */
export const CONNECT_DOORS = ["test", "connect", "oauth_start", "oauth_complete"] as const;
export type ConnectDoorWord = (typeof CONNECT_DOORS)[number];

/** The server's own preset ids, and `imap` for any other host. */
export const CONNECT_PRESETS = [
  "gmail", "microsoft", "icloud", "yahoo", "fastmail", "gmx", "infomaniak", "webde", "tonline", "bluewin", "imap",
] as const;
export type ConnectPreset = (typeof CONNECT_PRESETS)[number];

/** Why an attempt was refused, as one word. */
export const CONNECT_REASONS = [
  // What the mail server answered (`MAILBOX_ERROR_CODES`), and Google's three named refusals.
  "auth", "connect", "tls", "timeout", "storage", "sync", "unknown",
  "auth_app_password_required", "auth_web_login", "auth_imap_disabled",
  // The Microsoft sign-in.
  "state_invalid", "state_expired", "account_mismatch", "provider_unavailable", "exchange_failed",
  "no_refresh_token", "no_address", "oauth_unconfigured",
  // The account's plan and standing.
  "at_limit", "payment_required", "suspended", "not_permitted",
  // This server.
  "busy", "rate_limited", "port_refused", "invalid", "other", "internal",
] as const;
export type ConnectReason = (typeof CONNECT_REASONS)[number];

/** At most this many rows per account in any 24 hours; the next attempt is not recorded. */
export const CONNECT_ATTEMPTS_PER_DAY = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ConnectAttemptRow {
  accountId: string;
  door: ConnectDoorWord;
  preset: ConnectPreset;
  outcome: "ok" | "refused";
  reason: ConnectReason | null;
  transport: "imap" | "smtp" | null;
}

/**
 * One row, through the erasure fence, so a record cannot land after the account's erasure (an
 * erased account throws `AccountErasedError`, as every fenced write does). `capped` writes nothing.
 */
export async function recordConnectAttempt(
  db: Tx, row: ConnectAttemptRow, now: Date,
): Promise<"recorded" | "capped"> {
  return fencedAccountWrite(db, { accountId: row.accountId }, async (tx) => {
    const [day] = await tx.select({ n: sql<number>`count(*)::int` }).from(connectAttempts).where(and(
      eq(connectAttempts.accountId, row.accountId),
      gt(connectAttempts.at, new Date(now.getTime() - DAY_MS)),
    ));
    if (Number(day?.n ?? 0) >= CONNECT_ATTEMPTS_PER_DAY) return "capped";
    await tx.insert(connectAttempts).values({ ...row, at: now });
    return "recorded";
  });
}
