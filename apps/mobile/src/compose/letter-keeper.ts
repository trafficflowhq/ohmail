/**
 * THE OPEN COMPOSER'S LETTER, KEPT AS IT IS WRITTEN — the composer's half of `letter-store.ts`, as
 * decisions rather than branches inside a sheet (no React Native renderer in this workspace). Typing
 * writes the record half a second after the last change; leaving the foreground or the screen
 * writes it at once. A keep or a send is MARKED before its mutation is dispatched, so a hard stop
 * between the two leaves the next launch the truth: the letter was being kept, or was sent.
 */
import { keptFit, rowHoldsLetter, wordsOf, type Letter, type LetterDoor, type LetterFile } from "./letter-store";

/** How long after the last change the letter reaches the disk. */
export const LETTER_WRITE_MS = 500;

/** Letters an open composer holds: a launch's restore and the flush leave them to it. */
const owned = new Set<string>();
export const ownedLetters = (): ReadonlySet<string> => owned;

/** The account's letters for this session, and the ids a new letter or file takes. */
export interface LetterSession { door: LetterDoor; uuid: () => string }
let session: LetterSession | null = null;
export function openLetterSession(s: LetterSession | null): void { session = s; }
export const letterSession = (): LetterSession | null => session;

export type LetterWords = Pick<Letter, "mode" | "messageId" | "mailboxId" | "to" | "cc" | "bcc" | "subject" | "body" | "envelope">;

/** What a keep answered: the row it made or updated, or the key a queued save waits under. */
export interface KeptRow { draftId: string | null; key: string | null; revision?: string }

/** What a send press answered, as `SendResult` says it. */
export interface SendAnswer { outcome: string; key?: string; draftId?: string; revision?: string }

export interface LetterKeeper {
  readonly id: string;
  current(): Letter;
  edit(words: LetterWords): void;
  /** Write now what is waiting: the app left the foreground, or the composer is leaving. */
  flush(): void;
  /** A picked file's bytes, written once; answers the file's id. */
  addFile(file: { filename: string; contentType: string; contentBase64: string; sizeBytes: number }): string;
  removeFile(fileId: string): void;
  /** A draft opened from Drafts saved itself: `savedAs` is what the row now holds. */
  saved(draftId: string, savedAs: string, revision: string | null): void;
  forwardKept(ids: string[] | null): void;
  /** The files that would not fit beside the files already kept with drafts. */
  overKeepLimit(): LetterFile[];
  /** Drop the files that do not fit before a keep: the close named them. */
  dropOverLimit(): void;
  markKeep(): void;
  keepAnswered(row: KeptRow | null): void;
  markSend(sig?: string | null): void;
  sendAnswered(r: SendAnswer): void;
  /** A send press: marked on the disk before `dispatch` writes its outbox row, then answered. */
  sendVia<R extends SendAnswer>(dispatch: () => Promise<R>, sig?: string | null): Promise<R>;
  /** Cancel send withdrew it: the files stay with the row that holds the words, if one does. */
  cancelled(draftId: string | null): void;
  /** Nothing worth keeping, or the person discarded it. */
  drop(): void;
  /** The composer is gone; what is on disk stays for the flush or the next launch to settle. */
  release(): void;
}

export interface KeeperOptions {
  door: LetterDoor;
  id: string;
  words: LetterWords;
  newFileId: () => string;
  /** A composer opened from Drafts: its row, the words that row holds, the files kept with it. */
  draftId?: string | null;
  savedAs?: string | null;
  /** That row's version as opened. */
  revision?: string | null;
  files?: LetterFile[];
  now?: () => Date;
  timers?: { set: (f: () => void, ms: number) => unknown; clear: (t: unknown) => void };
}

