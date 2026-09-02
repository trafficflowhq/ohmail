import { and, eq, ne, sql } from "drizzle-orm";
import { mailboxes } from "@trafficflow/db";
import { isCliEntry } from "@trafficflow/worker/entry";
import { openLocalDb, type LocalDb } from "./db.js";

/**
 * "ORGANIZE THIS MAILBOX FROM THIS MACHINE" — the one action that ends a stand-down.
 *
 * ── THE INVARIANT THIS SITS INSIDE ────────────────────────────────────────────────────────
 *
 * **Exactly one active organizer per mailbox, ever.** A mailbox may be organized by this
 * install, or by a hosted service, or by another machine of the user's — never by two at once,
 * because two organizers means two engines classifying the same new message and issuing
 * competing moves against one server.
 *
 * The mailbox itself carries the claim, in an unsubscribed `ohmail/_meta` folder, because it is
 * the only medium every organizer can read. Reading that claim is what makes an install stand
 * down. But standing down has to OUTLIVE the process, and the claim cannot express that: once
 * the other organizer releases, `ohmail/_meta` is empty, and an empty folder honestly reads as
 * "nobody has ever organized this mailbox" — which is the state that organizes. So the local
 * database records the stand-down on the mailbox row, and that record is what stops a relaunch
 * from silently resuming.
 *
 * ── WHY THAT NEEDS AN EXIT, AND WHY THE EXIT IS NOT JUST "CLEAR THE ROW" ──────────────────
 *
 * A record only a human can clear is correct, and it is also a dead end until something can
 * clear it. This function is that something.
 *
 * Clearing the reason is not sufficient on its own, for two independent reasons:
 *
 *  1. **A quiet claim is not an absent claim.** If the previous organizer stopped without
 *     releasing — a crashed machine, a laptop that never woke — its claim is still in
 *     `ohmail/_meta`, merely stale. The lease reports that mailbox as *available* and refuses to
 *     take it, because "nobody is renewing this" and "the user chose this machine" are different
 *     facts and only the second authorizes a takeover. Without the stamp written below, clearing
 *     the reason produces an install that stands down again on its very next cycle: an action
 *     that appears to do nothing, at exactly the moment somebody chose to use this machine.
 *  2. **A disabled row with no reason means something else entirely.** The reason column is what
 *     distinguishes a mailbox that is *paused* from a mailbox the user *removed*; a removal is a
 *     tombstone, and re-adding the address is deliberately allowed to create a new mailbox.
 *     Clearing only the reason turns a pause into a tombstone, and the next launch then mints a
 *     SECOND mailbox row for the same address, with none of the first one's history. So the
 *     status and the reason move together, in one write.
 *
 * ── AND WHY THE AUTHORIZATION IS ONE-SHOT ─────────────────────────────────────────────────
 *
 * The stamp authorizes one becoming, not a standing right. It is cleared the moment it is spent
 * (see the engine), and standing down clears it too. A permanent grant would mean an install
 * that is stood down today silently seizes the mailbox back months later — after a human has
 * deliberately moved it somewhere else — which is the failure the whole mechanism exists to
 * prevent, arriving by a different door.
 *
 * This is deliberately a separate command rather than a launch flag. An environment variable is
 * ambient: set it once in a launcher script and every restart re-authorizes, which is precisely
 * the automatic resumption that must not exist. An imperative action cannot be sticky.
 */

/** What {@link authorizeOrganizerTakeover} found, and therefore what it did. */
export type TakeoverAuthorizationOutcome =
  /** The mailbox was stood down. It is now clear to organize, and one takeover is authorized. */
  | "authorized"
  /** The mailbox is not stood down; this install already organizes it. Nothing was written. */
  | "already_organizing"
  /** The mailbox was REMOVED from this install, which is not a stand-down. Nothing was written. */
  | "removed"
  /** This install has no mailbox for that address at all. Nothing was written. */
  | "no_mailbox";

export interface TakeoverAuthorizationResult {
  outcome: TakeoverAuthorizationOutcome;
  /** The reason the mailbox was stood down, when it was. */
  previousReason: string | null;
  mailboxId: string | null;
}

export interface AuthorizeTakeoverInput {
  /**
   * WHICH MAILBOX — by address or by id, and exactly one of them.
   *
   * The CLI has only an address: it reads the same environment the engine does, and the mailbox
   * is named once there. The Settings pane has only an id, because it is looking at a row it
   * already fetched — and an address would be strictly worse there, since the pane folds two
   * rows for one address (a live one and a superseded tombstone) and the address alone cannot
   * say which of them the person pressed. The address arm keeps its ordering rule for the same
   * reason; the id arm needs none.
   */
  address?: string;
  mailboxId?: string;
  now: Date;
}

