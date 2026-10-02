import { JUNK_BY_NAME, TRASH_BY_NAME } from "./imap-types.js";
import { PINNED_ROLE_NAMES } from "./special-use-names.js";

/** The provider folders ohmail decides a role for. Drafts is read-side only (never written). */
export type FolderRole = "sent" | "junk" | "trash" | "drafts";

/** One LIST entry as the decision reads it: the CANONICAL path and the server's own flags. */
export interface RoleFolder {
  path: string;
  flags?: ReadonlySet<string>;
}

/** What answered: the server's flag, the folder ohmail stored, one name, or nothing usable. */
export interface RoleDecision {
  path: string | null;
  by: "server" | "stored" | "name" | "ambiguous" | "none";
  /** Every folder the name tier matched — two or more is why `ambiguous` took none. */
  candidates: readonly string[];
}

const FLAG: Record<FolderRole, string> = {
  sent: "\\sent", junk: "\\junk", trash: "\\trash", drafts: "\\drafts",
};
/** A folder the server gave ANY role is never a name candidate for another one. */
const ANY_ROLE_FLAG = new Set(["\\sent", "\\junk", "\\trash", "\\drafts", "\\archive", "\\all", "\\flagged", "\\important"]);

const SENT_LEAF = /^sent( items| messages| mail)?$/i;
const BELT: Record<FolderRole, RegExp | null> = {
  sent: SENT_LEAF, junk: JUNK_BY_NAME, trash: TRASH_BY_NAME, drafts: null,
};

const NAMES: ReadonlyMap<string, FolderRole> = new Map(
  (Object.entries(PINNED_ROLE_NAMES) as [FolderRole, readonly string[]][])
    .flatMap(([role, names]) => names.map((n) => [n, role] as const)),
);

/** A name guess is made at top level or one level under a server prefix, never in a user's tree. */
const GUESS_PARENT = /^(inbox|\[gmail\]|\[google mail\])$/i;
const OHMAIL_SEGMENT = /(?:^|\/)ohmail(?:\/|$)/i;

function lowerFlags(f: RoleFolder): Set<string> {
  return new Set([...(f.flags ?? [])].map((x) => String(x).toLowerCase()));
}

function eligible(f: RoleFolder): boolean {
  const flags = lowerFlags(f);
  return !flags.has("\\noselect") && !flags.has("\\nonexistent") && !OHMAIL_SEGMENT.test(f.path);
}

/** The role this folder's NAME reads as, at guess depth — the pinned table, then our belts. */
export function nameRoleOf(path: string): FolderRole | null {
  const parts = path.split("/");
  if (parts.length > 2 || (parts.length === 2 && !GUESS_PARENT.test(parts[0]!))) return null;
  const leaf = parts[parts.length - 1]!;
  const folded = leaf.toLowerCase().replace(/‎/g, "").trim();
  const named = NAMES.get(folded);
  if (named) return named;
  for (const role of ["sent", "junk", "trash"] as const) {
    if (BELT[role]!.test(leaf)) return role;
  }
  return null;
}

/**
 * Which folder holds `role`, by a precedence ohmail owns rather than the IMAP library's: the
 * server's SPECIAL-USE flag; then the folder ohmail stored for the role at the last attach, so a
 * role never moves silently; then exactly one folder whose name reads as the role. Two name
 * matches take neither. `stored` must be canonical; an absent or unusable one is skipped.
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
  const candidates = unflagged
    .filter((f) => nameRoleOf(f.path) === role)
    .map((f) => f.path).sort();
  if (candidates.length === 1) return { path: candidates[0]!, by: "name", candidates };
  return { path: null, by: candidates.length > 1 ? "ambiguous" : "none", candidates };
}
