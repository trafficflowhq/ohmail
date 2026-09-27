/**
 * THE MAILBOX SELF-CHECK, AS A SURFACE READS IT. The engine's `GET /mailboxes/:id/self-check`
 * answers one reading per folder the mirror reads; this narrows that wire into a closed shape and
 * says what the pane's one sentence is made of. The pane keeps folder names (they are the
 * person's own, on their own screen); the diagnostic file keeps only hashes and classes.
 * No import here reaches the network or the store.
 */

/** Copies of the engine's closed sets (`packages/api/src/mailbox-self-check.ts`); a test holds them equal. */
export const SELF_CHECK_FOLDER_CLASSES = [
  "in_step", "server_more", "mirror_more", "uidvalidity_changed", "unreadable",
] as const;
export const SELF_CHECK_UNREADABLE = [
  "timeout", "budget", "refused", "short_reply", "dropped", "auth", "connect", "tls", "busy",
  "no_login", "unknown",
] as const;
/** Folders one reading may carry — the engine's `MAILBOX_CHECK_FOLDERS_MAX`. */
export const SELF_CHECK_FOLDERS_MAX = 512;
/** Folder names one sentence names before it says how many more. */
export const SELF_CHECK_NAMES_SHOWN = 6;

export type SelfCheckFolderClass = (typeof SELF_CHECK_FOLDER_CLASSES)[number];
export type SelfCheckUnreadable = (typeof SELF_CHECK_UNREADABLE)[number];
export type SelfCheckVerdict = SelfCheckFolderClass | "empty";

export type SelfCheckFolder =
  | { folder: string; k: Exclude<SelfCheckFolderClass, "unreadable">; server: number; mirror: number }
  | { folder: string; k: "unreadable"; error: SelfCheckUnreadable };

export interface SelfCheck {
  mailboxId: string;
  checkedAt: string | null;
  elapsedMs: number | null;
  verdict: SelfCheckVerdict;
  folders: SelfCheckFolder[];
}

const FOLDER_MAX_CHARS = 1024;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;
const count = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);
const member = <T extends string>(set: readonly T[], v: unknown): T | null =>
  (typeof v === "string" && (set as readonly string[]).includes(v) ? (v as T) : null);

/**
 * The wire, narrowed. An entry outside the closed sets or with a count that is not one is kept as
 * `unreadable`/`unknown` rather than dropped, so a folder is never silently left out of a sentence.
 * The verdict is re-derived from the folders, never trusted from the wire.
 */
export function readSelfCheck(wire: unknown): SelfCheck | null {
  if (typeof wire !== "object" || wire === null) return null;
  const w = wire as Record<string, unknown>;
  if (typeof w.mailboxId !== "string" || w.mailboxId === "" || !Array.isArray(w.folders)) return null;
  const folders: SelfCheckFolder[] = [];
  for (const raw of w.folders.slice(0, SELF_CHECK_FOLDERS_MAX)) {
    const f = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    if (typeof f.folder !== "string" || f.folder === "" || f.folder.length > FOLDER_MAX_CHARS) continue;
    const k = member(SELF_CHECK_FOLDER_CLASSES, f.k);
    const server = count(f.server);
    const mirror = count(f.mirror);
    if (k !== null && k !== "unreadable" && server !== null && mirror !== null) {
      folders.push({ folder: f.folder, k, server, mirror });
    } else {
      folders.push({ folder: f.folder, k: "unreadable", error: k === "unreadable" ? member(SELF_CHECK_UNREADABLE, f.error) ?? "unknown" : "unknown" });
    }
  }
  let worst = -1;
  for (const f of folders) worst = Math.max(worst, SELF_CHECK_FOLDER_CLASSES.indexOf(f.k));
  return {
    mailboxId: w.mailboxId,
    checkedAt: typeof w.checkedAt === "string" && ISO_RE.test(w.checkedAt) ? w.checkedAt : null,
    elapsedMs: count(w.elapsedMs),
    verdict: worst < 0 ? "empty" : SELF_CHECK_FOLDER_CLASSES[worst]!,
    folders,
  };
}

/** One differing folder as a sentence names it: its name, its class and the difference. */
export interface SelfCheckDiffer { folder: string; k: "server_more" | "mirror_more" | "uidvalidity_changed"; n: number }

/**
 * WHAT THE ONE SENTENCE SAYS. `in_step` and `empty` are whole sentences. `unreached` is every
 * folder unreadable — the server, not a folder, could not be read — with the first folder's class.
 * `differs` lists the differing folders (at most {@link SELF_CHECK_NAMES_SHOWN}; `differCount` is all
 * of them) and the folders that could not be read; `differ` may be empty when only those are.
 */
export type SelfCheckSaid =
  | { k: "in_step" }
  | { k: "empty" }
  | { k: "unreached"; error: SelfCheckUnreadable }
  | { k: "differs"; differ: SelfCheckDiffer[]; differCount: number; unread: string[]; unreadCount: number };

export function selfCheckSaid(c: SelfCheck): SelfCheckSaid {
  if (c.folders.length === 0) return { k: "empty" };
  const differ: SelfCheckDiffer[] = [];
  const unread: string[] = [];
  for (const f of c.folders) {
    if (f.k === "unreadable") unread.push(f.folder);
    else if (f.k !== "in_step") differ.push({ folder: f.folder, k: f.k, n: Math.abs(f.server - f.mirror) });
  }
  if (differ.length === 0 && unread.length === 0) return { k: "in_step" };
  if (differ.length === 0 && unread.length === c.folders.length) {
    const first = c.folders[0]!;
    return { k: "unreached", error: first.k === "unreadable" ? first.error : "unknown" };
  }
  return {
    k: "differs",
    differ: differ.slice(0, SELF_CHECK_NAMES_SHOWN), differCount: differ.length,
    unread: unread.slice(0, SELF_CHECK_NAMES_SHOWN), unreadCount: unread.length,
  };
}
