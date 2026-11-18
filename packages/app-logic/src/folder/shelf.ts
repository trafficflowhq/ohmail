/**
 * THE RAIL'S FOLDER SHELF: the few folders the rail has room for. The pinned ones first, as they were pinned; then the
 * open one; then the ones used last; then the tree's first level, to {@link SHELF_SIZE} at most. All folders is a fold
 * in the rail under them, never a place. A folder is named `mailboxId|path`, as the device keeps it; the device's own
 * record of the pins and the recent ones is the seat's to keep (one row each in the stored keys), handed in here.
 */
import type { FolderEntity } from "@ohmail/wire";
import {
  FOLDER_FILTER_AT,
  folderLeafOf,
  folderMatches,
  folderTree,
  isFolderDescendant,
  visibleFolderRows,
  type FolderTreeRow,
} from "../lists/folders.js";

/** The folders the shelf shows at most. */
export const SHELF_SIZE = 7;
/** The folders used last that the device keeps, newest first. */
export const RECENT_SIZE = 12;

/** A folder's name on the device: its mailbox and its path. */
export function shelfKeyOf(folder: Pick<FolderEntity, "mailboxId" | "name">): string {
  return `${folder.mailboxId}|${folder.name}`;
}

export interface ShelfFacts {
  /** The pinned folders, in the order they were pinned. */
  readonly pinned: readonly string[];
  /** The folders used last (opened or moved into), newest first. */
  readonly recent: readonly string[];
  /** The folder that is open, if a folder is. */
  readonly open: string | null;
}

/** Every mailbox's tree rows, the mailboxes in the order the mirror lists them. */
function treeRows(folders: readonly FolderEntity[]): FolderTreeRow[] {
  const mailboxes: string[] = [];
  for (const f of folders) if (!mailboxes.includes(f.mailboxId)) mailboxes.push(f.mailboxId);
  return mailboxes.flatMap((id) => folderTree(folders.filter((f) => f.mailboxId === id)));
}

/** Every mailbox's folders as their tree, the mailboxes in the order the mirror lists them. */
export function treeOrder(folders: readonly FolderEntity[]): FolderEntity[] {
  return treeRows(folders).map((row) => row.folder);
}

/**
 * The shelf: pinned, the open one, the recent ones, then each mailbox's first level, each once, {@link SHELF_SIZE} at
 * most. The open folder always stands: while one is open the pins take one place less, unless it is one of them.
 */
export function shelfOf(folders: readonly FolderEntity[], facts: ShelfFacts): FolderEntity[] {
  const byKey = new Map(folders.map((f) => [shelfKeyOf(f), f] as const));
  const open = facts.open === null ? undefined : byKey.get(facts.open);
  const out: FolderEntity[] = [];
  const take = (key: string | null): void => {
    if (key === null || out.length >= SHELF_SIZE) return;
    const folder = byKey.get(key);
    if (folder !== undefined && !out.includes(folder)) out.push(folder);
  };
  const pinRoom = (): number => (open === undefined || out.includes(open) ? SHELF_SIZE : SHELF_SIZE - 1);
  for (const key of facts.pinned) if (out.length < pinRoom() || key === facts.open) take(key);
  take(facts.open);
  for (const key of facts.recent) take(key);
  for (const row of treeRows(folders)) if (row.depth === 0) take(shelfKeyOf(row.folder));
  return out;
}

/**
 * The recent folders after one was used: it comes first, once, and the list keeps {@link RECENT_SIZE}; a pinned folder,
 * or one already among the first four, leaves the list as it stands (a row that stands does not jump). Taking a pin
 * off is the seat's store's: the folder then goes first of the recent ones.
 */
export function usedNow(recent: readonly string[], key: string, pinned: readonly string[]): string[] {
  if (pinned.includes(key)) return [...recent];
  const at = recent.indexOf(key);
  if (at >= 0 && at < 4) return [...recent];
  return [key, ...recent.filter((k) => k !== key)].slice(0, RECENT_SIZE);
}

/** A row of All folders: the folder, how deep it lies, and whether folders lie in it. */
export interface FoldRow {
  readonly folder: FolderEntity;
  readonly depth: number;
  readonly branch: boolean;
}

/** One mailbox's part of All folders. */
export interface FoldGroup {
  readonly mailboxId: string;
  /** The mailbox's address, as the folder records it. */
  readonly mailbox: string;
  readonly rows: readonly FoldRow[];
}

/** All folders asks for a line that looks for a folder once there are more than this many. */
export const FIND_FROM = FOLDER_FILTER_AT;

/**
 * All folders as it stands: each mailbox's tree, a branch's folders only while it is opened (`opened` holds their
 * keys). While a name is typed, every folder whose path holds it, flat, the ones whose own name starts with it first.
 */
export function foldOf(
  folders: readonly FolderEntity[],
  opened: ReadonlySet<string>,
  find: string,
): FoldGroup[] {
  const looked = find.trim().toLowerCase();
  const mailboxes: string[] = [];
  for (const f of folders) if (!mailboxes.includes(f.mailboxId)) mailboxes.push(f.mailboxId);
  const groups: FoldGroup[] = [];
  for (const id of mailboxes) {
    const own = folders.filter((f) => f.mailboxId === id);
    const tree = folderTree(own);
    const branch = (path: string): boolean => own.some((f) => isFolderDescendant(f.name, path));
    let rows: FoldRow[];
    if (looked === "") {
      rows = visibleFolderRows(tree, (path) => opened.has(`${id}|${path}`), branch).map((row) => ({
        folder: row.folder,
        depth: row.depth,
        branch: branch(row.folder.name),
      }));
    } else {
      const hits = tree.filter((row) => folderMatches(row.folder.name, looked));
      const first = (f: FolderEntity) => (folderLeafOf(f.name).toLowerCase().startsWith(looked) ? 0 : 1);
      rows = [...hits]
        .sort((a, b) => first(a.folder) - first(b.folder))
        .map((row) => ({ folder: row.folder, depth: 0, branch: false }));
    }
    if (rows.length > 0) groups.push({ mailboxId: id, mailbox: own[0]!.mailbox, rows });
  }
  return groups;
}
