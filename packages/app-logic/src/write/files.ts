/**
 * A LETTER'S FILES, as the new screen takes them: a pick, a drop and the picture quality, admitted against the
 * ceiling the sending mailbox and the window agree on. The list itself lives in the composition (the letter's
 * `attachments`, held in memory only); this model reads it and hands back one whole list per change.
 *
 * The rules are 1.0.11's (`ComposeAttach`), carried whole:
 * - pictures are shrunk FIRST and the ceiling applies to the shrunk size;
 * - a file that cannot fit is refused on its size before its bytes are read;
 * - the same file twice (same name, same bytes) is a skip, not a second row;
 * - every commit is ONE list, made over the list as it stands at the commit, through the latest handler;
 * - a quality move re-encodes the pictures already on the letter from their PICKED bytes, never from an encode, and
 *   a re-encode that would cross the ceiling keeps the bytes the file was admitted with;
 * - a pick still being read holds Send (the screen reads `attaching`) and an app restart;
 * - nothing commits after the screen went away: a discarded letter stays discarded.
 */
import type { ComposeAttachment } from "@ohmail/wire";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { ImageQualityLevel } from "@ohmail/client-engine";
import { holdFilesForRestart } from "../doors/app-update.js";
import {
  admit,
  readAsBase64,
  requalified,
  same,
  totalBytes,
  type Picked,
  type Pictures,
} from "./file-rules.js";

export * from "./file-rules.js";

/**
 * Each admitted file's PICKED bytes, by the attachment object, at module scope: the list outlives the screen (the
 * composition keeps it), so a quality move after a return to the letter still finds them. Weak: a removed file or a
 * closed letter lets its bytes go; a list restored without bytes has none and is left as it is.
 */
const SOURCES = new WeakMap<ComposeAttachment, { blob: Blob; original?: string; level: ImageQualityLevel }>();

async function encode(
  source: Blob,
  pictures: Pictures,
  level: ImageQualityLevel,
): Promise<{ blob: Blob; contentType: string }> {
  if (pictures === "none") return { blob: source, contentType: source.type || "application/octet-stream" };
  return pictures.compress(source, level);
}

/** What the last pick or quality move said; every refusal is said, none stands in for another. */
export interface FilesNotes {
  readonly refusedAt: number | null;
  readonly unreadable: boolean;
  readonly twice: readonly string[];
  readonly saved: { readonly from: number; readonly to: number } | null;
  /** A quality move kept a picture's size, under this ceiling. */
  readonly qualityKept: number | null;
  /** The quality moved while files stood on the letter: what the move does and does not touch. */
  readonly scope: boolean;
}

const QUIET: FilesNotes = {
  refusedAt: null,
  unreadable: false,
  twice: [],
  saved: null,
  qualityKept: null,
  scope: false,
};

export interface LetterFilesInput {
  readonly list: readonly ComposeAttachment[];
  /** The composition's one setter for the letter's files. */
  readonly onList: (next: ComposeAttachment[]) => void;
  readonly cap: number;
  readonly pictures: Pictures;
}

export interface LetterFiles {
  /** The names still being read: Send waits for them. */
  readonly attaching: readonly string[];
  readonly notes: FilesNotes;
  /** The quality pictures go at; `none`: no control. */
  readonly level: ImageQualityLevel | "none";
  readonly used: number;
  add(files: readonly File[]): Promise<void>;
  remove(at: number): void;
  setLevel(level: ImageQualityLevel): void;
}

/** The model's live reads: the list, the handler and the ceiling of the latest render, and whether it still stands. */
interface Live {
  readonly list: MutableRefObject<readonly ComposeAttachment[]>;
  readonly cap: MutableRefObject<number>;
  /* The intake's commit until the render that receives it: a pass kicked in the same tick reads it, the list ref
     being one commit behind. */
  readonly pending: MutableRefObject<readonly ComposeAttachment[] | null>;
  /** A pass checks it after every await; going away bumps it. */
  readonly gen: MutableRefObject<number>;
  readonly level: MutableRefObject<ImageQualityLevel | "none">;
  readonly setNotes: (next: FilesNotes | ((n: FilesNotes) => FilesNotes)) => void;
  readonly stands: () => boolean;
  /** One whole list, through the latest handler, never after the screen went away. */
  commit(next: readonly ComposeAttachment[]): void;
}

