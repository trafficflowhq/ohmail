/**
 * The stable failure taxonomy stored in `mailboxes.error_code` — ONE definition.
 *
 * It was written out three times: this union in the worker's mailbox module (which EMITS the
 * values), the identical union in `packages/services/src/dto/types.ts` (which SHIPS them to the
 * client as `MailboxDTO.errorCode`), and a `//` comment on the column itself. Nothing connected
 * them, so the DTO could come to promise a code the worker never emits, or — worse in the other
 * direction — the worker could emit one the client has no copy for and the Settings pane would
 * render a blank reason next to a red mailbox.
 *
 * The duplication looked architectural: an import boundary forbids the worker importing
 * `@trafficflow/services` (that package resolves Stripe and Resend, which are not installed in the
 * worker's image, and a guard walks the worker's sources and fails on such an import). But the
 * constraint is only about *that* edge —
 * both the worker and services already depend on `@trafficflow/db`, and this taxonomy is the
 * domain of a database column, so this is where it belongs. A guard "asserting the two unions
 * match" was the other option; a single definition is strictly better, because it makes the
 * drift impossible rather than merely detected.
 *
 * TEXT in the database rather than a Postgres enum, so adding a classification is a code deploy
 * and never a migration that has to land before the worker that emits it.
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
 * Every value `mailboxes.disabled_reason` may hold. CLOSED, and closed for a different reason
 * than {@link MAILBOX_ERROR_CODES} is open.
 *
 * `error_code` is a failure taxonomy and taxonomies grow, which is why migration 0023 kept it out
 * of a Postgres enum. This set does not grow: it is the fixed set of organizer kinds
 * — `cloud`, `local`, and `unknown` for a peer whose kind or protocol we cannot rank — and
 * `unknown` is the catch-all that makes it closed rather than merely short. So mail 0027 backs
 * it with a CHECK constraint as well, and a test against real Postgres watches it refuse.
 *
 * It lives HERE and not in a second list. The failure taxonomy's three copies were collapsed into
 * this module because the taxonomy is the domain of a database column; the same argument applies
 * verbatim to this one. `packages/core`'s `StandDownReason` is the ENGINE's own union of the same
 * three strings and cannot import this package (the engine tier may not depend on the private
 * half) — so the two are reconciled by assignment at the one place they meet, the worker's gate,
 * plus a test that fails if either side gains a member the other lacks.
 *
 * NOT A FAILURE. A mailbox carrying one of these is working perfectly and is being organized by
 * somebody else; `error_code` / `error_detail` / `failed_at` are cleared in the same statement
 * that writes it, or the row would say "organized elsewhere" and "the mailbox rejected the
 * password" at once.
 */
export const MAILBOX_DISABLED_REASONS = [
  "organized_elsewhere:cloud",
  "organized_elsewhere:local",
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
 * Every value `mailboxes.sync_blocked_reason` may hold. CLOSED, and closed for a THIRD reason —
 * neither {@link MAILBOX_ERROR_CODES}' nor {@link MAILBOX_DISABLED_REASONS}'.
 *
 * ── WHAT THE SET *IS*, WHICH IS WHY IT CANNOT GROW UNDER US ────────────────────────────────
 *
 * These are the ways OUR OWN INFRASTRUCTURE declines to serve a mailbox that we know is
 * expected. Not one member is chosen by, derived from, or influenced by a mail server: each is a
 * branch in the worker's own sync loop that we wrote and can enumerate by reading it.
 * 0023's argument for leaving `error_code` unconstrained — "a failure taxonomy grows, and a new
 * classification must be a code deploy rather than a migration that has to land before the worker
 * that emits it" — is an argument about the *provider's* failure vocabulary, which is unbounded
 * because providers are. **It does not apply here, and someone will claim it does.** A new member
 * of this set can only appear alongside a new refusal branch in the worker, which is a code change
 * either way; the migration lands with it, in the same slice.
 *
 * So it gets a CHECK constraint, like `disabled_reason` and unlike `error_code`.
 *
 * ── THERE IS NO `no_organizer` MEMBER, AND THAT IS DELIBERATE ──────────────────────────────
 *
 * "There is no worker running at all" is the one blocked state this column structurally cannot
 * record: **the worker is the only writer.** A column only the worker writes cannot say "no
 * worker" — nobody would be there to write it, and nobody would be there to clear it either, so
 * every row would carry a stale reason for ever after the deploy that stopped a shard. That state
 * lives in the sync fleet's liveness table (one row per shard, beat staleness) and is reported by the
 * `worker_down` alert rule in `alerts.ts`. Adding the member here would make every row lie after
 * a deploy; this paragraph is what stops the next reader adding it.
 *
 * ── NOT A FAILURE, AND NOT A DISABLE ──────────────────────────────────────────────────────
 *
 * A mailbox carrying one of these is `status='connected'`, has no `error_code`, and has earned no
 * retry backoff — an infrastructure fault must never quarantine a mailbox. It is simply not being
 * synced right now, and this column is the only place that says so. Every writer that moves the
 * mailbox to a state where the statement is no longer true clears it in the SAME statement:
 * `markMailboxConnected`, `markMailboxStoodDown`, `markMailboxFailed` (all in the worker) and
 * `MailboxService.update`.
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
 * Every value `mailboxes.smtp_size_probe_code` may hold. CLOSED, with a CHECK, on
 * {@link MAILBOX_SYNC_BLOCK_REASONS}' argument rather than {@link MAILBOX_ERROR_CODES}' — and the
 * distinction is the whole reason this comment is long, because the first reading of this set is
 * that it is a failure taxonomy and therefore ought to be open.
 *
 * It is not. Every member is a branch WE wrote:
 *
 *  · `learned` / `silent` — the dial completed, and the EHLO either named a usable ceiling or did
 *    not. Two states of our own reading of RFC 1870, not of anybody's error vocabulary.
 *  · `auth_refused` / `unreachable` / `tls_refused` / `unknown` — `SmtpSizeFailure` in
 *    `packages/core`, which is derived from nodemailer's own `code` field through a closed switch
 *    with `unknown` as its default. A provider that invents a new response line cannot add a member
 *    here: it lands in `unknown`. Only a new branch in OUR classifier can, and that is a code
 *    change the migration rides along with.
 *  · `token_unavailable` — an oauth mailbox for which no access token could be minted, so no dial
 *    happened.
 *  · `no_credentials` — nothing to dial with at all: no `imap` row, an `authType` this build
 *    refuses, or a credential envelope this deployment cannot decrypt.
 *
 * ── WHY THE CHECK IS A PRIVACY BOUNDARY AND NOT TIDINESS ────────────────────────────────────
 *
 * The value this column records is derived from an SMTP AUTH failure, and nodemailer's error text
 * for one embeds the server's own response line — which routinely contains the username, can
 * contain an echoed credential, and is written by a third party. The entire `code`-not-message rule
 * in `SmtpSizeFailure` exists for that reason, and the CHECK is the half of it that survives a call
 * site nobody has written yet: `error_detail` had exactly one guard at the write site and a server's
 * bracket atom walked straight through it into a column an operator reads. This column starts closed
 * at both ends.
 *
 * TEXT with a CHECK rather than a Postgres enum, on the whole repository's rule: a set member is
 * added by a migration that lands with the code, and `ALTER TYPE` is not a thing to do to a live
 * database when `ALTER TABLE … ADD CONSTRAINT` says the same thing.
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
