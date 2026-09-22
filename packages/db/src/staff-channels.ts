import { MAILBOX_ERROR_CODES, isMailboxErrorCode } from "./mailbox-errors.js";
import {
  CONNECT_ERRNOS, TIMEOUT_ERRNOS, STORAGE_SQLSTATES, SQLSTATE_DETAILS,
  MAILBOX_ERROR_DETAIL_TOKENS, isSafeMailboxErrorDetail,
} from "./mailbox-error-detail.js";

/**
 * THE STAFF-VISIBLE CHANNELS, AND THE CLOSED SET EACH ONE MAY SAY.
 *
 * A staff surface never renders a customer's own content. That was held by write-site
 * allowlists alone. An allowlist is a claim about every writer, past and future; the console's
 * own comments said so out loud ("the redaction is at the WRITE, so this projection does not have
 * to remember to be narrow"). That is the argument this file refuses: the projection now asks,
 * about the one value in its hand, whether it is a word this codebase chose, and renders
 * {@link STAFF_CHANNEL_OTHER} when it is not. A row planted by any route — a migration, a support
 * script, a writer nobody censused, a restored backup — reaches the staff DTO as `other`.
 *
 * Each set is DERIVED FROM THE CHANNEL'S OWN WRITERS and then pinned by
 * `staff-channels.test.ts`, which reads the writers back out of the tree. Widening a set is an
 * edit here plus a writer; neither alone moves.
 *
 * The billing channel's source suffixes are the fourth channel the gap row named and they are
 * NOT here: credits are billing, billing is the private plane, and the public repo carries no
 * such table to constrain. The channel is listed in `changes/fix-018-admin-freetext.md`
 * as the plane's to close.
 */
export interface StaffChannel {
  /** `<table>.<column>`, or `<dto>.<field>` for a channel composed rather than stored. */
  readonly channel: string;
  /** The members, from the ONE constant that defines them; never a second copy. */
  readonly members: readonly string[];
  /** The membership test, from the same module as the members. */
  readonly isMember: (v: unknown) => boolean;
  /** Whether the channel may be absent — NOT NULL on the column, or required in the DTO. */
  readonly nullable: boolean;
  /** What a value outside the set means here, and why the set is closed at these words. */
  readonly why: string;
}

/**
 * The word a staff surface renders in place of a value no writer in this tree chose.
 *
 * Not `unknown`: `mailboxes.error_code` HAS a member spelled `unknown` — a classified failure we
 * could not name — and an operator has to be able to tell "we classified this and came up empty"
 * from "this column holds something we did not write". Not the empty string either: a blank cell
 * reads as "no failure".
 */
export const STAFF_CHANNEL_OTHER = "other";

/**
 * `packages/db/src/client.ts#DbAcquireTimeoutError.code`, spelled rather than imported — that
 * module pulls in postgres.js and this one is a leaf every consumer of the barrel loads.
 * `staff-channels.test.ts` constructs the real error and compares, so the two cannot drift.
 */
export const DB_ACQUIRE_TIMEOUT_CODE = "db_acquire_timeout";

/**
 * `ApiHealth.errorCode` / `errorDetail` — the ONE channel in this registry whose value is
 * composed at runtime today rather than chosen from a literal. `health.ts` reads `err.code` off
 * whatever the database handle threw and the console prints it under the red banner, so the
 * writer is the driver and, one hop further out, the host. The set is the driver vocabulary this
 * codebase already names for the same errors, plus our own acquire timeout.
 */
export const API_HEALTH_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  ...CONNECT_ERRNOS, ...TIMEOUT_ERRNOS, ...STORAGE_SQLSTATES, ...SQLSTATE_DETAILS,
  DB_ACQUIRE_TIMEOUT_CODE,
]);

/** Is this a value `ApiHealth.errorCode` is allowed to carry to a staff screen? */
export function isApiHealthErrorCode(v: unknown): v is string {
  return typeof v === "string" && API_HEALTH_ERROR_CODES.has(v);
}

