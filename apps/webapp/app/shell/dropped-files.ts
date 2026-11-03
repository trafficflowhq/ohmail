/**
 * Files dropped on the desktop window from another program. WebKitGTK hands a file manager's drop to
 * the page as `text/uri-list` with its data withheld and no File objects, and its own default
 * inserts the file's path as text where the drop lands. The shell sees the same drop natively and
 * holds exactly those files (`src-tauri/src/dropped_files.rs`); the compose the drop landed on takes
 * them once, with no argument, and reads each in chunks by the token the take answered. No command
 * here names a path.
 *
 * Armed only by the engine-bearing desktop entry. The predicates are pure and read by every
 * surface: no editor inserts text from a file drop, in a browser either.
 */

/** The shell command that answers the latest drop's files, once. Takes nothing. */
export const DROPPED_FILES_TAKE_COMMAND = "dropped_files_take";
/** The shell command that answers one taken file's next chunk: `{drop, index}` in, `{bytes64, end}` out. */
export const DROPPED_FILE_CHUNK_COMMAND = "dropped_file_chunk";

let armed = false;

/** Switch the take on. Called once, from the engine-bearing desktop build's entry point; the call it
    returns switches it off again. */
export function enableDesktopDroppedFiles(): () => void {
  armed = true;
  return () => {
    armed = false;
  };
}

/** Whether this window may take a withheld drop from its shell. */
export function desktopDroppedFilesEnabled(): boolean {
  return armed;
}

function typesOf(dt: DataTransfer | null | undefined): string[] {
  return Array.from(dt?.types ?? []);
}

function fileCount(dt: DataTransfer | null | undefined): number {
  return dt?.files?.length ?? 0;
}

/** At drop: no File objects, `text/uri-list` listed, and its data withheld or every entry `file:`. */
export function isWithheldFileDrop(dt: DataTransfer | null | undefined): boolean {
  if (!dt || fileCount(dt) > 0 || !typesOf(dt).includes("text/uri-list")) return false;
  let data = "";
  try {
    data = dt.getData("text/uri-list");
  } catch {
    data = "";
  }
  const entries = data.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
  return entries.every((entry) => /^file:/i.test(entry));
}

/**
 * At dragover, where every drag's data reads "": `text/uri-list` without `text/plain` or `Files`.
 * Narrow on purpose: a link drag lists `text/plain`, and claiming its dragover makes WebKit navigate
 * to the link instead of inserting it.
 */
export function looksLikeWithheldFileDrag(dt: DataTransfer | null | undefined): boolean {
  const types = typesOf(dt);
  return types.includes("text/uri-list") && !types.includes("text/plain") && !types.includes("Files");
}

/** Whether a drop carries files: File objects, the `Files` type, or the withheld shape. */
export function dropCarriesFiles(dt: DataTransfer | null | undefined): boolean {
  return fileCount(dt) > 0 || typesOf(dt).includes("Files") || isWithheldFileDrop(dt);
}

/** One dropped file as the shell answered it; `read` fetches its bytes, once. */
export interface DroppedSource {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  readonly state: "ok" | "too_large" | "unreadable";
  read(): Promise<File>;
}

interface TauriInternals {
  invoke(command: string, payload?: Record<string, unknown>): Promise<unknown>;
}

function shellOf(): TauriInternals | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: Partial<TauriInternals> }).__TAURI_INTERNALS__;
  return typeof internals?.invoke === "function" ? (internals as TauriInternals) : null;
}

/** Base64 to bytes, without a binary string of the whole file. */
function bytesOf64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

const STATES = new Set(["ok", "too_large", "unreadable"]);

function sourceOf(shell: TauriInternals, drop: string, index: number, raw: unknown): DroppedSource {
  const f = (raw ?? {}) as { name?: unknown; size?: unknown; type?: unknown; state?: unknown };
  const name = typeof f.name === "string" ? f.name : "";
  const size = typeof f.size === "number" && Number.isSafeInteger(f.size) && f.size >= 0 ? f.size : 0;
  const type = typeof f.type === "string" ? f.type : "";
  const state = typeof f.state === "string" && STATES.has(f.state) ? (f.state as DroppedSource["state"]) : "unreadable";
  let reading: Promise<File> | null = null;
  const readAll = async (): Promise<File> => {
    if (state !== "ok") throw new Error("ohmail: this dropped file cannot be read");
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const answer = (await shell.invoke(DROPPED_FILE_CHUNK_COMMAND, { drop, index })) as { bytes64?: unknown; end?: unknown } | null;
      if (typeof answer?.bytes64 !== "string" || typeof answer.end !== "boolean") {
        throw new Error("ohmail: the shell's chunk is not one this window reads");
      }
      const bytes = bytesOf64(answer.bytes64);
      total += bytes.length;
      if (total > size) throw new Error("ohmail: the dropped file ran past its size");
      parts.push(bytes);
      if (answer.end) break;
    }
    if (total !== size) throw new Error("ohmail: the dropped file ended short of its size");
    return new File(parts as BlobPart[], name, type ? { type } : {});
  };
  return { name, size, type, state, read: () => (reading ??= readAll()) };
}

/**
 * Take the latest drop the shell holds: its files as lazy sources in drop order, or `null` when this
 * window is not armed, has no shell, or the shell holds nothing. A refused take is thrown.
 */
export async function takeDroppedFiles(): Promise<readonly DroppedSource[] | null> {
  if (!armed) return null;
  const shell = shellOf();
  if (!shell) return null;
  const answer = (await shell.invoke(DROPPED_FILES_TAKE_COMMAND)) as { drop?: unknown; files?: unknown } | null;
  if (answer === null || answer === undefined) return null;
  if (typeof answer.drop !== "string" || !Array.isArray(answer.files)) {
    throw new Error("ohmail: the shell's drop answer is not one this window reads");
  }
  const drop = answer.drop;
  return answer.files.map((raw, index) => sourceOf(shell, drop, index, raw));
}

/**
 * The desktop window's last word on a drop: one that carries files and that nothing took is
 * prevented, so WebKit inserts no path wherever it landed. It attaches nothing, and a file input
 * keeps its own drop.
 */
export function installFileDropGuard(target: Window): () => void {
  const onDrop = (e: DragEvent): void => {
    if (e.defaultPrevented || !dropCarriesFiles(e.dataTransfer)) return;
    const aimed = e.target as { tagName?: unknown; type?: unknown } | null;
    if (aimed?.tagName === "INPUT" && aimed.type === "file") return;
    e.preventDefault();
  };
  target.addEventListener("drop", onDrop);
  return () => target.removeEventListener("drop", onDrop);
}