/**
 * Record that a human has asked this install to organize this mailbox.
 *
 * Writes nothing unless there is a stand-down to end, so running it twice is harmless and
 * running it on a healthy mailbox is a no-op rather than a fresh authorization left lying around.
 *
 * It does NOT decide whether the takeover succeeds. The mailbox is still the authority: on the
 * next launch the lease is read first, and an organizer that is still actively renewing its claim
 * keeps the mailbox regardless of what was authorized here. That ordering is the point — this
 * grants permission to *ask*, never permission to *win*.
 */
export async function authorizeOrganizerTakeover(
  db: LocalDb,
  input: AuthorizeTakeoverInput,
): Promise<TakeoverAuthorizationResult> {
  if (!input.address && !input.mailboxId) {
    throw new Error("authorizeOrganizerTakeover: one of address or mailboxId is required");
  }
  const [row] = await db
    .select({
      id: mailboxes.id,
      status: mailboxes.status,
      disabledReason: mailboxes.disabledReason,
      // Mail 0083 — the precondition moved off `status`. A demoted install is now `connected`
      // with `organizer_role = 'reader'`, so a `status = 'disabled'` test matches nothing this
      // build writes; and a mailbox NOBODY has consented to organize is the second state this
      // ceremony serves, which `status` could never express at all.
      organizerRole: mailboxes.organizerRole,
      organizeConsentedAt: mailboxes.organizeConsentedAt,
    })
    .from(mailboxes)
    .where(input.mailboxId
      ? eq(mailboxes.id, input.mailboxId)
      : sql`lower(${mailboxes.address}) = ${input.address!.toLowerCase()}`)
    .orderBy(sql`(${mailboxes.status} <> 'disabled') desc`)
    .limit(1);

  if (!row) return { outcome: "no_mailbox", previousReason: null, mailboxId: null };
  // A tombstone is checked FIRST (mail 0083). A removed mailbox keeps whatever role it had — a
  // removal demotes nothing, it retires the row — so asking about the role first would answer
  // `already_organizing` about a mailbox the person deleted. Re-adding it is a different action
  // with different consequences, and quietly converting one into the other here would resurrect a
  // mailbox somebody deliberately took off this machine.
  if (row.status === "disabled") {
    return { outcome: "removed", previousReason: null, mailboxId: row.id };
  }
  // Already the organizer AND already consented ⇒ nothing to ask for. Both terms: a mailbox that
  // is nominally an organizer but has never been consented to is exactly the FIRST-consent case
  // this ceremony now serves, and refusing it here would leave that case with no door.
  if (row.organizerRole !== "reader" && row.organizeConsentedAt !== null) {
    return { outcome: "already_organizing", previousReason: null, mailboxId: row.id };
  }

  // CONSENT AND STAMP IN ONE WRITE — and the role is deliberately NOT among them. The GATE
  // promotes: the next launch reads `ohmail/_meta` and decides, and an organizer that is still
  // renewing keeps the mailbox whatever was asked here. Flipping the role from a CLI would be a
  // command line deciding who organizes a mailbox with no reference to the mailbox itself.
  //
  // `coalesce` on the consent so a re-run does not move the record of when the person first
  // agreed; the stamp is unconditional because it authorizes THIS becoming.
  await db
    .update(mailboxes)
    .set({
      disabledReason: null,
      // `.toISOString()` plus the cast: a bare `Date` inside a raw `sql` fragment has no column
      // type to coerce against, and postgres-js binds it as TEXT and throws. This store is PGlite,
      // which accepts it — so the guard here is inherited from the hosted door rather than
      // observed on this one, and it is spelled the same way on purpose.
      organizeConsentedAt: sql`coalesce(${mailboxes.organizeConsentedAt}, ${input.now.toISOString()}::timestamptz)`,
      takeoverAuthorizedAt: input.now,
    })
    .where(and(eq(mailboxes.id, row.id), ne(mailboxes.status, "disabled")));

  return { outcome: "authorized", previousReason: row.disabledReason, mailboxId: row.id };
}

