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
 * ── THE CLAIM FOLLOWS THE MOVE, NEVER THE OTHER WAY ─────────────────────────────────────────
 *
 * Everything here that says "this message is in Junk" — the husk's `junk_filed` marker, the
 * satisfied folder_state, the parked locator — is written by {@link completeFiling}, which the
 * reconciler calls ONLY after `adapter.move`/`moveMany` returned the new locator. A verdict
 * whose IMAP move failed leaves the row pending and unhusked; the guard suite reddens on any
 * ordering that writes the claim first.
 */

import type { WorkerRepo, PendingFolderState } from "@trafficflow/core/adapters/drizzle-repo";

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

/** The mailbox's discovered special folders, as `getMailboxSpecialFolders` answers them. */
export interface SpecialFolderMap { junkFolder: string | null; trashFolder: string | null }

/** The neither-exists map — what a repo without the discovery methods answers. */
export const NO_SPECIAL_FOLDERS: SpecialFolderMap = { junkFolder: null, trashFolder: null };

/**
 * Load the map once per reconcile pass. Absence of the method — a fake, an older repo — reads
 * as "neither exists": the verdict falls back to Quarantine and a delete cannot have been
 * accepted by the API in the first place (it refuses up front on a NULL `trash_folder`).
 */
export async function specialFoldersOf(repo: WorkerRepo, mailboxId: string): Promise<SpecialFolderMap> {
  if (typeof repo.getMailboxSpecialFolders !== "function") return NO_SPECIAL_FOLDERS;
  return repo.getMailboxSpecialFolders(mailboxId);
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
 * The completion write for one landed move — the ONE place the database learns a message
 * reached its destination, shared by `fileChunk`, `fileOne` and the explicitly-invoked sweep.
 *
 * Ordinary moves keep the historical write byte-for-byte: locator repointed, folder_state
 * converged on the destination. The two boundary-leaving shapes add exactly what the header
 * describes — the park, the satisfied folder_state, and (spam only) the `junk_filed` husk. The
 * husk runs before any `change_log` write a caller may add after this, per the lock-order rule
 * (`insertMessageBody` step 1: counter row, then seq row, always in that order).
 */
export async function completeFiling(
  r: WorkerRepo,
  accountId: string,
  mailboxId: string,
  p: PendingFolderState,
  newLoc: Locator,
  special: SpecialFolderMap,
): Promise<void> {
  const physical = newLoc.folder;
  await r.updateLocator(p.messageId, newLoc);
  if (!parksLocator(p, physical, special)) {
    await r.upsertFolderState(p.messageId, {
      desiredFolder: p.desiredFolder, observedFolder: p.desiredFolder, lastSetBy: "us",
    });
    return;
  }
  // The park — see the header. `forgetInstanceAt` on the locator just written removes the
  // instance we cannot ever verify and promotes a surviving watched copy exactly as an observed
  // expunge would.
  await r.forgetInstanceAt(mailboxId, newLoc);
  await r.upsertFolderState(p.messageId, {
    desiredFolder: p.desiredFolder,
    observedFolder: physical,
    lastSetBy: "us",
    ...(p.desiredFolder === physical ? {} : { satisfiedBy: physical }),
  });
  if (p.desiredFolder === SPAM_PILE && typeof r.huskBody === "function") {
    // The verdict's mirror semantics: the durable artifact of a spam press is the SENDER RULE;
    // the body's bytes live on in the provider's Junk, which is the master. Real headers stay.
    await r.huskBody(accountId, p.messageId, "junk_filed");
  }
}