/**
 * Every value `audit_log.action` may hold — one entry per WRITE SITE in this tree, derived by
 * reading them and pinned by `staff-channels.test.ts`, which fails when a writer spells an action
 * this list does not carry.
 *
 * The staff console reads this column through `admin.audit_log`, a view whose predicate is
 * `action LIKE 'admin.%'`, so only the `admin.` entries can reach a staff screen — but the door
 * is over the WHOLE column, because the predicate is a filter and not a constraint: a row written
 * with an `admin.`-prefixed action nobody wrote is exactly the row it would carry through.
 */
export const AUDIT_LOG_ACTIONS: readonly string[] = [
  /* ── staff writes: the `admin.` namespace, the ONLY half the console's view projects ──────
     Derived by scanning for `action: "admin.…"` across the console and the services — NOT from
     the INSERTs, because only `admin.mailbox.resync` has a writer in this tree. The rest are
     declared by the console's action catalog and written by the plane, and the staff view reads
     them all: `staff-role.pg.test.ts` seeds `admin.account.suspend` against a real database and
     reads it back through the blind role. A set derived from this tree's INSERTs alone would
     have rendered a real staff action as `other`, which is how that test found it.
     `admin.credits.adjust` is the staff ACT, not a ledger row — the ledger table itself is
     the plane's and is not a channel here. */
  "admin.mailbox.resync", "admin.account.suspend", "admin.account.resume", "admin.send.retry",
  "admin.credits.adjust", "admin.oauth.microsoft.save",
  // ── the routing pipeline (`packages/core/src/pipeline.ts`) ───────────────────────────────
  "move", "move_deferred", "move_superseded", "adopt_external", "adopt_superseded",
  // ── the worker's reconcile passes (`apps/worker/src/sync.ts`, `junk-*.ts`) ───────────────
  "reconcile.move", "reconcile.move.superseded", "reconcile.move.voided", "reconcile.move.failed",
  "reconcile.flags", "reconcile.flags.retired", "reconcile.flags.no_locator",
  "reconcile.flags.voided", "reconcile.flags.failed",
  "sync.message_skipped", "sweep.junk_filed",
  // ── the worker's own passes ──────────────────────────────────────────────────────────────
  "ohbox_tidy_move", "redacted_body_restore", "rule_retro_move", "screener_auto_apply_move",
  "sensitive_fp_backfill",
  // ── services-side passes and migrations ──────────────────────────────────────────────────
  "sensitive_rescreen", "sensitive_rescreen_move",
  "attachment_flag_backfill", "attachment_flag_backfill_row",
  "hey_migrate", "undo_hey_migration",
  // ── account settings and the organizer profile import (`packages/db`) ────────────────────
  "account.ai_enabled", "organizer_profile_found", "organizer_profile_import_resolved",
  // ── the AI workflow runner's per-step inverse row ────────────────────────────────────────
  "workflow_step",
  // ── the Screener's held-release press (`packages/services/src/held-release-service.ts`) ───
  "screener.held_release",
  // ── the Screener's undecided-sender press (`packages/services/src/ohbox-unscreened-service.ts`) ─
  "screener.unscreened_sweep",
];

const AUDIT_LOG_ACTION_SET: ReadonlySet<string> = new Set(AUDIT_LOG_ACTIONS);

/** Is this a value `audit_log.action` is allowed to hold? */
export function isAuditLogAction(v: unknown): v is string {
  return typeof v === "string" && AUDIT_LOG_ACTION_SET.has(v);
}

