/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  WHERE A FILING PHYSICALLY LANDS — the spam verdict's native-\Junk mapping and its completion
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The product rule this executes lives at `packages/core/src/adapters/imap-types.ts` (the
 * 2026-08-22 amendment): the organizer never watches the provider's `\Junk`/`\Trash` and never
 * acts there on its own initiative, but three USER-COMMANDED writes are allowed — the spam
 * verdict files to native `\Junk`, a not-junk rescue moves back to INBOX, a delete moves to
 * native `\Trash`. This module is the worker's half of the first and third: given a pending
 * `folder_state` row, it answers where the move PHYSICALLY goes and what the completion write
 * must record so the database keeps telling the truth about the mailbox.
 *
 * ── THE PILE AND THE PLACE ARE TWO FACTS, AND BOTH ARE STORED HONESTLY ──────────────────────
 *
 * A spam verdict's `desired_folder` stays `ohmail/Quarantine` — the PILE, which is what every
 * view, DTO and client projects — while the message physically rides to the provider's Junk.
 * The completion therefore writes `observed_folder = <the junk path>` (the server's truth,
 * never rewritten) with `satisfiedBy` naming that same path, which is the one shape
 * `reconcileStatusFor` accepts as fulfilment rather than divergence. See
 * `FolderStateRow.satisfiedBy` for why this cannot let a row claim a convergence it lacks.
 *
 * ── WHY THE COMPLETION "PARKS" THE LOCATOR ──────────────────────────────────────────────────
 *
 * A folder we never enumerate can never produce the DELETE evidence `forgetInstanceAt` records,
 * so an instance row left pointing into Junk/Trash would be unfalsifiable — and worse, it would
 * block the one convergence story the unwatched folders have: a user who RESTORES the message in
 * their own client (Junk→INBOX, Trash→anywhere watched) produces a create whose adoption
 * evidence is exactly `primaryInstanceVanished` — `native_locator` set, no instance row. So the
 * completion calls `forgetInstanceAt` on the locator it just wrote: the instance goes, a
 * surviving watched copy (the rare unexpunged-source shape) is promoted exactly as an observed
 * expunge would promote it, and `messages.native_locator` keeps the Junk/Trash path as the last
 * known place — which is also what the ohmail-side rescue moves FROM.
 *
 * A DELETE whose park promoted a survivor does NOT converge: the row is already tombstoned, the
 * survivor is a known locator no scan will ever re-create, so completion keeps the folder_state
 * PENDING at the survivor's folder and the next pass files that copy to Trash too — one copy per
 * pass, until no watched instance remains. A \Sent survivor is the exception (never re-opened
 * onto — evidence and product grounds, spelled out at the branch), and the re-open is reported
 * to the caller so the scheduler re-kicks instead of waiting a poll. See {@link completeFiling}.
 *
 * ── THE CLAIM FOLLOWS THE MOVE, NEVER THE OTHER WAY ─────────────────────────────────────────
 *
 * Everything here that says "this message is in Junk" — the husk's `junk_filed` marker, the
 * satisfied folder_state, the parked locator — is written by {@link completeFiling}, which the
 * reconciler calls ONLY after `adapter.move`/`moveMany` returned the new locator. A verdict
 * whose IMAP move failed leaves the row pending and unhusked; the guard suite reddens on any
 * ordering that writes the claim first.
 *
 * ── AND THE COMPLETION MAY NOT WRITE THE DESIRE IT READ ─────────────────────────────────────
 *
 * The other half of the same rule, and the one that cost a real placement. `p` is the pending row
 * read at the TOP of the reconcile pass — before the IMAP round trip, which on a slow host is
 * minutes. Completing through `upsertFolderState` wrote `p.desiredFolder` back as part of the
 * completion, so a decision that committed during the move was reverted: the re-screen takes the
 * row, writes `desired_folder = 'ohmail/Screener'`, commits, and the completion puts `'INBOX'`
 * back over it. A lost update, not a stale read — both writers behaved as designed and nothing
 * errored. Every arm below therefore completes through {@link WorkerRepo.completeFolderState},
 * which cannot write `desired_folder` AT ALL, matched witness or not.
 *
 * ── AND A DECLINED COMPLETION MAY NOT LEAVE `observed_folder` STALE EITHER ──────────────────
 *
 * A second-round finding, on the first version of this fix. The mail has ALREADY physically
 * moved by the time a completion is attempted (`updateLocator`, above, runs unconditionally) — so
 * a completion that writes nothing at all on a miss leaves `folder_state.observed_folder`
 * describing wherever the row was BEFORE this move, which is now false. When the competing writer
 * that superseded the desire happened to write a pair that was already converged (`desired ===
 * observed`, the ordinary shape of "the user restores a message while the old move is still in
 * flight"), that stale-but-converged row would never be looked at again — on the spam path
 * specifically, feeding {@link WorkerRepo.tombstoneInstanceless} a message with no watched instance
 * and no exemption, because the park had already run.
 *
 * So the park itself is now CONDITIONAL on the completion matching (see the spam branch below),
 * and `completeFolderState`, called from here with `physicalObservation: true` (this module is
 * the ONLY caller with a genuine landed move to report), writes `observed_folder` — the physical
 * fact — even on a miss, deriving `reconcile_status` from the row's LIVE `desired_folder` rather
 * than the witness. A declined completion therefore always records where the mail actually is and
 * records `reconcile.move.superseded`; if the live desire still disagrees with that location the
 * row is left PENDING, which is what lets the next cycle converge it from the locator this
 * function already repointed. See `completeFolderState`'s own doc — and `physicalObservation`'s —
 * for the full mechanism, and for why the flag exists at all: a caller with no fresh physical fact
 * (two exist, both in `sync.ts`) must default to writing nothing on a miss, exactly as before.
 */

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
 * THE ONE PLACE A COMPLETION TOUCHES `folder_state` — the physical-observation write plus the
 * audit row a superseded intent owes.
 *
 * Every arm of {@link completeFiling} goes through here so the witness cannot be forgotten on one
 * of them: `expectDesiredFolder` is always `p.desiredFolder`, the value the move was computed
 * against, supplied here rather than by the caller.
 *
 * `completeFolderState`, called with `physicalObservation: true` below, writes `observed_folder`
 * on every call this module makes — matched witness or not — see its own doc for why the earlier
 * "write nothing on a miss" shape was itself a defect, and for why that is opt-in rather than the
 * default (a caller with no fresh physical fact must not overwrite a fresher writer's own record).
 * A MISS is
 * therefore recorded here, not because nothing happened, but because THIS caller's intent (a
 * park, a husk, the backoff reset) did not win the row: `reconcile.move.superseded` says the move
 * landed and the row's disposition now belongs to whatever set a newer desire, which is a normal,
 * correct outcome and the only way anybody can tell how often two writers meet on one row. Its
 * `to` is the PHYSICAL folder the mail actually reached, matching what was just written to
 * `observed_folder` — the row is a truthful record of where the message is even when its
 * `desired_folder` describes somewhere else, and self-heals from there on the next cycle.
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
 * The completion write for one landed move — the ONE place the database learns a message
 * reached its destination, shared by `fileChunk`, `fileOne` and the explicitly-invoked sweep.
 *
 * Ordinary moves keep the historical write byte-for-byte: locator repointed, folder_state
 * converged on the destination. The two boundary-leaving shapes add exactly what the header
 * describes — the park, the satisfied folder_state, and (spam only) the `junk_filed` husk. The
 * husk runs before any `change_log` write a caller may add after this, per the lock-order rule
 * (`insertMessageBody` step 1: counter row, then seq row, always in that order).
 *
 * Returns TRUE when the completion RE-OPENED the pending row (the delete-survivor branch below):
 * the pass that called this has just created more due filing work, and the caller owes that fact
 * to the scheduler — `reconcileFolders` folds it into `owesMore`, which is what re-kicks the
 * hosted worker and keeps the sidecar drain going. Without it a two-copy delete's second move
 * waits for the next poll, and a drain that stops on backlog alone stops with the delete
 * unfinished.
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
  await r.updateLocator(p.messageId, newLoc);
  if (!parksLocator(p, physical, special)) {
    await settle(r, accountId, p, physical, { observedFolder: p.desiredFolder, lastSetBy: "us" });
    return false;
  }
  // ══════════════════════════════════════════════════════════════════════════════════════════
  //  A SUPERSEDED SPAM COMPLETION MAY NOT PARK — parking it is how the message gets TOMBSTONED
  // ══════════════════════════════════════════════════════════════════════════════════════════
  //
  // Found by review of the conditional-write change itself, and it is the one place where
  // "decline and leave the newer intent standing" is not enough.
  //
  // The park removes the message's last watched instance, which is correct for a filed spam
  // verdict: the reaper (`tombstoneInstanceless`) exempts exactly that shape — `reconciled` WHILE
  // `desired <> observed`, the signature only the `satisfiedBy` completion writes. A SUPERSEDED
  // completion cannot write that signature, because it must not touch `desired_folder` at all. So
  // parking it leaves a message with no instance, no tombstone (`deleted_at IS NULL`) and no
  // exemption — precisely the reaper's victim predicate. The competing writer does not even have
  // to be exotic: `ruleRetroPass` and friends store `desired === observed` with
  // `reconcile_status = 'reconciled'`, and that row is both un-exempt AND absent from
  // `listPendingFolderStates`, so nothing would ever move it back out of Junk either.
  //
  // Hence: CLAIM FIRST, PARK SECOND, on the spam path. A declined claim skips the park and the
  // husk, so the instance row survives, the reaper's predicate is not met, and the message is
  // still addressable — `messages.native_locator` names the Junk copy, which is exactly what the
  // reconciler moves FROM when it carries the newer intent out. One cycle of an instance row
  // pointing into an unwatched folder is a bounded, self-healing residual; a tombstone is not.
  //
  // THE DELETE PARK IS DIFFERENT AND KEEPS THE OLD ORDER, for a reason worth stating rather than
  // leaving to be re-derived: the API has already tombstoned that row, and the reaper's first
  // filter is `deleted_at IS NULL`, so a delete park is unreachable by it whatever this writes.
  // The survivor branch below also needs `promoted` before it can say what to store, and
  // inverting the order there would mean writing the row twice.
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
  // ── A DELETE WHOSE PARK PROMOTED A SURVIVOR IS NOT DONE ─────────────────────────────────────
  //
  // The API's delete has already tombstoned the row (`deleted_at` + the `delete` change), so a
  // watched copy left behind would be SERVER-RESIDENT YET INVISIBLE FOR EVER: the survivor is a
  // KNOWN locator, so no later scan emits the create that resurrects a tombstone, and a converged
  // folder_state takes the row out of the reconciler's queue. The user deleted the MESSAGE, and
  // every instance is a physical copy of it — the amended rule's user-commanded Trash write
  // covers each one — so the completion keeps the pending row OPEN at the survivor's folder. The
  // promotion has already repointed `messages.native_locator` at the survivor, which is exactly
  // the locator `listPendingFolderStates` joins, so the next reconcile pass files that copy to
  // Trash through the same seam; the loop parks one copy per pass and converges the row below
  // once nothing watched remains.
  //
  // The SPAM park is deliberately not in this branch: its row is never tombstoned — it stays on
  // the Quarantine pile in every client — so a surviving copy hides nothing, and re-filing it
  // would widen the one user-commanded Junk write into a sweep this completion was never asked
  // for. (`promoted != null`, not `!== null`: a fake that still answers void reads as "no
  // survivor", which is the pre-existing behaviour and the safe direction.)
  //
  // ── AND A \Sent SURVIVOR IS NEVER RE-OPENED ONTO, on two grounds ──────────────────────────
  //
  //  1. EVIDENCE. Sent is the one folder read from a UID watermark, and a delete below that
  //     watermark is deliberately never reported (`imap.ts#enumFloorUid`) — so a recorded Sent
  //     instance is the one kind of row the enumeration cannot keep honest. Promoting a STALE
  //     one (its `own_copy` recorded at send time, expunged since by another client) and then
  //     re-opening the move onto it would retry `MessageGoneError` for ever: the stale row is
  //     primary now, so `primaryInstanceVanished` stays false and `voidGoneFiling` never fires,
  //     and the disappearance that would clear it is exactly the delete Sent never emits.
  //     Every OTHER watched folder is enumerated end-to-end, so a stale row there is removed by
  //     the next cycle's deletes and the pending row self-heals through the existing paths.
  //  2. PRODUCT. The Sent copy is the record of what the user wrote. Every mainstream client
  //     leaves it where it is when the received copy is deleted; sweeping it into Trash on the
  //     strength of a delete pressed on the other copy would be inventing a decision.
  //
  //  The residual this accepts, stated: a mailbox holding THREE copies (primary + Sent + a
  //  third watched copy) where the promotion happens to pick the Sent row converges here and
  //  the third copy stays hidden — the pre-fix behaviour, reachable only from that compound
  //  shape. A null `sentFolder` (no adapter answer) disables the exclusion, which is the
  //  conservative direction for the hidden-mail defect this branch exists to close.
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