/**
 * THE SAME REQUEST, MADE WHILE THE ENGINE IS RUNNING — the Settings action's half.
 *
 * ── WHY IT CANNOT BE {@link authorizeOrganizerTakeover} ───────────────────────────────────
 *
 * That function moves status, reason and the stamp together, and its header explains why: any
 * two without the third leave a row meaning something the user did not ask for. That is right
 * FOR THE CLI, which "needs the database to itself — stop ohmail, run this, start ohmail". The
 * engine is not running when it lands, so the row goes from `disabled` to `connected` and the
 * next process to read it is the one that also reads the lease.
 *
 * From a button it is wrong, and the window is the reason. This process keeps serving after the
 * press: it is stood down, `stopped` is set, the poll timer is cleared and the IMAP login is
 * closed, and none of that can be undone from a request handler without restarting a poll loop
 * beside a queue already told this install organizes nothing. So a row flipped to `connected`
 * here would advertise a mailbox that nothing is organizing — the mailbox strip would stop
 * saying "not organized here", and `ScheduleService` and `SendService` (which refuse on
 * `status = 'disabled'` and on nothing else) would start accepting work for it. The row would be
 * making a claim about this install that is not true until the next launch.
 *
 * ── SO THE STAMP TRAVELS ALONE, AND THE ENGINE SPENDS IT AT ASSEMBLY ──────────────────────
 *
 * `takeover_authorized_at` alone means exactly what the press means: a human asked for this
 * machine, once. The row stays `disabled` with its reason, so every surface goes on telling the
 * truth and no send or schedule is accepted, and the ENGINE clears the stand-down on its next
 * launch — before it reads the lease, which is the CLI's timing exactly, with no process serving
 * in between. The lease is still the authority: an organizer that is still renewing keeps the
 * mailbox and this install stands down again, which also voids the stamp.
 *
 * Idempotent, and writes nothing unless there is a stand-down to end — so a second press is not
 * a second becoming, and a press on a healthy or removed mailbox is a no-op that says so.
 */
export async function requestOrganizerTakeover(
  db: LocalDb,
  input: { mailboxId: string; now: Date },
): Promise<TakeoverAuthorizationResult> {
  const [row] = await db
    .select({
      id: mailboxes.id,
      status: mailboxes.status,
      disabledReason: mailboxes.disabledReason,
      // Mail 0083 — the precondition moved off `status`. A demoted install is now `connected`
      // with `organizer_role = 'reader'`, so a `status = 'disabled'` test matches nothing this
      // build writes; and a mailbox NOBODY has consented to organize is the second state this
      // ceremony serves, which `status` could never express at all.
      organizerRole: mailboxes.organizerRole,
      organizeConsentedAt: mailboxes.organizeConsentedAt,
    })
    .from(mailboxes)
    .where(eq(mailboxes.id, input.mailboxId))
    .limit(1);

  if (!row) return { outcome: "no_mailbox", previousReason: null, mailboxId: null };
  // The tombstone first, then the role — see the CLI arm above for why that order.
  if (row.status === "disabled") {
    return { outcome: "removed", previousReason: null, mailboxId: row.id };
  }
  if (row.organizerRole !== "reader" && row.organizeConsentedAt !== null) {
    return { outcome: "already_organizing", previousReason: null, mailboxId: row.id };
  }

  await db
    .update(mailboxes)
    .set({
      // `.toISOString()` plus the cast: a bare `Date` inside a raw `sql` fragment has no column
      // type to coerce against, and postgres-js binds it as TEXT and throws. This store is PGlite,
      // which accepts it — so the guard here is inherited from the hosted door rather than
      // observed on this one, and it is spelled the same way on purpose.
      organizeConsentedAt: sql`coalesce(${mailboxes.organizeConsentedAt}, ${input.now.toISOString()}::timestamptz)`,
      takeoverAuthorizedAt: input.now,
    })
    .where(and(eq(mailboxes.id, row.id), ne(mailboxes.status, "disabled")));

  return { outcome: "authorized", previousReason: row.disabledReason, mailboxId: row.id };
}

/** What the command says for each outcome. One line each; nothing needs a paragraph. */
export const TAKEOVER_MESSAGES: Record<TakeoverAuthorizationOutcome, string> = {
  authorized:
    "Authorized. This machine organizes this mailbox on its next pass — no restart. " +
    "If another organizer is still active, it keeps the mailbox and this machine goes on reading it.",
  already_organizing: "This machine already organizes that mailbox. Nothing to do.",
  removed: "That mailbox was removed from this machine. Add it again rather than authorizing a takeover.",
  no_mailbox: "This machine has no mailbox for that address.",
};

/**
 * The command.
 *
 *   node dist/organize-here.js
 *
 * Reads the same environment the engine does, so the mailbox is named exactly once. It needs the
 * database to itself: the engine holds an exclusive lock on the data directory while it runs, and
 * two processes on one local database corrupt it. Stop ohmail, run this, start ohmail.
 */
export async function runOrganizeHere(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const dataDir = env.OHMAIL_DATA_DIR;
  const address = env.OHMAIL_MAILBOX_ADDRESS ?? env.OHMAIL_IMAP_USER;
  if (!dataDir || !address) {
    process.stderr.write(
      "OHMAIL_DATA_DIR and one of OHMAIL_MAILBOX_ADDRESS or OHMAIL_IMAP_USER are required.\n",
    );
    return 2;
  }

  const opened = await openLocalDb(dataDir);
  try {
    const result = await authorizeOrganizerTakeover(opened.db, { address, now: new Date() });
    process.stdout.write(`${TAKEOVER_MESSAGES[result.outcome]}\n`);
    return result.outcome === "authorized" ? 0 : 1;
  } finally {
    await opened.close();
  }
}

if (isCliEntry(import.meta.url)) {
  void runOrganizeHere().then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