export const STAFF_CHANNELS: readonly StaffChannel[] = [
  {
    channel: "mailboxes.error_code",
    nullable: true,
    members: MAILBOX_ERROR_CODES,
    isMember: isMailboxErrorCode,
    why: "the failure taxonomy, seven words the classifier chooses between. TEXT at rest with no "
      + "CHECK behind it, so the compiler is the only thing standing between a cast and the "
      + "column — and a cast is not a constraint.",
  },
  {
    channel: "mailboxes.error_detail",
    nullable: true,
    members: [...MAILBOX_ERROR_DETAIL_TOKENS],
    isMember: isSafeMailboxErrorDetail,
    why: "protocol constants only — an IMAP response code, an imapflow code, a TLS constant, a "
      + "Node errno, an SQLSTATE. The one channel here a MAIL SERVER can aim at: imapflow builds "
      + "`serverResponseCode` from the server's own bracket atom, so membership, never shape.",
  },
  {
    channel: "audit_log.action",
    nullable: false,
    members: AUDIT_LOG_ACTIONS,
    isMember: isAuditLogAction,
    why: "one word per write site in this tree. `WorkerRepo.recordAudit` takes `action: string`, "
      + "so the type system stops nothing — this is the refusal.",
  },
  {
    channel: "api_health.error_code",
    nullable: true,
    members: [...API_HEALTH_ERROR_CODES],
    isMember: isApiHealthErrorCode,
    why: "the database driver's own code for a probe that did not complete, plus our acquire "
      + "timeout. Composed at runtime from a thrown value, which is why it is in this registry.",
  },
];

/** The channel a name identifies; an unknown name is a bug, never a default. */
export function staffChannel(channel: string): StaffChannel {
  const found = STAFF_CHANNELS.find((c) => c.channel === channel);
  if (found === undefined) {
    throw new Error(
      `${channel} is not a staff channel this registry knows. A free-text column a staff surface `
      + "renders belongs here with its set, or the read-side rule says nothing about it.",
    );
  }
  return found;
}

/** What a write door throws for a value the channel's set does not hold. Named, so a log can say which. */
export class StaffChannelViolation extends Error {
  readonly code = "staff_channel_violation";
  constructor(readonly channel: StaffChannel, readonly value: unknown) {
    super(
      `${channel.channel} is a closed set and ${JSON.stringify(value)} is not a member`,
    );
    this.name = "StaffChannelViolation";
  }
}

/**
 * THE WRITE DOOR. Every writer that does not hand the column a literal of the column's own type
 * passes through here, and a value outside the set is REFUSED rather than coerced.
 *
 * Refusal, not coercion, because every caller of this door is writing a word IT chose: a throw
 * means this codebase tried to store something it has no name for, which is a defect in the
 * caller and not a fact about the mailbox. The one channel that coerces instead is
 * `mailboxes.error_detail`, whose candidate comes off a hostile wire — see `markMailboxFailed`,
 * which drops an unrecognised detail to NULL so a mail server cannot fail a quarantine write by
 * answering with a word we do not know.
 */
export function staffChannelValue(channel: string, value: unknown): string | null {
  const c = staffChannel(channel);
  if (value === null || value === undefined) {
    if (c.nullable) return null;
    throw new StaffChannelViolation(c, value);
  }
  if (!c.isMember(value)) throw new StaffChannelViolation(c, value);
  return value as string;
}

/**
 * THE READ SIDE. What a staff surface may render for a value read out of the channel: the member,
 * or {@link STAFF_CHANNEL_OTHER}. The raw value is never returned and so never reaches the DTO.
 *
 * This is the half the write-site allowlists could not supply. `null` in is `null` out — "not
 * recorded" is a state, and `other` would claim a value exists.
 */
export function staffChannelWord(channel: string, value: unknown): string | null {
  const c = staffChannel(channel);
  if (value === null || value === undefined) return null;
  return c.isMember(value) ? (value as string) : STAFF_CHANNEL_OTHER;
}

/**
 * `audit_log.action` is NOT NULL, so its door answers a `string` rather than `string | null` —
 * the one call shape drizzle's insert types will accept. Every audit writer goes through it.
 */
export function auditAction(action: unknown): string {
  return staffChannelValue("audit_log.action", action) as string;
}
