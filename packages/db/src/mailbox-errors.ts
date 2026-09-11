/**
 * The stable failure taxonomy stored in `mailboxes.error_code` — ONE definition. It was written
 * out three times — the worker's union (emits), the DTO union (ships `MailboxDTO.errorCode`), a
 * column comment — and nothing connected them, so the worker could emit a code the client has no
 * copy for and the Settings pane would render a blank reason next to a red mailbox. The
 * duplication looked architectural (the worker may not import services), but both already depend
 * on `@trafficflow/db`, and the taxonomy is the domain of a database column. One definition beats
 * a guard: drift becomes impossible rather than detected. TEXT rather than an enum, so a new
 * classification is a code deploy, never a migration that must land first.
 */

/** Every value `mailboxes.error_code` may hold. Order is documentation, not semantics. */
export const MAILBOX_ERROR_CODES = [
  "auth",
  "connect",
  "tls",
  "timeout",
  "storage",
  "sync",
  "unknown",
] as const;

export type MailboxErrorCode = (typeof MAILBOX_ERROR_CODES)[number];

/** Narrow a value read back from the column, which is TEXT and so has no type at rest. */
export function isMailboxErrorCode(v: unknown): v is MailboxErrorCode {
  return typeof v === "string" && (MAILBOX_ERROR_CODES as readonly string[]).includes(v);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   WHY A MAILBOX IS DISABLED — `mailboxes.disabled_reason` (mail 0027)
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Every value `mailboxes.disabled_reason` may hold. CLOSED, unlike {@link MAILBOX_ERROR_CODES} (a
 * failure taxonomy grows): this set tracks the organizer kinds — `cloud`, `local`, `mobile`,
 * `unknown` — and `unknown` is the catch-all that makes it closed rather than merely short. It
 * grows only when `ORGANIZER_KINDS` does, in the same slice; mail 0027 backs it with a CHECK.
 * `packages/core`'s `StandDownReason` is the engine's own union of the same strings and cannot
 * import this package — reconciled by assignment at the worker's gate plus a test that fails if
 * either side gains a member. NOT a failure: a mailbox carrying one is working, organized by
 * somebody else; the error columns are cleared in the same statement.
 */
export const MAILBOX_DISABLED_REASONS = [
  "organized_elsewhere:cloud",
  "organized_elsewhere:local",
  "organized_elsewhere:mobile",
  "organized_elsewhere:unknown",
] as const;

export type MailboxDisabledReason = (typeof MAILBOX_DISABLED_REASONS)[number];

/**
 * Is this a value `mailboxes.disabled_reason` is allowed to hold?
 *
 * Exported because it is the guard at the write site, the same way
 * `isSafeMailboxErrorDetail` is: a caller that hands a string typechecks against the column and
 * the membership test is what stops it. Unlike `error_detail`, an unrecognised value here is
 * NOT dropped to NULL — see `markMailboxStoodDown` for why a stand-down with no reason is worse
 * than a stand-down with an imprecise one.
 */
export function isMailboxDisabledReason(v: unknown): v is MailboxDisabledReason {
  return typeof v === "string" && (MAILBOX_DISABLED_REASONS as readonly string[]).includes(v);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   WHY A MAILBOX IS NOT BEING SYNCED WHILE ITS ROW SAYS `connected` — `sync_blocked_reason`
   (mail 0029)
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Every value `mailboxes.sync_blocked_reason` may hold — CLOSED for a third reason: these are the
 * ways OUR OWN infrastructure declines to serve a mailbox we know is expected. Each member is a
 * branch in the worker's own sync loop; a new one appears only with a new refusal branch, so the
 * migration lands with it, and it gets a CHECK. NO `no_organizer` member: the worker is the only
 * writer, and a column only the worker writes cannot say "no worker" — nobody would clear it, so
 * every row would lie after a deploy stopped a shard; that state lives in the liveness table and
 * `worker_down`. Not a failure, not a disable: the mailbox is `connected`, no backoff; every
 * writer leaving that state clears the column in the SAME statement.
 */
export const MAILBOX_SYNC_BLOCK_REASONS = [
  /**
   * `ohmail/_meta` could not be read, so we cannot prove this mailbox is ours to organize
   * (`LeaseUnavailableError`). The rule is that "could not look" is not "nobody holds it" and is
   * not "stand down". The mailbox is left unattached and the next roster pass tries again — which
   * is exactly the state that was previously invisible.
   */
  "lease_unreadable",
  /** Enabled, on the roster, and with no `imap` row in `mailbox_credentials` to connect with. */
  "awaiting_credentials",
  /** Dropped by this process's `maxMailboxes` cap: nothing in this deployment serves it. */
  "at_capacity",
  /**
   * A ceiling WE set ended the cycle (`ImapBoundExceeded` — a listing past its cap, a read past
   * its clock, a body past its overrun factor). The mailbox authenticated and answered; it sent
   * more than one pass takes. `status` stays `connected` and no error is recorded, because a cap
   * hit is not a broken mailbox — the distinction `markMailboxFailed` could not make.
   */
  "read_limited",
] as const;

export type MailboxSyncBlockReason = (typeof MAILBOX_SYNC_BLOCK_REASONS)[number];

/**
 * Is this a value `mailboxes.sync_blocked_reason` is allowed to hold?
 *
 * The narrowing predicate for a column that is TEXT at rest, and the guard at the write site the
 * way {@link isMailboxDisabledReason} is. `markMailboxSyncBlocked` takes a
 * {@link MailboxSyncBlockReason} so the compiler is the first gate; this is what a value READ BACK
 * out of the column has to pass before anything treats it as a member.
 */
export function isMailboxSyncBlockReason(v: unknown): v is MailboxSyncBlockReason {
  return typeof v === "string" && (MAILBOX_SYNC_BLOCK_REASONS as readonly string[]).includes(v);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   WHAT THE LAST `SIZE` PROBE OF A MAILBOX FOUND — `smtp_size_probe_code` (mail 0063)
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Every value `mailboxes.smtp_size_probe_code` may hold — CLOSED, with a CHECK, on {@link
 * MAILBOX_SYNC_BLOCK_REASONS}' argument: every member is a branch WE wrote. `learned`/`silent`
 * are our reading of RFC 1870; `auth_refused`/`unreachable`/`tls_refused`/`unknown` come from
 * `SmtpSizeFailure`'s closed switch over nodemailer's `code` field (a provider's new response
 * lands in `unknown`); `token_unavailable` and `no_credentials` mean no dial happened. The CHECK
 * is a privacy boundary: nodemailer's error text for an SMTP AUTH failure embeds the server's own
 * response line — routinely the username, possibly an echoed credential. The CHECK is the half of
 * the `code`-not-message rule that survives a call site nobody has written yet.
 */
export const SMTP_SIZE_PROBE_CODES = [
  /** The server announced a usable `SIZE`; the row carries the number. */
  "learned",
  /** The login completed and the server named no usable ceiling (no `SIZE`, bare, or `SIZE 0`). */
  "silent",
  /** The server refused the credentials we presented (nodemailer `EAUTH`). */
  "auth_refused",
  /** No usable connection: timeout, DNS, refused socket. */
  "unreachable",
  /** Connected, and TLS would not come up on the floor this product requires. */
  "tls_refused",
  /** An oauth mailbox, and no access token could be minted — so nothing was dialled. */
  "token_unavailable",
  /** Nothing to dial with: no credential row, an unsupported `authType`, an unreadable envelope. */
  "no_credentials",
  /** Dialled, and the failure classified as none of the above. Deliberately opaque. */
  "unknown",
] as const;

export type SmtpSizeProbeCode = (typeof SMTP_SIZE_PROBE_CODES)[number];

/**
 * Is this a value `mailboxes.smtp_size_probe_code` is allowed to hold?
 *
 * The narrowing predicate for a column that is TEXT at rest, exactly as
 * {@link isMailboxSyncBlockReason} is for its own. The probe pass takes a
 * {@link SmtpSizeProbeCode}, so the compiler is the first gate, the CHECK is the last, and this is
 * what a value read back OUT of the column has to pass before anything treats it as a member.
 */
export function isSmtpSizeProbeCode(v: unknown): v is SmtpSizeProbeCode {
  return typeof v === "string" && (SMTP_SIZE_PROBE_CODES as readonly string[]).includes(v);
}
