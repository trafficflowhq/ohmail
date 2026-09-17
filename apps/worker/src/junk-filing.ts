/**
 * WHERE A FILING PHYSICALLY LANDS — the spam verdict's native-`\Junk` mapping and its completion. The
 * product rule (`packages/core/src/adapters/imap-types.ts`, the 2026-08-22 amendment) allows three
 * USER-COMMANDED writes: spam → native `\Junk`, not-junk → INBOX, delete → native `\Trash`. The PILE and
 * PLACE are two facts: `desired_folder` stays `ohmail/Quarantine` while the message rides to Junk, so
 * completion writes `observed_folder = <junk path>` with `satisfiedBy` (the shape `reconcileStatusFor`
 * accepts) and PARKS the locator (`forgetInstanceAt`) so a user RESTORE is adopted via
 * `primaryInstanceVanished`, `native_locator` kept as last known place. The claim follows the move
 * ({@link completeFiling} after `adapter.move`), through {@link WorkerRepo.completeFolderState} (never
 * `upsertFolderState`); with `physicalObservation: true` it records `observed_folder` even on a miss (`reconcile.move.superseded`), keeping the reaper (`tombstoneInstanceless`) from a false victim. */

import type {
  WorkerRepo, PendingFolderState, FolderCompletion,
} from "@trafficflow/core/adapters/drizzle-repo";

/** One native locator, as the adapter mints it. Structural, to keep this module's imports flat. */
interface Locator { folder: string; ref: string }

/**
 * The spam pile — `ohmail/Quarantine` as `packages/services`' `NO_FOLDER` tables spell it.
 * A literal here rather than an import from services: the worker may not depend on the API's
 * service layer, and the folder name is frozen by `WATCHED_FOLDERS`' own contract.
 */
export const SPAM_PILE = "ohmail/Quarantine";

/** How many instanceless rows one cycle's reaper pass may tombstone. The ingest batch's number. */
export const TOMBSTONE_MAX_PER_CYCLE = 200;

/**
 * The mailbox's discovered special folders, as `getMailboxSpecialFolders` answers them — plus
 * the adapter's resolved \Sent path, which the delete completion's survivor branch reads.
 * `sentFolder` comes from the ADAPTER (`ImapCapabilities.sentFolder`), not the repo discovery:
 * only the connected adapter knows which folder its watermark enumeration governs, and `null`
 * (a fake, a repo-only caller like the sweep) simply disables the Sent exclusion.
 */
export interface SpecialFolderMap {
  junkFolder: string | null; trashFolder: string | null; sentFolder: string | null;
}

/** The neither-exists map — what a repo without the discovery methods answers. */
export const NO_SPECIAL_FOLDERS: SpecialFolderMap = { junkFolder: null, trashFolder: null, sentFolder: null };

/**
 * Load the map once per reconcile pass. Absence of the method — a fake, an older repo — reads
 * as "neither exists": the verdict falls back to Quarantine and a delete cannot have been
 * accepted by the API in the first place (it refuses up front on a NULL `trash_folder`).
 * `sentFolder` is null here — the reconciler overlays the adapter's answer where it has one.
 */
export async function specialFoldersOf(repo: WorkerRepo, mailboxId: string): Promise<SpecialFolderMap> {
  if (typeof repo.getMailboxSpecialFolders !== "function") return NO_SPECIAL_FOLDERS;
  return { ...(await repo.getMailboxSpecialFolders(mailboxId)), sentFolder: null };
}

/**
 * Where a pending row's move PHYSICALLY goes.
 *
 * Exactly one mapping exists: a desire for the spam pile files into the provider's Junk when
 * the mailbox has one. Every other destination — INBOX, the ohmail folders, the Trash path a
 * delete wrote verbatim — is already physical. A mailbox with no Junk folder keeps the prior
 * behaviour byte-for-byte (the move goes to `ohmail/Quarantine` itself), and the caller records
 * the closed code `no_junk_folder` on the audit row so the fallback is a fact somebody can
 * select rather than an absence.
 */
