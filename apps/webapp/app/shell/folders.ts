/**
 * THE FOLDER TREE — pure derivations for the rail's Folders group and every other surface that
 * lists the mailbox's own folders (FOLDERS-SPEC.md §14/§15; the clickable prototype is the
 * interaction reference and these mirror its verified helpers one for one).
 *
 * Everything here is derived per render from the mirror's `folder` entities and messages —
 * no stored tree, no cached counts. The server owns the hierarchy (it is the IMAP hierarchy);
 * the canonical `/`-joined path is the one spelling everything joins on.
 */

import type { EngineMessage, FolderEntity } from "@ohmail/client-engine";

/** The last path segment — what a tree row shows for its label. */
export function folderLeafOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The parent path, or `null` for a root. */
export function folderParentOf(path: string): string | null {
  const i = path.lastIndexOf("/");
  return i === -1 ? null : path.slice(0, i);
}

/** Is `path` strictly inside `of`'s subtree? */
export function isFolderDescendant(path: string, of: string): boolean {
  return path.startsWith(of + "/");
}

/**
 * Above this many ROOT folders a list stops rendering whole: type-to-filter + the first
 * {@link FOLDER_FILTER_AT} roots + a "Show all N…" expander whose full list scrolls in its own
 * region (spec §15 — the 240-root mailbox decision).
 */
export const FOLDER_FILTER_AT = 12;

export interface FolderTreeRow {
  folder: FolderEntity;
  /** 0 for a root; children indent one step under their parent. */
  depth: number;
}

/**
 * One mailbox's folders as the tree they already are on the server: parents before children,
 * SIBLINGS ALPHABETICAL — numeric-aware, case-insensitive (`"Steuern 2009"` before
 * `"Steuern 2010"`). At hundreds of folders the alphabet is the only order a user can predict,
 * and the order a LIST response arrives in is not one the user chose (spec §15, decided).
 *
 * A path whose parent row does not exist renders as a ROOT — IMAP allows children of
 * non-existent mailboxes, and the passive read keeps whatever shape the server reports.
 */
export function folderTree(folders: readonly FolderEntity[]): FolderTreeRow[] {
  const all = [...folders].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  const names = new Set(all.map((f) => f.name));
  const out: FolderTreeRow[] = [];
  const walk = (f: FolderEntity, depth: number): void => {
    out.push({ folder: f, depth });
    for (const c of all) {
      if (folderParentOf(c.name) === f.name) walk(c, depth + 1);
    }
  };
  for (const f of all) {
    const p = folderParentOf(f.name);
    if (p === null || !names.has(p)) walk(f, 0);
  }
  return out;
}

/**
 * FIRST LEVEL ONLY BY DEFAULT — the OPENED-set walk (spec §15). A branch renders its children
 * only when the user has opened it, and the state is a set of opened keys rather than a
 * closed-set: the default needs no per-folder seeding (a folder never touched has no entry
 * anywhere), and a branch the user opens stays open.
 */
export function visibleFolderRows(
  tree: readonly FolderTreeRow[],
  isOpen: (path: string) => boolean,
  hasChildren: (path: string) => boolean,
): FolderTreeRow[] {
  const out: FolderTreeRow[] = [];
  let hideUnder: string | null = null;
  for (const row of tree) {
    if (hideUnder !== null) {
      if (isFolderDescendant(row.folder.name, hideUnder)) continue;
      hideUnder = null;
    }
    out.push(row);
    if (hasChildren(row.folder.name) && !isOpen(row.folder.name)) hideUnder = row.folder.name;
  }
  return out;
}

/**
 * Per-folder unread, ONE pass over the mirror — the derivation tag counts already use, and the
 * spec's "no server-side count column" decision (§4): a stored count is a cache that lies
 * during sync, and the mirror holds every header. Keys are `mailboxId|path`, because folders
 * are mailbox-scoped and two mailboxes may both have a `Projects`.
 */
export function folderUnreadCounts(messages: readonly EngineMessage[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const m of messages) {
    if (!m.unread) continue;
    const key = `${m.mailboxId}|${m.folder}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/**
 * A COLLAPSED parent's badge: its own unread PLUS every hidden descendant's — collapsing must
 * never hide unread truth (spec §15, decided; the rail's counts are the product's honesty
 * surface). Expanded, every folder shows its own count again, so the total is counted exactly
 * once whichever way the branch stands.
 */
export function folderUnreadDeep(
  mailboxId: string,
  path: string,
  counts: ReadonlyMap<string, number>,
  folders: readonly FolderEntity[],
): number {
  let n = counts.get(`${mailboxId}|${path}`) ?? 0;
  for (const f of folders) {
    if (f.mailboxId === mailboxId && isFolderDescendant(f.name, path)) {
      n += counts.get(`${mailboxId}|${f.name}`) ?? 0;
    }
  }
  return n;
}

/**
 * The ONE filter predicate every folder filter uses: a case-insensitive substring of the FULL
 * canonical path — which contains the leaf, so leaf queries match, and path queries like
 * `"projects/"` reach children a leaf-only match would miss (spec §15; the prototype watched a
 * leaf-only mutation of this go red).
 */
export function folderMatches(path: string, query: string): boolean {
  return path.toLowerCase().includes(query.toLowerCase());
}
