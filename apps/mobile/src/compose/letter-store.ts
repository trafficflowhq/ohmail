/**
 * THE LETTER BEING WRITTEN, ON THE PHONE'S OWN DISK — a client-local record in the account's
 * mirror (stamped with its account, and deleted whole when the phone forgets it), so a force-stop,
 * a reboot or a crash loses neither the words nor the files. One record per letter, one per file: the bytes are
 * written once when picked, never inside the letter's frequent rewrite. Both types ride a full
 * resync (`isCarriedLocalType`). The door answers from its own copy at once and hands every write to
 * the store's single write queue in call order, so a mark written here before `engine.mutate` is
 * on disk before the outbox row that mutation writes.
 */
import { COMPOSE_FILE_TYPE, COMPOSE_LETTER_TYPE } from "@ohmail/client-engine";

/**
 * Files kept with drafts on this phone, all letters together: four times the phone's attach cap.
 * The store loads every row at launch, so this bounds what a launch holds in memory.
 */
export const KEPT_FILES_MAX_BYTES = 12 * 1024 * 1024;

export interface LetterAddress { name: string | null; address: string }

export interface LetterFile { fileId: string; filename: string; contentType: string; sizeBytes: number }

/** A keep or a send pressed for this letter, written before its mutation; `key` once known. */
export interface LetterMark {
  at: string;
  key: string | null;
  /** A send's signature, sealed onto the body it carried. */
  sig?: string | null;
}

export interface Letter {
  v: 1;
  id: string;
  mode: "reply" | "replyAll" | "forward" | "new";
  messageId: string | null;
  mailboxId: string | null;
  /** As typed. */
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  /** A reply's derived recipients and subject, so it can be kept when its original is gone. */
  envelope: { to: LetterAddress[]; cc: LetterAddress[]; subject: string } | null;
  files: LetterFile[];
  /** The forwarded parts kept, where the composer lists them; `null` is not chosen. */
  forwardKept: string[] | null;
  /** The draft row this letter is, once known, and the words that row holds. */
  draftId: string | null;
  savedAs: string | null;
  keep: LetterMark | null;
  send: LetterMark | null;
  updatedAt: string;
}

interface FileRecord { letterId: string; contentBase64: string }

/** The part of the account's mirror the letters live in — the app hands its `SqlMirrorStore`. */
export interface LetterJournal {
  get<T = unknown>(type: string, id: string): T | undefined;
  entries<T = unknown>(type: string): Array<{ id: string; entity: T }>;
  commitLocal(
    puts: ReadonlyArray<{ type: string; id: string; entity: unknown }>,
    deletes: ReadonlyArray<{ type: string; id: string }>,
  ): Promise<void>;
}

export interface LetterDoor {
  letter(id: string): Letter | undefined;
  letters(): Letter[];
  /** The letter holding a draft row's files. */
  letterOf(draftId: string): Letter | undefined;
  put(letter: Letter): void;
  putFile(letterId: string, fileId: string, contentBase64: string): void;
  dropFile(fileId: string): void;
  /** The letter and every file of it, in one write. */
  drop(letterId: string): void;
  bytes(fileId: string): string | undefined;
  /** A kept draft's files, bytes in hand; empty when this phone holds none. */
  filesOf(draftId: string): Array<LetterFile & { contentBase64: string }>;
  /** The bytes of every file kept with a draft, `except` one letter's. */
  keptBytes(except?: string): number;
  /** The disk's answer for every write so far. */
  landed(): Promise<"stored" | "lost">;
}

/** The words a draft row holds, compared to tell an edit from what was saved. */
export function wordsOf(l: Pick<Letter, "to" | "cc" | "bcc" | "subject" | "body">): string {
  return JSON.stringify([l.to, l.subject, l.body, l.cc, l.bcc]);
}

