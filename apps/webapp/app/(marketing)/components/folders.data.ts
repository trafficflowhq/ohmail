/**
 * The IMAP folder tree the landing showcase (and the public README) draw — as DATA,
 * so a test can diff it against the frozen folder set in `@trafficflow/core` rather
 * than trust a screenshot.
 *
 * Claims-are-contracts. Every `organizer` row here is a real member of
 * `WATCHED_FOLDERS`; the one `meta` row is `META_FOLDER`; and no row is ever a folder
 * named "Spam" — spam is `ohmail/Quarantine`, and "Spam" is only ever a view label.
 * `test/folder-showcase.test.ts` fails red if any of that stops being true.
 */

/**
 * `organizer` — one of the six frozen destinations ohmail files mail into (the
 *   `WATCHED_FOLDERS` set: `INBOX` plus the five `ohmail/*` folders).
 * `meta` — the `ohmail/_meta` housekeeping folder (`META_FOLDER`): the organizer
 *   lease, created unsubscribed so it never shows up as mail. Not a mail folder.
 * `untouched` — a folder that already exists in the mailbox and that ohmail never
 *   creates, moves into, or writes to (the provider's own Junk; the Sent folder).
 */
export type ShowcaseRole = "organizer" | "meta" | "untouched";

export interface ShowcaseFolder {
  /** The IMAP path exactly as it lives in the mailbox — this is the contract. */
  path: string;
  /** The leaf name as a mail app shows it. */
  label: string;
  /** Top-level row, or a child nested under the `ohmail/` parent. */
  group: "top" | "ohmail";
  role: ShowcaseRole;
  /** i18n key under the `folders` namespace for this row's one-line role note. */
  noteKey: string;
}

export const SHOWCASE_FOLDERS: readonly ShowcaseFolder[] = [
  { path: "INBOX", label: "Inbox", group: "top", role: "organizer", noteKey: "inbox" },
  { path: "Junk", label: "Junk", group: "top", role: "untouched", noteKey: "junk" },
  { path: "Sent", label: "Sent", group: "top", role: "untouched", noteKey: "sent" },
  { path: "ohmail/Screener", label: "Screener", group: "ohmail", role: "organizer", noteKey: "screener" },
  { path: "ohmail/Reads", label: "Reads", group: "ohmail", role: "organizer", noteKey: "reads" },
  { path: "ohmail/Receipts", label: "Receipts", group: "ohmail", role: "organizer", noteKey: "receipts" },
  { path: "ohmail/Screened", label: "Screened", group: "ohmail", role: "organizer", noteKey: "screened" },
  { path: "ohmail/Quarantine", label: "Quarantine", group: "ohmail", role: "organizer", noteKey: "quarantine" },
  { path: "ohmail/_meta", label: "_meta", group: "ohmail", role: "meta", noteKey: "meta" },
];

/** The `ohmail/` parent row is drawn once, above its children — it holds no mail itself. */
export const OHMAIL_PARENT_LABEL = "ohmail";