export function openLetterKeeper(o: KeeperOptions): LetterKeeper {
  const now = o.now ?? (() => new Date());
  const timers = o.timers ?? { set: (f: () => void, ms: number) => setTimeout(f, ms), clear: (t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>) };
  const stored = o.door.letter(o.id);
  // Opened from Drafts: the row as opened is what the words are based on, whatever an older keep wrote.
  const opened = o.draftId != null ? { draftId: o.draftId, savedAs: o.savedAs ?? null, revision: o.revision ?? null } : null;
  let letter: Letter = stored ? { ...stored, ...opened } : {
    v: 1, id: o.id, ...o.words, files: o.files ?? [], forwardKept: null,
    draftId: o.draftId ?? null, savedAs: o.savedAs ?? null, revision: o.revision ?? null, keep: null, send: null, updatedAt: now().toISOString(),
  };
  /** What the disk holds of this letter, compared before every write. */
  let onDisk: string | null = stored ? JSON.stringify(stored) : JSON.stringify(letter);
  let timer: unknown = null;
  let gone = false;
  owned.add(o.id);

  const write = (): void => {
    if (timer !== null) { timers.clear(timer); timer = null; }
    if (gone) return;
    const next = JSON.stringify(letter);
    if (next === onDisk) return;
    letter = { ...letter, updatedAt: now().toISOString() };
    o.door.put(letter);
    onDisk = JSON.stringify(letter);
  };
  const soon = (): void => {
    if (timer !== null) timers.clear(timer);
    timer = timers.set(() => { timer = null; write(); }, LETTER_WRITE_MS);
  };
  const set = (patch: Partial<Letter>): void => { letter = { ...letter, ...patch }; };
  /** A version named by the answer, else the base while the row is the same one. */
  const bound = (draftId: string, savedAs = wordsOf(letter), revision?: string | null): void => {
    set({ draftId, savedAs, revision: revision ?? (draftId === letter.draftId ? letter.revision ?? null : null), keep: null, send: null });
    if (!rowHoldsLetter(letter) || savedAs !== wordsOf(letter)) { write(); return; }
    // A row that holds the whole letter needs nothing here: the server holds the words until the next edit.
    if (timer !== null) { timers.clear(timer); timer = null; }
    o.door.drop(o.id);
    onDisk = JSON.stringify(letter);
  };
  const drop = (): void => {
    if (timer !== null) { timers.clear(timer); timer = null; }
    if (!gone) o.door.drop(o.id);
    gone = true;
    owned.delete(o.id);
  };

  const markSend = (sig: string | null = null): void => { set({ send: { at: now().toISOString(), key: null, sig } }); write(); };
  const sendAnswered = (r: SendAnswer): void => {
    if (r.outcome === "sent" || r.outcome === "superseded") { drop(); return; }
    // The server holds an unverified send in its row: the letter is that row, its files with it.
    if (r.outcome === "unverified" && r.draftId) { bound(r.draftId, undefined, r.revision); return; }
    if (r.outcome === "queued" || r.outcome === "unverified") {
      set({ send: { ...letter.send, at: letter.send?.at ?? now().toISOString(), key: r.key ?? letter.send?.key ?? null } });
      write();
      return;
    }
    // Refused: the row it left holds the words, and the files stay with it.
    if (r.draftId) { bound(r.draftId, undefined, r.revision); return; }
    set({ send: null });
    write();
  };

  return {
    id: o.id,
    current: () => letter,
    edit: (words) => {
      set(words);
      soon();
    },
    flush: write,
    addFile: (f) => {
      const fileId = o.newFileId();
      o.door.putFile(o.id, fileId, f.contentBase64);
      set({ files: [...letter.files, { fileId, filename: f.filename, contentType: f.contentType, sizeBytes: f.sizeBytes }] });
      write();
      return fileId;
    },
    removeFile: (fileId) => {
      set({ files: letter.files.filter((f) => f.fileId !== fileId) });
      write();
      o.door.dropFile(fileId);
    },
    saved: (draftId, savedAs, revision) => bound(draftId, savedAs, revision),
    forwardKept: (ids) => { set({ forwardKept: ids }); soon(); },
    overKeepLimit: () => keptFit(letter.files, o.door.keptBytes(o.id)).over,
    dropOverLimit: () => {
      const { fit, over } = keptFit(letter.files, o.door.keptBytes(o.id));
      if (over.length === 0) return;
      set({ files: fit });
      write();
      for (const f of over) o.door.dropFile(f.fileId);
    },
    markKeep: () => { set({ keep: { at: now().toISOString(), key: null } }); write(); },
    keepAnswered: (row) => {
      if (row === null) { set({ keep: null }); write(); return; }
      if (row.draftId !== null) { bound(row.draftId, undefined, row.revision); return; }
      set({ keep: { at: letter.keep?.at ?? now().toISOString(), key: row.key } });
      write();
    },
    markSend,
    sendAnswered,
    sendVia: async (dispatch, sig) => {
      markSend(sig);
      const r = await dispatch();
      sendAnswered(r);
      return r;
    },
    cancelled: (draftId) => {
      const row = draftId ?? letter.draftId;
      if (row !== null) bound(row);
      else drop();
    },
    drop,
    release: () => {
      write();
      owned.delete(o.id);
    },
  };
}
