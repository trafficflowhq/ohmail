import {
  MessageGoneError, WriteDeclinedError, makeRef, type MailboxAdapter,
} from "@trafficflow/core/adapters/imap";
import type { Logger } from "@trafficflow/core/mail";
import type { PendingJunkRescue, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { LeaseUnavailableError } from "@trafficflow/core/adapters/organizer-lease";
import { MailboxErasedError } from "@trafficflow/db";
import {
  assertMayWriteToMailbox, OrganizerStandDownError, writeDoorOf, type MailboxWriteAuthority,
} from "./lease.js";
import {
  RECONCILE_BACKOFF_MINUTES, classifyMoveRefusal, isTransportFailure, nextReconcileAttemptAfter,
} from "./reconcile-refusal.js";

/**
 * THE JUNK-RESCUE PASS — "Not junk", executed where organization belongs (FOLDERS-SPEC.md §16.2).
 * The API records the press (`junk_rescues`, mail 0117); this pass runs once per cycle per mailbox
 * at the top — before the cursor is built, so the same cycle's `changesSince` ingests the arrival
 * with its bytes — and moves the message, then DELETES the row. Driven from the REPO, never through
 * an injected port: the hosted worker, the desktop engine and the standalone phone all run this
 * file, which is what a queued command rendering "Will be moved to your inbox" requires of every
 * door that can record one. Per-message `move`, never `moveMany`: each press earns its own verdict.
 */

/** Rescues one cycle may attempt. A person presses these one at a time; the bound is for a backlog. */
export const JUNK_RESCUES_PER_CYCLE = 20;

/**
 * Refusals a row may collect before it is answered `refused` — {@link RECONCILE_BACKOFF_MINUTES}'s
 * length, so the schedule and the ceiling cannot drift apart: the ladder's last rung is the last
 * attempt. `folder_ops` reaches its own terminal state at the same count.
 */
export const JUNK_RESCUE_MAX_ATTEMPTS = RECONCILE_BACKOFF_MINUTES.length;

export interface JunkRescueDeps {
  repo: WorkerRepo;
  adapter: MailboxAdapter;
  accountId: string;
  mailboxId: string;
  /** The cycle's fenced group — every database write this pass makes rides it. */
  write: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T>;
  /**
   * WHAT AUTHORISES THE MOVE. An IMAP command cannot ride a database transaction, so the fenced
   * `write` says nothing about the ORGANIZER lease — which is what stops a desktop install
   * executing a queued rescue on a mailbox somebody else now organizes. REQUIRED, like the
   * folder-op pass's: a caller holding neither half says so in the object.
   */
  writeAuthority: MailboxWriteAuthority;
  log?: Logger;
  /** The instant the schedule is computed from — the application clock, matching every other deferral. */
  now?: () => Date;
}

export interface JunkRescueResult {
  moved: number;
  /** Rows resolved without a move: already gone, or the mailbox opted out of folders. */
  voided: number;
  deferred: number;
  refused: number;
  /** The per-cycle bound was reached with rows still pending — re-kick. */
  owesMore: boolean;
}

export async function junkRescuePass(deps: JunkRescueDeps): Promise<JunkRescueResult> {
  const { repo, adapter, accountId, mailboxId, log } = deps;
  const result: JunkRescueResult = { moved: 0, voided: 0, deferred: 0, refused: 0, owesMore: false };
  // One row over the budget, so "there is more" is a fact about the queue rather than a guess from
  // a full page — the reconciler's rule at this seam.
  const pending = await repo.listPendingJunkRescues(mailboxId, JUNK_RESCUES_PER_CYCLE + 1);
  if (pending.length === 0) return result;
  result.owesMore = pending.length > JUNK_RESCUES_PER_CYCLE;
  const work = result.owesMore ? pending.slice(0, JUNK_RESCUES_PER_CYCLE) : pending;

  for (const row of work) {
    if (row.foldersOff) {
      // Switched off under "Use folders" since the press (§17): an opted-out mailbox performs no
      // move. The command is dropped rather than deferred, so the window stops saying "queued".
      await deps.write((r) => r.resolveJunkRescue(row.id));
      result.voided += 1;
      log?.info("junk_rescue_dropped", {
        mailboxId, accountId,
        reason: "the mailbox was switched off under Use folders after the press; nothing moves",
      });
      continue;
    }
    try {
      await assertMayWriteToMailbox(deps.writeAuthority, "move");
      // "Use folders" read AT THIS PRESS, not with the listing: switched off mid-pass, the door
      // declines this move and the command is dropped below, as one already off at listing is.
      const foldersOff = (await repo.getMailbox(mailboxId))?.foldersOff === true;
      await adapter.move(
        { folder: row.folder, ref: makeRef(row.uidValidity, row.uid) }, "INBOX",
        writeDoorOf(deps.writeAuthority, { foldersOff }),
      );
      await deps.write((r) => r.resolveJunkRescue(row.id));
      result.moved += 1;
    } catch (err) {
      if (err instanceof WriteDeclinedError && err.reason === "folders_off") {
        await deps.write((r) => r.resolveJunkRescue(row.id));
        result.voided += 1;
        log?.info("junk_rescue_dropped", {
          mailboxId, accountId,
          reason: "the mailbox was switched off under Use folders during this pass; nothing moves",
        });
        continue;
      }
      if (isRefusal(err)) throw err;
      if (err instanceof MessageGoneError) {
        // The provider (or another client) took it first, or the folder was renumbered under the
        // epoch guard. Either way this coordinate names no message: the command is finished, not
        // failed. The live window IS the re-find — it restarts under the new epoch and the person
        // presses the fresh row — so nothing here searches for the message by Message-ID.
        await deps.write((r) => r.resolveJunkRescue(row.id));
        result.voided += 1;
        log?.info("junk_rescue_gone", { mailboxId, accountId, attempts: row.attempts });
        continue;
      }
      if (isTransportFailure(err)) {
        // An unreachable mail host is not this message's refusal: the row is left EXACTLY as it
        // was — due now, attempts unchanged — and drains the moment the host is back.
        log?.warn("junk_rescue_transport_failed", { mailboxId, accountId, err });
        continue;
      }
      const attempts = row.attempts + 1;
      const errorClass = classifyMoveRefusal(err);
      if (attempts >= JUNK_RESCUE_MAX_ATTEMPTS) {
        // The row STAYS, unlike every other ending here: somebody pressed a button and is owed the
        // answer. `refused` is what the window renders, and a fresh press resets the row.
        await deps.write((r) => r.refuseJunkRescue(row.id, attempts, errorClass));
        result.refused += 1;
        log?.warn("junk_rescue_refused", { mailboxId, accountId, attempts, errorClass, err });
      } else {
        await deps.write((r) => r.deferJunkRescue(
          row.id, attempts, nextReconcileAttemptAfter(attempts, (deps.now ?? (() => new Date()))()), errorClass,
        ));
        result.deferred += 1;
        log?.warn("junk_rescue_deferred", { mailboxId, accountId, attempts, errorClass, err });
      }
    }
  }
  return result;
}

/**
 * THE SIX CLASSES THAT ARE NOT THIS MESSAGE'S FAULT — `sync.ts#rethrowRefusal`'s set, asked here
 * because the per-row catch below would otherwise read a lost lease as a refused move and burn an
 * attempt off somebody's press. The two classes that live in `sync.ts` are matched by NAME, on
 * `folder-ops.ts`' reasoning: `sync.ts` imports this module and the import back would be a cycle.
 * The other four are imported, which is the stronger match, and the split is stated rather than
 * uniform so nobody "tidies" an importable class into a string.
 */
function isRefusal(err: unknown): boolean {
  if (err instanceof OrganizerStandDownError || err instanceof LeaseUnavailableError) return true;
  if (err instanceof WriteDeclinedError) return true;
  if (err instanceof MailboxErasedError) return true;
  return err instanceof Error
    && (err.name === "LeaderFencedError" || err.name === "MailboxRemovedError");
}
