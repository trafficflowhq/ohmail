/**
 * THE CLOSED SETS A MAILBOX'S ROW CARRIES, as they travel on `MailboxDTO`. Each is the domain of
 * a database column and lives as a LIST beside that column, where every member has its story
 * (`packages/db/src/mailbox-errors.ts`, `organizer-role.ts`); the database package proves its
 * lists equal to these unions (`wire-parity.ts`), so a member added on one side does not compile
 * until the other has it.
 */

/**
 * WHY a mailbox is in `error` (mail 0023). A stable key, not a sentence: the client owns the
 * wording, so the copy stays localizable and the server never ships English down the wire.
 *
 * `unknown` is a real member and not a fallback for a missing case — the worker emits it when
 * it genuinely cannot name the failure, and the UI must say so rather than guess.
 */
export type MailboxErrorCode = "auth" | "connect" | "tls" | "timeout" | "storage" | "sync" | "unknown";

/** Who else organizes a mailbox this install stood down from: the organizer kinds, as a reason. */
export type MailboxDisabledReason =
  | "organized_elsewhere:cloud"
  | "organized_elsewhere:local"
  | "organized_elsewhere:mobile"
  | "organized_elsewhere:unknown";

/** Why a mailbox is not being synced while its row says `connected`. Not a failure, not a disable. */
export type MailboxSyncBlockReason =
  | "lease_unreadable"
  | "awaiting_credentials"
  | "at_capacity"
  | "read_limited"
  | "clock_off"
  | "account_closed"
  | "provider_unavailable"
  | "meta_folder_full"
  | "meta_undeletable"
  | "mailbox_full";

/** What kind of install organizes a mailbox. `unknown` is a peer this build cannot rank. */
export type OrganizerKind = "cloud" | "local" | "mobile" | "unknown";
