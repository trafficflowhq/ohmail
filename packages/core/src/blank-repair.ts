import { isOrganizedFolder } from "./types.js";

/**
 * THE BLANK MESSAGE (IMAP-STREAMING-FETCH-TAKES-UNSOLICITED-FLAGS) — what an EMPTY source parses to.
 *
 * A build that took another session's flag change for a letter's reply stored, at the letter's UID,
 * a message with no Message-ID, From, Subject, date, recipients or files. The letter itself was never
 * imported, and where the organizer filed the blank (the Screener: no sender is nobody it knows) it
 * moved the letter on the server. An empty source always gets the same dedup key, so every later
 * blank of a mailbox joined the first row as one more place: the damage is counted in places.
 *
 * A real letter with no content (one blank line) normalizes to the same keys and the same empty
 * columns, so the store cannot tell the two apart; the bytes at the place can, and the repair
 * (`apps/worker/src/blank-repair.ts`) reads them before it changes anything.
 */

/** `fingerprintDedupKey(messageFingerprint(normalizeMime(empty)))` — `blank-repair.test.ts` recomputes it. */
export const BLANK_FINGERPRINT_KEY = "fp1:5c4048857eee31fa015e82f59ce5977ef899eee90c8b1cb25eb6599f6f3e69ab";

/** The legacy body key of the same empty source (sha256 of nothing), on a row stored before fp1. */
export const BLANK_LEGACY_KEY = "body:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** Every dedup key a blank row can carry. */
export const BLANK_DEDUP_KEYS: readonly string[] = [BLANK_FINGERPRINT_KEY, BLANK_LEGACY_KEY];

/** The repair's mode: `off` runs nothing, `dry` reads and counts and writes nothing, `apply` repairs. */
export type BlankRepairMode = "off" | "dry" | "apply";

/** `OHMAIL_BLANK_REPAIR` as the worker reads it: unset is apply, an unknown value `null`. */
export function blankRepairModeFrom(value: string | undefined): BlankRepairMode | null {
  const v = (value ?? "").trim().toLowerCase();
  if (v === "") return "apply";
  return v === "off" || v === "dry" || v === "apply" ? v : null;
}

/** One place a blank row holds: a UID under its epoch. */
export interface BlankPlace { folder: string; uidValidity: string; uid: number; isPrimary: boolean }

/** A live blank row with its places and its folder_state, as `WorkerRepo.listBlankMessages` answers. */
export interface BlankMessageRow {
  messageId: string;
  /** Its places, bounded by the listing; {@link placeCount} is how many it holds in all. */
  places: BlankPlace[];
  /** Every place the row holds, counted in the store, the ones past the listing's bound included. */
  placeCount: number;
  folderState: { desired: string; observed: string; lastSetBy: string } | null;
}

/**
 * What the server holds at one place. `gone`: the epoch moved on or the UID is absent. `blank`: bytes
 * that fingerprint as the blank, a real letter with no content. `letter`: bytes that do not, the
 * letter the blank stood in for. `unreadable`: the read failed or answered nothing.
 */
export type BlankPlaceReading = "gone" | "blank" | "letter" | "unreadable";

/**
 * What the repair does at one place. `keep`: a real content-free letter. `release`: forget a place
 * the server no longer holds. `return`: the move the blank caused is undone — the letter goes back to
 * INBOX and the place is forgotten. `reread`: forget the place and owe the UID a targeted re-read, so
 * the letter is imported where it is. `skip`: try again on a later visit.
 */
export type BlankPlaceAction = "keep" | "release" | "return" | "reread" | "skip";

/**
 * THE ONE DECISION, pure. A letter goes back to INBOX only when the move was the blank's own doing:
 * the organizer's primary place, filed by ohmail (`last_set_by = 'us'`) into an organized folder other
 * than INBOX, and settled there (desired = observed = this folder). Every other letter is re-read
 * where it stands; a reader never moves anything.
 */
export function blankPlaceAction(
  reading: BlankPlaceReading, place: BlankPlace, folderState: BlankMessageRow["folderState"],
  role: "organizer" | "reader",
): BlankPlaceAction {
  switch (reading) {
    case "unreadable": return "skip";
    case "gone": return "release";
    case "blank": return "keep";
    case "letter": {
      const movedByUs = folderState !== null && folderState.lastSetBy === "us"
        && folderState.desired === folderState.observed && folderState.desired === place.folder;
      return role === "organizer" && place.isPrimary && movedByUs
        && place.folder !== "INBOX" && isOrganizedFolder(place.folder) ? "return" : "reread";
    }
  }
}