export function physicalDestination(
  desiredFolder: string, special: SpecialFolderMap, opts: { aiAuthored?: boolean } = {},
): string {
  // An AI AUTO-APPLIED placement is not a user-commanded write (the amended rule's boundary),
  // so it keeps the pre-0065 destination — the pile itself. See the reconciler's exclusion set.
  if (desiredFolder === SPAM_PILE && special.junkFolder !== null && opts.aiAuthored !== true) {
    return special.junkFolder;
  }
  return desiredFolder;
}

/** Is this completion one of the two that leave watched space? (Junk filing, or a delete.) */
function parksLocator(p: PendingFolderState, physical: string, special: SpecialFolderMap): boolean {
  if (p.desiredFolder === SPAM_PILE && physical !== SPAM_PILE) return true;
  return special.trashFolder !== null && p.desiredFolder === special.trashFolder;
}

/**
 * The audit annotation for a spam-verdict move — `filed_to_junk`, or the closed fallback code.
 * `null` for every move that is not a spam verdict, so ordinary audit payloads do not grow a
 * field that means nothing to them.
 */
export function junkAuditCode(
  desiredFolder: string, physical: string, special: SpecialFolderMap,
): "filed_to_junk" | "no_junk_folder" | "ai_authored" | null {
  if (desiredFolder !== SPAM_PILE) return null;
  if (special.junkFolder === null) return "no_junk_folder";
  // A spam-pile move that stayed on the pile while a junk folder exists is the provenance
  // exclusion: the placement was AI auto-applied, and only a user-commanded verdict may write
  // into the provider's Junk. Derived rather than passed — the combination is unreachable any
  // other way.
  return physical === special.junkFolder ? "filed_to_junk" : "ai_authored";
}

/**
 * THE ONE PLACE A COMPLETION TOUCHES `folder_state` — the physical-observation write plus the audit row a
 * superseded intent owes. Every arm of {@link completeFiling} goes through here so the witness cannot be
 * forgotten: `expectDesiredFolder` is always `p.desiredFolder`, the value the move was computed against.
 * `completeFolderState`, called with `physicalObservation: true`, writes `observed_folder` on every call
 * this module makes — matched witness or not — because a caller with a genuine landed move must not leave
 * `observed_folder` stale. A MISS is recorded as `reconcile.move.superseded`: the move landed and the
 * row's disposition now belongs to whatever set a newer desire, its `to` the PHYSICAL folder reached, so
 * the row stays a truthful record of where the message is and self-heals on the next cycle.
 */
async function settle(
  r: WorkerRepo,
  accountId: string,
  p: PendingFolderState,
  physical: string,
  c: Omit<FolderCompletion, "expectDesiredFolder">,
): Promise<boolean> {
  const matched = await r.completeFolderState(p.messageId, {
    ...c, expectDesiredFolder: p.desiredFolder,
    // TRUE, always, here and ONLY here: `settle` is called exclusively from `completeFiling`,
    // after `adapter.move`/`moveMany` returned a locator that landed — `physical` is the actual
    // destination the server just confirmed, never a stale echo. See
    // `FolderCompletion.physicalObservation`'s doc for why this must NOT be the default and why
    // the two callers in `sync.ts` (a status repair, a gone-message void) must not set it.
    physicalObservation: true,
  });
  if (matched) return true;
  await r.recordAudit(
    accountId,
    "reconcile.move.superseded",
    {
      messageId: p.messageId,
      // What this completion was computed against, and where the mail physically went — the pair
      // an operator needs to read the row without joining anything.
      filedAgainst: p.desiredFolder,
      to: physical,
      reason: "a newer desired folder was committed during the IMAP move (or the row was erased); " +
        "the physical location was recorded but this pass's own intent for the row did not win, " +
        "so the newer intent stands and converges on its own next cycle",
    },
    null,
  );
  return false;
}

