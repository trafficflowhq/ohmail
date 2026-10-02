import { JUNK_BY_NAME, TRASH_BY_NAME } from "./imap-types.js";
import { PINNED_ROLE_NAMES } from "./special-use-names.js";

/** The provider folders ohmail decides a role for. Drafts is read-side only (never written). */
export type FolderRole = "sent" | "junk" | "trash" | "drafts";

/** One LIST entry as the decision reads it: the CANONICAL path and the server's own flags. */
export interface RoleFolder {
  path: string;
  flags?: ReadonlySet<string>;
}

/** What answered: the server's flag, the folder ohmail stored, a name, or nothing. */
export interface RoleDecision {
  path: string | null;
  by: "server" | "stored" | "name" | "none";
  /** Every folder the answering name tier matched; the first is the one taken. */
  candidates: readonly string[];
}

const FLAG: Record<FolderRole, string> = {
  sent: "\\sent", junk: "\\junk", trash: "\\trash", drafts: "\\drafts",
};
/** A folder the server gave ANY role is never a name candidate for another one. */
const ANY_ROLE_FLAG = new Set(["\\sent", "\\junk", "\\trash", "\\drafts", "\\archive", "\\all", "\\flagged", "\\important"]);

/** 0.25.8's belts: Sent on the canonical path, Junk and Trash on the leaf. */
const SENT_BY_NAME = /^(inbox\/)?sent( items| messages| mail)?$/i;
const BELT: Record<FolderRole, ((path: string) => boolean) | null> = {
  sent: (p) => SENT_BY_NAME.test(p),
  junk: (p) => JUNK_BY_NAME.test(leafOf(p)),
  trash: (p) => TRASH_BY_NAME.test(leafOf(p)),
  drafts: null,
};

const NAMES: ReadonlyMap<string, FolderRole> = new Map(
  (Object.entries(PINNED_ROLE_NAMES) as [FolderRole, readonly string[]][])
    .flatMap(([role, names]) => names.map((n) => [n, role] as const)),
);

/** A name guess is made at top level or one level under a server prefix, never in a user's tree. */
const GUESS_PARENT = /^(inbox|\[gmail\]|\[google mail\])$/i;
const OHMAIL_SEGMENT = /(?:^|\/)ohmail(?:\/|$)/i;

function leafOf(path: string): string {
  return path.split("/").pop() ?? path;
}

function lowerFlags(f: RoleFolder): Set<string> {
  return new Set([...(f.flags ?? [])].map((x) => String(x).toLowerCase()));
}

function eligible(f: RoleFolder): boolean {
  const flags = lowerFlags(f);
  return !flags.has("\\noselect") && !flags.has("\\nonexistent") && !OHMAIL_SEGMENT.test(f.path);
}

function atGuessDepth(path: string): boolean {
  const parts = path.split("/");
  return parts.length === 1 || (parts.length === 2 && GUESS_PARENT.test(parts[0]!));
}

/** The role the pinned table gives this folder's name — imapflow 1.5.0's fold — at guess depth. */
export function tableRoleOf(path: string): FolderRole | null {
  if (!atGuessDepth(path)) return null;
  return NAMES.get(leafOf(path).toLowerCase().replace(/‎/g, "").trim()) ?? null;
}

/** The role this folder's NAME reads as, at guess depth — the pinned table, then the belts. */
export function nameRoleOf(path: string): FolderRole | null {
  const tabled = tableRoleOf(path);
  if (tabled) return tabled;
  if (!atGuessDepth(path)) return null;
  for (const role of ["sent", "junk", "trash"] as const) if (BELT[role]!(path)) return role;
  return null;
}

/**
 * Which folder holds `role`, by a precedence ohmail owns rather than the IMAP library's: the
 * server's SPECIAL-USE flag; then the folder stored at the last attach, so a role never moves;
 * then a name, with 0.25.8's own tie-breaks so a first attach decides as it did — the pinned
 * table first by path (imapflow 1.5.0's sort), then the belts in LIST order.
 */
export function decideFolderRole(
  role: FolderRole, folders: readonly RoleFolder[], stored?: string | null,
): RoleDecision {
  const usable = folders.filter(eligible);
  const flagged = usable.filter((f) => lowerFlags(f).has(FLAG[role])).map((f) => f.path);
  if (flagged.length > 0) {
    const pick = stored != null && flagged.includes(stored)
      ? stored : [...flagged].sort((a, b) => a.localeCompare(b))[0]!;
    return { path: pick, by: "server", candidates: [] };
  }
  const unflagged = usable.filter((f) => ![...lowerFlags(f)].some((x) => ANY_ROLE_FLAG.has(x)));
  if (stored != null && unflagged.some((f) => f.path === stored)) {
    return { path: stored, by: "stored", candidates: [] };
  }
  const tabled = unflagged.filter((f) => tableRoleOf(f.path) === role).map((f) => f.path)
    .sort((a, b) => a.localeCompare(b));
  if (tabled.length > 0) return { path: tabled[0]!, by: "name", candidates: tabled };
  const belt = BELT[role];
  const belted = belt ? unflagged.filter((f) => atGuessDepth(f.path) && belt(f.path)).map((f) => f.path) : [];
  if (belted.length > 0) return { path: belted[0]!, by: "name", candidates: belted };
  return { path: null, by: "none", candidates: [] };
}
