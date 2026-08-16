import { and, eq, sql } from "drizzle-orm";
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
  /** The mailbox address, as the install knows it. Matched case-insensitively. */
  address: string;
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
  const [row] = await db
    .select({
      id: mailboxes.id,
      status: mailboxes.status,
      disabledReason: mailboxes.disabledReason,
    })
    .from(mailboxes)
    .where(sql`lower(${mailboxes.address}) = ${input.address.toLowerCase()}`)
    .orderBy(sql`(${mailboxes.status} <> 'disabled') desc`)
    .limit(1);

  if (!row) return { outcome: "no_mailbox", previousReason: null, mailboxId: null };
  if (row.status !== "disabled") {
    return { outcome: "already_organizing", previousReason: null, mailboxId: row.id };
  }
  if (!row.disabledReason) {
    // Disabled with no reason is a removal, not a pause. Re-adding a removed mailbox is a
    // different action with different consequences, and quietly converting one into the other
    // here would resurrect a mailbox the user deliberately took off this machine.
    return { outcome: "removed", previousReason: null, mailboxId: row.id };
  }

  // Status, reason and stamp in ONE write. Any two of the three applied without the third leaves
  // a row that means something the user did not ask for — see the header.
  await db
    .update(mailboxes)
    .set({ status: "connected", disabledReason: null, takeoverAuthorizedAt: input.now })
    .where(and(eq(mailboxes.id, row.id), eq(mailboxes.status, "disabled")));

  return { outcome: "authorized", previousReason: row.disabledReason, mailboxId: row.id };
}

/** What the command says for each outcome. One line each; nothing needs a paragraph. */
export const TAKEOVER_MESSAGES: Record<TakeoverAuthorizationOutcome, string> = {
  authorized:
    "Authorized. Start ohmail to organize this mailbox from this machine. " +
    "If another organizer is still active, it keeps the mailbox and this machine stands down again.",
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