/**
 * A MESSAGE WHOSE LANDED MOVE DID NOT GO TO TRASH IS NOT DELETED — the invariant, one place. A move this
 * pass watched land in a watched folder that is NOT the Trash path is positive evidence the message is
 * present, so a standing tombstone is the mirror describing a mailbox that does not exist. The defect:
 * restoring from Trash writes desired = origin and clears nothing, and the tombstone clear was reachable
 * only from `pipeline.ts`'s `adopt_external` arm (not its `move` arm) and the ARRIVAL clear (never reached
 * once the locator is repointed) — so a restore stayed `entity: null` in every mirror while the message
 * sat in the inbox. Here because this is the shared completion writer and already holds the special
 * folders; `parksLocator` is the structural negative control (a delete parks and never reaches here). The
 * `op: "update"` (rule 4/5 upsert) re-materializes the DTO, emitted ONLY when `clearDeletedOnAdopt` (`deleted_at IS NOT NULL`) changed a row, both writes in the caller's transaction; NOT for a superseded completion. */
async function unDeleteOnLandedMove(
  r: WorkerRepo, accountId: string, messageId: string,
): Promise<void> {
  const resurrected = (await r.clearDeletedOnAdopt?.(messageId)) === true;
  if (!resurrected) return;
  await r.recordChange({
    accountId, entityType: "message", entityId: messageId, op: "update", meta: null,
  });
}

/**
 * The completion write for one landed move — the ONE place the database learns a message reached its
 * destination, shared by `fileChunk`, `fileOne` and the explicitly-invoked sweep. Ordinary moves keep the
 * historical write byte-for-byte (locator repointed, folder_state converged); the two boundary-leaving
 * shapes add the park, the satisfied folder_state and (spam only) the `junk_filed` husk, which runs before
 * any later `change_log` write per the lock-order rule (`insertMessageBody` step 1). Returns TRUE when it
 * RE-OPENED the pending row (the delete-survivor branch): the pass has created more filing work, which
 * `reconcileFolders` folds into `owesMore` to re-kick the hosted worker and keep the sidecar drain going —
 * without it a two-copy delete's second move waits for the next poll.
 */