export function letterDoor(journal: LetterJournal): LetterDoor {
  const letters = new Map<string, Letter | null>();
  const files = new Map<string, FileRecord | null>();
  let last: Promise<"stored" | "lost"> = Promise.resolve("stored");
  const commit = (
    puts: Array<{ type: string; id: string; entity: unknown }>, deletes: Array<{ type: string; id: string }>,
  ): void => {
    const write = journal.commitLocal(puts, deletes).then((): "stored" => "stored", (): "lost" => "lost");
    const before = last;
    last = Promise.all([before, write]).then(([a, b]) => (a === "lost" || b === "lost" ? "lost" : "stored"));
  };
  const letter = (id: string): Letter | undefined => {
    if (letters.has(id)) return letters.get(id) ?? undefined;
    const row = journal.get<Letter>(COMPOSE_LETTER_TYPE, id);
    return row?.v === 1 ? row : undefined;
  };
  const fileRecord = (fileId: string): FileRecord | undefined => {
    if (files.has(fileId)) return files.get(fileId) ?? undefined;
    return journal.get<FileRecord>(COMPOSE_FILE_TYPE, fileId);
  };
  const all = (): Letter[] => {
    const ids = new Set([...journal.entries<Letter>(COMPOSE_LETTER_TYPE).map((e) => e.id), ...letters.keys()]);
    return [...ids].map(letter).filter((l): l is Letter => l !== undefined);
  };
  const letterOf = (draftId: string): Letter | undefined => all().find((l) => l.draftId === draftId);
  return {
    letter,
    letters: all,
    letterOf,
    put: (l) => {
      letters.set(l.id, l);
      commit([{ type: COMPOSE_LETTER_TYPE, id: l.id, entity: l }], []);
    },
    putFile: (letterId, fileId, contentBase64) => {
      files.set(fileId, { letterId, contentBase64 });
      commit([{ type: COMPOSE_FILE_TYPE, id: fileId, entity: { letterId, contentBase64 } }], []);
    },
    dropFile: (fileId) => {
      files.set(fileId, null);
      commit([], [{ type: COMPOSE_FILE_TYPE, id: fileId }]);
    },
    drop: (letterId) => {
      const held = letter(letterId);
      const owned = new Set(held?.files.map((f) => f.fileId) ?? []);
      for (const e of journal.entries<FileRecord>(COMPOSE_FILE_TYPE)) if (e.entity.letterId === letterId) owned.add(e.id);
      for (const [id, f] of files) if (f?.letterId === letterId) owned.add(id);
      letters.set(letterId, null);
      for (const id of owned) files.set(id, null);
      commit([], [{ type: COMPOSE_LETTER_TYPE, id: letterId }, ...[...owned].map((id) => ({ type: COMPOSE_FILE_TYPE, id }))]);
    },
    bytes: (fileId) => fileRecord(fileId)?.contentBase64,
    filesOf: (draftId) => {
      const l = letterOf(draftId);
      if (!l) return [];
      return l.files.flatMap((f) => {
        const b = fileRecord(f.fileId)?.contentBase64;
        return b === undefined ? [] : [{ ...f, contentBase64: b }];
      });
    },
    keptBytes: (except) => all()
      .filter((l) => l.id !== except && (l.draftId !== null || l.keep !== null))
      .reduce((n, l) => n + l.files.reduce((m, f) => m + f.sizeBytes, 0), 0),
    landed: () => last,
  };
}

/** Which of a letter's files fit beside the files already kept with drafts, in their order. */
export function keptFit(files: readonly LetterFile[], keptElsewhere: number): { fit: LetterFile[]; over: LetterFile[] } {
  let room = KEPT_FILES_MAX_BYTES - keptElsewhere;
  const fit: LetterFile[] = [];
  const over: LetterFile[] = [];
  for (const f of files) {
    if (f.sizeBytes <= room) { fit.push(f); room -= f.sizeBytes; } else over.push(f);
  }
  return { fit, over };
}
