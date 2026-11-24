import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { folderState, mailboxes, messages, passProgress } from "./schema-mail.js";
import { mailboxPass, readPassProgress, updatePassProgress, writePassProgress } from "./pass-progress.js";
import type { Tx } from "./change-log.js";

/**
 * The one-time quarantine to Junk sweep's candidate predicate — stated ONCE, because two programs
 * count the same rows and must agree: the API's preview (`GET /screener/junk/sweep`, what a press
 * would move) and the worker's pass (`junkSweepPass`, what it then moves); two copies would drift
 * in the direction that shows on screen — an offer naming a number the sweep never reaches. A
 * candidate is physically in the pre-native spam pile (`native_locator ->> 'folder'`), alive in
 * the mirror (not tombstoned), and still DESIRED there (`folder_state.desired_folder`) — the
 * user-always-wins rule: a member the user has since moved is the reconciler's, not the sweep's.
 * Callers JOIN `folder_state` on `messages.id` and apply this WHERE — the join is theirs.
 */
export const JUNK_SWEEP_SOURCE_PILE = "ohmail/Quarantine";

export function junkSweepCandidateWhere(accountId: string, mailboxId: string): SQL {
  return and(
    eq(messages.mailboxId, mailboxId),
    eq(messages.accountId, accountId),
    isNull(messages.deletedAt),
    sql`${messages.nativeLocator} ->> 'folder' = ${JUNK_SWEEP_SOURCE_PILE}`,
    eq(folderState.desiredFolder, JUNK_SWEEP_SOURCE_PILE),
  )!;
}

/**
 * The old request has no confirmed IDs. Retire its stamp and record the need for confirmation
 * in the existing pass row, in the caller's transaction. An exact-set command can coexist with
 * the notice during a rolling upgrade. Retiring the stamp leaves that command intact.
 */
export async function retireLegacyJunkSweep(
  tx: Tx, accountId: string, mailboxId: string, requestedAt: Date,
): Promise<boolean> {
  const retired = await tx.update(mailboxes).set({ junkSweepRequestedAt: null })
    .where(and(eq(mailboxes.accountId, accountId), eq(mailboxes.id, mailboxId),
      eq(mailboxes.junkSweepRequestedAt, requestedAt)))
    .returning({ id: mailboxes.id });
  if (retired.length === 0) return false;
  await writePassProgress(tx, mailboxPass("junk_sweep", accountId, mailboxId), {
    doneAt: requestedAt,
  });
  return true;
}

/** The current account-wide preview has been confirmed; retire the notice it replaced. */
export function clearLegacyJunkSweepNotice(
  tx: Tx, accountId: string, mailboxId: string, noticedAt: Date,
): Promise<boolean> {
  return updatePassProgress(tx, mailboxPass("junk_sweep", accountId, mailboxId),
    { doneAt: null }, { when: eq(passProgress.doneAt, noticedAt) });
}

export interface JunkSweepCommand {
  id: string;
  folder: string;
  ids: readonly string[];
}

/** The pass progress row holds this mailbox's confirmed request until its organizer retires it. */
export function queueJunkSweep(
  db: Tx, accountId: string, mailboxId: string, command: JunkSweepCommand, at: Date,
): Promise<boolean> {
  return writePassProgress(db, mailboxPass("junk_sweep", accountId, mailboxId), {
    requestedAt: at, startedAt: null, doneAt: null, cursor: JSON.stringify(command),
  }, { when: isNull(passProgress.requestedAt), now: at });
}

export async function readJunkSweepCommand(db: Tx, accountId: string, mailboxId: string) {
  const marks = await readPassProgress(db, mailboxPass("junk_sweep", accountId, mailboxId));
  if (marks.requestedAt === null || marks.cursor === null) return null;
  try {
    const command = JSON.parse(marks.cursor) as Partial<JunkSweepCommand> | null;
    if (!command || typeof command.id !== "string" || typeof command.folder !== "string"
      || !Array.isArray(command.ids) || !command.ids.length || command.ids.some((id: unknown) =>
        typeof id !== "string" || id.length !== 36 || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id))) return null;
    return { id: command.id, folder: command.folder, ids: command.ids, cursor: marks.cursor };
  } catch {
    return null;
  }
}

export function clearJunkSweepCommand(
  db: Tx, accountId: string, mailboxId: string, cursor: string,
): Promise<boolean> {
  return updatePassProgress(db, mailboxPass("junk_sweep", accountId, mailboxId),
    { requestedAt: null, cursor: null }, { when: eq(passProgress.cursor, cursor) });
}