function useLive(input: LetterFilesInput, setNotes: Live["setNotes"]): Live {
  const list = useRef(input.list);
  list.current = input.list;
  const onList = useRef(input.onList);
  onList.current = input.onList;
  const cap = useRef(input.cap);
  cap.current = input.cap;
  const pending = useRef<readonly ComposeAttachment[] | null>(null);
  const pf = pending.current;
  /* Cleared on elementwise identity: a caller may clone the array every render. */
  if (pf !== null && pf.length === input.list.length && pf.every((a, i) => a === input.list[i]))
    pending.current = null;
  const mounted = useRef(true);
  const gen = useRef(0);
  const level = useRef<ImageQualityLevel | "none">("none");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      gen.current += 1;
    };
  }, []);
  const stands = useCallback(() => mounted.current, []);
  const commit = useCallback((next: readonly ComposeAttachment[]) => {
    if (mounted.current) onList.current([...next]);
  }, []);
  /* One object for the model's life: every member is a ref or a stable call. */
  return useMemo(
    () => ({ list, cap, pending, gen, level, setNotes, stands, commit }),
    [setNotes, stands, commit],
  );
}

/** The names of the picks still being read; a pick being read holds an app restart. */
function useAttaching(stands: () => boolean) {
  const [attaching, setAttaching] = useState<readonly string[]>([]);
  const inFlight = useRef(new Map<number, readonly string[]>());
  const seq = useRef(0);
  const restart = useRef<(() => void) | null>(null);
  const report = useCallback((): void => {
    const names = [...inFlight.current.values()].flat();
    if (names.length > 0) restart.current ??= holdFilesForRestart();
    else {
      restart.current?.();
      restart.current = null;
    }
    if (stands()) setAttaching(names);
  }, [stands]);
  useEffect(
    () => () => {
      restart.current?.();
      restart.current = null;
    },
    [],
  );
  const begin = useCallback(
    (names: readonly string[]): (() => void) => {
      const pick = ++seq.current;
      inFlight.current.set(pick, names);
      report();
      return () => {
        inFlight.current.delete(pick);
        report();
      };
    },
    [report],
  );
  return { attaching, begin };
}

/** The pictures on the letter, re-encoded at `next` from their picked bytes, landed as one list. */
async function requalify(
  live: Live,
  pictures: Pictures,
  next: ImageQualityLevel,
  over?: readonly ComposeAttachment[],
): Promise<void> {
  if (pictures === "none") return;
  const mine = ++live.gen.current;
  const replacements = new Map<ComposeAttachment, Picked>();
  for (const a of over ?? live.list.current) {
    const source = SOURCES.get(a);
    if (!source) continue;
    const picture = await encode(source.blob, pictures, next);
    if (mine !== live.gen.current) return;
    let contentBase64: string;
    if (picture.blob === source.blob) {
      source.original ??= await readAsBase64(source.blob);
      contentBase64 = source.original;
    } else contentBase64 = await readAsBase64(picture.blob);
    if (mine !== live.gen.current) return;
    if (contentBase64 === a.contentBase64) {
      source.level = next;
      continue;
    }
    const attachment: ComposeAttachment = {
      filename: a.filename,
      contentType: picture.contentType,
      contentBase64,
    };
    SOURCES.set(attachment, { ...source, level: next });
    const compressed = picture.blob !== source.blob;
    replacements.set(a, {
      attachment,
      bytes: picture.blob.size,
      originalBytes: source.blob.size,
      compressed,
    });
  }
  if (mine !== live.gen.current || replacements.size === 0) return;
  const latest = over !== undefined && live.pending.current === over ? over : live.list.current;
  const cap = live.cap.current;
  const r = requalified(latest, replacements, cap);
  live.setNotes((n) => ({ ...n, qualityKept: r.kept ? cap : null, saved: r.saved }));
  if (r.list !== latest) live.commit(r.list);
}

