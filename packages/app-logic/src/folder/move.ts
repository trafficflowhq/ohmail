/**
 * MOVE A LETTER INTO ANY OF THE PERSON'S FOLDERS: which folders it may go to, the one act a press sends, and what
 * each answer says. Nothing here decides a folder's fitness: the engine's `movableInto` does (a folder of the letter's
 * own mailbox, named exactly as the mirror lists it, with no folder command on it), and the server decides the rest.
 *
 * The act is the move every place already sends (`{ kind: "move", messageId, folder }`), with the folder entity's own
 * `name` as its path: never a typed name, no `pressRule`, no `from`. It goes through the shell's one press seam and its
 * one filing door (`fileAndRefresh`: the facts the filing strip states are read again after the answer): the engine
 * paints it at once, an organizer elsewhere is waited for, a refusal rolls the paint back and is said, and Undo is the
 * engine's own way back (`inverseMutations`, read before the press), offered only where the server takes one.
 */
import {
  inverseMutations,
  movableInto,
  type EngineMessage,
  type EngineMutation,
  type EntityReader,
  type FolderEntity,
  type MutationRejectedError,
  type PressVerdict,
} from "@ohmail/client-engine";
import { folderLeafOf } from "../lists/folders.js";
import { isNothingOrganizes, organizerRefusalOf } from "../press/organizer-refusal.js";

/** A folder the Move menu offers: disabled while a create, rename or delete stands on it. */
export interface FolderToMoveInto {
  readonly folder: FolderEntity;
  readonly disabled: boolean;
}

/** The mailbox record's word for its Junk folder: Junk and what lies under it are never offered. */
export interface MoveMailbox {
  readonly junkFolder: string | null | undefined;
}

/**
 * The folders of the letter's own mailbox it may be moved into, by their path: the one it is in left out, Junk and
 * everything under it left out by the mailbox's `junkFolder`, a folder the engine would not take shown disabled.
 * Trash is the server's to refuse (422): the mailbox record names no Trash folder.
 */
export function foldersToMoveInto(
  reader: EntityReader,
  message: Pick<EngineMessage, "mailboxId" | "folder">,
  mailbox: MoveMailbox,
): FolderToMoveInto[] {
  const junk = mailbox.junkFolder ?? null;
  return reader
    .list<FolderEntity>("folder")
    .filter(
      (f) =>
        f.mailboxId === message.mailboxId &&
        f.name !== message.folder &&
        (junk === null || (f.name !== junk && !f.name.startsWith(`${junk}/`))),
    )
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((folder) => ({ folder, disabled: !movableInto(reader, message.mailboxId, folder.name) }));
}

/** The sentences of a move into a folder, in the folder place's own words. */
export interface FolderMoveWords {
  moved(name: string): string;
  /** The organizer runs an ohmail that cannot take a move into a folder: the machine to update, by name. */
  outdated(by: string): string;
  outdatedUnknown(): string;
  /** Nothing organizes the mailbox. */
  nobody(): string;
  /** Another install organizes the mailbox. */
  elsewhere(by: string): string;
  elsewhereUnknown?(): string;
  /** The mailbox no longer lists the folder (renamed, deleted, never there). */
  gone(name: string): string;
  /** A folder command stands on it, above it or below it. */
  busy(name: string): string;
  /** Not a folder the letter can go to, or the letter is gone. */
  cannot(name: string): string;
  refused(): string;
  queued(holder: string | null): string;
  /** A move the organizer took up and refused, as the waiting list says it: the mailbox no longer lists the folder. */
  waitingGone(name: string): string;
  /** The letter is no longer there. */
  waitingLetterGone(): string;
  /** The organizer could not read the move. */
  waitingUnreadable(): string;
}

/** What a refused move says, from the refusal's own code. */
export function folderMoveRefusal(
  err: Pick<MutationRejectedError, "code" | "details"> | undefined,
  path: string,
  words: FolderMoveWords,
): string {
  const name = folderLeafOf(path);
  if (err?.code === "organized_elsewhere") {
    const r = organizerRefusalOf(err);
    if (isNothingOrganizes(r)) return words.nobody();
    if (r?.kind === "outdated") return r.name ? words.outdated(r.name) : words.outdatedUnknown();
    if (r?.kind === "elsewhere" && r.name) return words.elsewhere(r.name);
    return words.elsewhereUnknown?.() ?? words.refused();
  }
  if (err?.code === "no_such_folder") return words.gone(name);
  if (err?.code === "conflict") return words.busy(name);
  if (err?.code === "not_found") return words.cannot(name);
  return words.refused();
}

/**
 * What the waiting list says of a move the organizer refused, from the waiting row's own reason (`refusedReason`):
 * the three a move can meet there, anything else the generic sentence.
 */
export function folderWaitingRefusal(reason: string | null, path: string, words: FolderMoveWords): string {
  if (reason === "no_such_folder") return words.waitingGone(folderLeafOf(path));
  if (reason === "no_such_message") return words.waitingLetterGone();
  if (reason === "invalid_payload") return words.waitingUnreadable();
  return words.refused();
}

/** The press seam's doors a move goes through (`ShellDispatch`): the press, the one filing door, the Undo offer. */
export interface MovePressSeam {
  dispatchPress(mutation: EngineMutation): Promise<PressVerdict>;
  fileAndRefresh<T>(dispatch: Promise<T>): Promise<T>;
  toastWithUndo(sentence: string, inverses: readonly EngineMutation[]): void;
}

/**
 * Moves `message` into `folder`: one act, its answer said. Answers whether the move stands (painted, or replaced by a
 * newer press for the same letter); a refusal and a wait for the organizer answer false and offer no Undo. A letter
 * the mirror already holds in that folder (the same folder pressed again while the first press stands) is no second
 * act: nothing is sent and nothing more is said.
 */
export async function moveIntoFolder(
  seam: MovePressSeam,
  reader: EntityReader,
  toast: (sentence: string) => void,
  message: Pick<EngineMessage, "id">,
  folder: Pick<FolderEntity, "name">,
  words: FolderMoveWords,
): Promise<boolean> {
  if (reader.get<EngineMessage>("message", message.id)?.folder === folder.name) return true;
  const mutation: EngineMutation = { kind: "move", messageId: message.id, folder: folder.name };
  /* Read before the press: the way back names the place this press is about to leave. */
  const inverses = inverseMutations(reader, mutation);
  const out = await seam.fileAndRefresh(seam.dispatchPress(mutation));
  if (out.kind === "silent") return true;
  if (out.kind === "refused") {
    toast(folderMoveRefusal(out.refusal, folder.name, words));
    return false;
  }
  if (out.kind === "queued" && out.wait === "organizer") {
    toast(words.queued(out.holder));
    return false;
  }
  seam.toastWithUndo(words.moved(folderLeafOf(folder.name)), inverses);
  return true;
}
