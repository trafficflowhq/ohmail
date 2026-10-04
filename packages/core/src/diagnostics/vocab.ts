/**
 * EVERY WORD THE DIAGNOSTIC FILE MAY WRITE THAT IS NOT A NUMBER. Each value slot reads one of
 * these closed sets and writes `other` for anything outside it, so no string a mailbox or a
 * server supplied can reach the file through a slot. The three mailbox sets are copies of
 * `@trafficflow/db`'s (this leaf is bundled into a webview and a phone and cannot import it);
 * this package's tests hold each copy equal to its source.
 */

export const DIAGNOSTIC_MAILBOX_ERROR_CODES = [
  "auth", "connect", "tls", "timeout", "storage", "sync", "unknown",
] as const;

export const DIAGNOSTIC_DISABLED_REASONS = [
  "organized_elsewhere:cloud", "organized_elsewhere:local", "organized_elsewhere:mobile",
  "organized_elsewhere:unknown",
] as const;

export const DIAGNOSTIC_BLOCK_REASONS = [
  "lease_unreadable", "awaiting_credentials", "at_capacity", "read_limited", "clock_off",
  "account_closed", "provider_unavailable", "meta_folder_full", "meta_undeletable",
] as const;

/** The client mirror's types — `@ohmail/client-engine`'s `MIRROR_ENTITY_TYPES`, held equal there. */
export const DIAGNOSTIC_ENTITY_TYPES = [
  "message", "thread", "routing_decision", "approval", "draft", "rule", "message_state",
  "folder", "tag", "mailbox", "screener_suggestion", "mailbox_profile",
  "screener_sender", "triage_item", "view_meta", "message_body", "held_release_group",
  "unscreened_sender_group", "screener_waiting", "outbox_entry", "outbox_abandoned", "store_page",
] as const;

export const DIAGNOSTIC_OS = ["linux", "macos", "windows", "ios", "android"] as const;
export const DIAGNOSTIC_ARCH = ["x86_64", "aarch64", "arm", "x86"] as const;
export const DIAGNOSTIC_SURFACES = ["desktop", "phone"] as const;

/** How the last pass over a mailbox ended, derived from its row. */
export const DIAGNOSTIC_SYNC_OUTCOMES = [
  "synced", "never_synced", "blocked", "failed", "disabled", "unknown",
] as const;

/** The organizer lease as this install last read it. `none` is a row that says nothing about one. */
export const DIAGNOSTIC_LEASE_OUTCOMES = [
  "held", "stopped", "unchecked", "sibling_lapse", "unreadable", "clock_off", "meta_folder_full",
  "meta_undeletable", "none",
] as const;

export const DIAGNOSTIC_ROLES = ["organizer", "reader", "unknown"] as const;

export type DiagnosticOs = (typeof DIAGNOSTIC_OS)[number] | "other";
export type DiagnosticArch = (typeof DIAGNOSTIC_ARCH)[number] | "other";
export type DiagnosticSurface = (typeof DIAGNOSTIC_SURFACES)[number];
export type DiagnosticSyncOutcome = (typeof DIAGNOSTIC_SYNC_OUTCOMES)[number];
export type DiagnosticLeaseOutcome = (typeof DIAGNOSTIC_LEASE_OUTCOMES)[number];
export type DiagnosticRole = (typeof DIAGNOSTIC_ROLES)[number];
export type DiagnosticEntityType = (typeof DIAGNOSTIC_ENTITY_TYPES)[number];
export type DiagnosticMailboxErrorCode = (typeof DIAGNOSTIC_MAILBOX_ERROR_CODES)[number] | "other";
export type DiagnosticDisabledReason = (typeof DIAGNOSTIC_DISABLED_REASONS)[number] | "other";
export type DiagnosticBlockReason = (typeof DIAGNOSTIC_BLOCK_REASONS)[number] | "other";

/** `value` if it is a member of `set`, `other` if it is any other string, `null` if absent. */
export function memberOr<T extends string>(set: readonly T[], value: unknown): T | "other" | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" && (set as readonly string[]).includes(value) ? (value as T) : "other";
}