/** One file of a pick, shrunk, refused on its size before its bytes are read, or skipped as a twin. */
async function readOne(
  live: Live,
  pictures: Pictures,
  at: ImageQualityLevel,
  file: File,
  picked: Picked[],
  said: { refuse(cap: number): void; twice: string[] },
): Promise<void> {
  const picture = await encode(file, pictures, at);
  const cap = live.cap.current;
  /* Reprojected against the list and the ceiling as they stand now: a staged file the ceiling no longer admits is
     refused now, and a file over what is left is refused before it is read. */
  let projected = totalBytes(live.list.current);
  for (let i = 0; i < picked.length;) {
    if (projected + picked[i]!.bytes <= cap) {
      projected += picked[i]!.bytes;
      i += 1;
    } else {
      picked.splice(i, 1);
      said.refuse(cap);
    }
  }
  if (projected + picture.blob.size > cap) return said.refuse(cap);
  const contentBase64 = await readAsBase64(picture.blob);
  const filename = file.name || "attachment";
  const attachment: ComposeAttachment = { filename, contentType: picture.contentType, contentBase64 };
  if ([...live.list.current, ...picked.map((p) => p.attachment)].some((a) => same(a, attachment))) {
    said.twice.push(filename);
    return;
  }
  SOURCES.set(attachment, {
    blob: file,
    level: at,
    ...(picture.blob === file ? { original: contentBase64 } : {}),
  });
  picked.push({
    attachment,
    bytes: picture.blob.size,
    originalBytes: file.size,
    compressed: picture.blob !== file,
  });
}

/** A pick: every file read, then ONE commit over the list as it stands; every refusal said. */
async function intake(live: Live, pictures: Pictures, files: readonly File[]): Promise<void> {
  live.setNotes(QUIET);
  const level = live.level.current;
  const at: ImageQualityLevel = level === "none" ? "original" : level;
  let unreadable = false;
  let refusedAt: number | null = null;
  const said = {
    refuse: (c: number): void => {
      refusedAt = refusedAt === null ? c : Math.min(refusedAt, c);
    },
    twice: [] as string[],
  };
  const picked: Picked[] = [];
  for (const file of files) {
    try {
      await readOne(live, pictures, at, file, picked, said);
    } catch {
      unreadable = true;
    }
  }
  if (!live.stands()) return;
  const latest = live.list.current;
  const done = admit(latest, picked, live.cap.current);
  if (done.refusedAt !== null) said.refuse(done.refusedAt);
  live.setNotes({
    ...QUIET,
    refusedAt,
    unreadable,
    twice: [...said.twice, ...done.twice],
    saved: done.saved,
  });
  if (done.list === latest) return;
  live.pending.current = done.list;
  live.commit(done.list);
  /* The quality moved while these were read: the whole list goes to the level chosen last. */
  const now = live.level.current;
  if (now !== level && now !== "none") void requalify(live, pictures, now, done.list);
}

/** The letter's files over the composition's list. */
export function useLetterFiles(input: LetterFilesInput): LetterFiles {
  const { list, pictures } = input;
  const [notes, setNotes] = useState<FilesNotes>(QUIET);
  const live = useLive(input, setNotes);
  const { attaching, begin } = useAttaching(live.stands);
  const [level, setLevelState] = useState<ImageQualityLevel | "none">("none");

  /* The stored level, read after the first paint (no storage on a server render); a list left encoded at another
     level (a move made elsewhere) is brought to it once. */
  useEffect(() => {
    if (pictures === "none") return;
    const stored = pictures.level();
    live.level.current = stored;
    setLevelState(stored);
    const behind = live.list.current.some((a) => {
      const s = SOURCES.get(a);
      return s !== undefined && s.level !== stored;
    });
    if (behind) void requalify(live, pictures, stored);
  }, [pictures, live]);

  const add = useCallback(
    async (files: readonly File[]): Promise<void> => {
      if (files.length === 0) return;
      const end = begin(files.map((f) => f.name || "attachment"));
      try {
        await intake(live, pictures, files);
      } finally {
        end();
      }
    },
    [begin, live, pictures],
  );

  const remove = useCallback(
    (at: number): void => {
      const latest = live.list.current;
      if (at >= 0 && at < latest.length) live.commit(latest.filter((_, i) => i !== at));
    },
    [live],
  );

  const setLevel = useCallback(
    (next: ImageQualityLevel): void => {
      if (pictures === "none") return;
      pictures.setLevel(next);
      live.level.current = next;
      setLevelState(next);
      setNotes({ ...QUIET, scope: live.list.current.length > 0 });
      void requalify(live, pictures, next);
    },
    [pictures, live],
  );

  return { attaching, notes, level, used: totalBytes(list), add, remove, setLevel };
}