export async function completeFiling(
  r: WorkerRepo,
  accountId: string,
  mailboxId: string,
  p: PendingFolderState,
  newLoc: Locator,
  special: SpecialFolderMap,
): Promise<boolean> {
  const physical = newLoc.folder;
  await r.updateLocator(p.messageId, newLoc, p.nativeLocator ?? undefined);
  if (!parksLocator(p, physical, special)) {
    const claimed = await settle(r, accountId, p, physical, { observedFolder: p.desiredFolder, lastSetBy: "us" });
    /* THE MOVE DID NOT GO TO TRASH, SO THE MESSAGE IS NOT DELETED — see
       {@link unDeleteOnLandedMove} for the invariant and the measured defect it closes.
       GATED ON THE CLAIM, and the ungated form was a defect: a restore's move landing while a
       second tab re-deletes the row loses the CAS, and clearing `deleted_at` there erased the
       tombstone the newer delete had just written — no later completion re-stamps it, so the
       copy sat in Trash absent from the live mirror AND from the Trash list. A completion that
       lost its CAS writes nothing; the winner's own landing decides `deleted_at`. */
    /* AND ONLY WHEN THERE IS A TOMBSTONE TO CLEAR. The clear is conditional in SQL
       (`deleted_at IS NOT NULL`), so on an ordinary move it matched nothing and cost a round
       trip anyway — one per message of every first sync, which is what the ingest ratchet
       measures. `deletedAt` is the row this cycle already read; ABSENT still attempts, so a
       producer that does not report it keeps today's behaviour. */
    if (claimed && p.deletedAt !== null) await unDeleteOnLandedMove(r, accountId, p.messageId);
    return false;
  }
  // A SUPERSEDED SPAM COMPLETION MAY NOT PARK — parking it is how the message gets TOMBSTONED. The park
  // removes the last watched instance, correct for a filed spam verdict because the reaper
  // (`tombstoneInstanceless`) exempts exactly that shape (`reconciled` WHILE `desired <> observed`, the
  // signature only the `satisfiedBy` completion writes). A SUPERSEDED completion cannot write it (it must
  // not touch `desired_folder`), so parking leaves a message with no instance, no tombstone
  // (`deleted_at IS NULL`) and no exemption — the reaper's victim (`ruleRetroPass` and friends store
  // `desired === observed`/`reconciled`, un-exempt and absent from `listPendingFolderStates`). Hence CLAIM
  // FIRST, PARK SECOND on the spam path. The DELETE park keeps the old order: the API already tombstoned
  // that row, and the reaper's first filter is `deleted_at IS NULL`, so a delete park is unreachable by it.
  const spamPark = p.desiredFolder === SPAM_PILE && physical !== SPAM_PILE;
  if (spamPark) {
    const claimed = await settle(r, accountId, p, physical, {
      observedFolder: physical, lastSetBy: "us", satisfiedBy: physical,
    });
    if (!claimed) return false;
    await r.forgetInstanceAt(mailboxId, newLoc);
    if (typeof r.huskBody === "function") {
      // The verdict's mirror semantics: the durable artifact of a spam press is the SENDER RULE;
      // the body's bytes live on in the provider's Junk, which is the master. Real headers stay.
      await r.huskBody(accountId, p.messageId, "junk_filed");
    }
    return false;
  }

  // The park — see the header. `forgetInstanceAt` on the locator just written removes the
  // instance we cannot ever verify and promotes a surviving watched copy exactly as an observed
  // expunge would.
  const promoted = await r.forgetInstanceAt(mailboxId, newLoc);
  // A DELETE WHOSE PARK PROMOTED A SURVIVOR IS NOT DONE. The API already tombstoned the row, so a watched
  // copy left behind would be SERVER-RESIDENT YET INVISIBLE FOR EVER (a known locator emits no create, a
  // converged folder_state leaves the queue). The user deleted the MESSAGE, so completion keeps the row
  // OPEN at the survivor's folder; the promotion repointed `messages.native_locator` at it, which
  // `listPendingFolderStates` joins, so the next pass files that copy to Trash — one per pass. The SPAM
  // park is not in this branch (its row is never tombstoned). A \Sent survivor is NEVER re-opened onto: by
  // EVIDENCE (Sent reads from a UID watermark, `imap.ts#enumFloorUid` never reports a delete below it, so
  // a stale `own_copy` row would retry `MessageGoneError` for ever — `primaryInstanceVanished` stays false
  // and `voidGoneFiling` never fires) and by PRODUCT (the Sent copy is the record of what the user wrote).
  // `promoted != null`, not `!== null`: a void-returning fake reads as "no survivor", the safe direction.
  const deletePark = special.trashFolder !== null && p.desiredFolder === special.trashFolder;
  const survivorActionable =
    promoted != null && (special.sentFolder === null || promoted.folder !== special.sentFolder);
  if (deletePark && promoted != null && survivorActionable) {
    // The re-open is reported to the caller whether or not the completion applied: a superseded
    // row is pending under its NEW desire, so there is more due filing work either way, and
    // reporting it is what re-kicks the scheduler instead of waiting a poll.
    await settle(r, accountId, p, physical, { observedFolder: promoted.folder, lastSetBy: "us" });
    return true;
  }
  // The delete park's converged write. Reachable only for a Trash desire now — the spam path
  // returned above — so there is no husk here and no `satisfiedBy`: a delete writes the trash path
  // verbatim, which makes desired and observed equal.
  await settle(r, accountId, p, physical, {
    observedFolder: physical,
    lastSetBy: "us",
    ...(p.desiredFolder === physical ? {} : { satisfiedBy: physical }),
  });
  return false;
}
