import { JUNK_BY_NAME, TRASH_BY_NAME } from "./imap-types.js";
import { PINNED_ROLE_NAMES } from "./special-use-names.js";

/** The provider folders ohmail decides a role for. Drafts is read-side only (never written). */
export type FolderRole = "sent" | "junk" | "trash" | "drafts";

/** One LIST entry as the decision reads it: the CANONICAL path and the server's own flags. */
export interface RoleFolder {
  path: string;
  flags?: ReadonlySet<string>;
}

/**
 * What the session lets the decision read. `serverFlags`: honour LIST role attributes — only when the
 * session advertises SPECIAL-USE, XLIST or IMAP4rev2, imapflow 1.5.0's own test, so a server sending
 * them unasked (Exchange's shape) decides by name as 0.25.8 did. `guessParents`: canonical prefixes
 * the server's NAMESPACE announced, admitted beside the fixed ones.
 */
export interface RoleContext {
  serverFlags: boolean;
  guessParents?: readonly string[];
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

/** The folder with its role attributes removed — what a session without the capability says. */
function withoutRoleFlags(f: RoleFolder): RoleFolder {
  return { path: f.path, flags: new Set([...(f.flags ?? [])].filter((x) => !ANY_ROLE_FLAG.has(String(x).toLowerCase()))) };
}

/** imapflow 1.5.0's order for the folders it did not guess: segment by segment, `localeCompare`. */
function bySegments(a: string, b: string): number {
  const as = a.split("/"), bs = b.split("/");
  for (let i = 0; i < as.length; i++) {
    if (as[i] !== bs[i]) return as[i]!.localeCompare(bs[i] ?? "");
  }
  return a.localeCompare(b);
}

function eligible(f: RoleFolder): boolean {
  const flags = lowerFlags(f);
  return !flags.has("\\noselect") && !flags.has("\\nonexistent") && !OHMAIL_SEGMENT.test(f.path);
}

function atGuessDepth(path: string, parents: readonly string[] = []): boolean {
  if (!path.includes("/")) return true;
  const parent = path.slice(0, path.lastIndexOf("/"));
  if (!parent.includes("/") && GUESS_PARENT.test(parent)) return true;
  return parents.some((p) => p.toLowerCase() === parent.toLowerCase());
}

/** The role the pinned table gives this folder's name — imapflow 1.5.0's fold — at guess depth. */
export function tableRoleOf(path: string, parents: readonly string[] = []): FolderRole | null {
  if (!atGuessDepth(path, parents)) return null;
  return NAMES.get(leafOf(path).toLowerCase().replace(/‎/g, "").trim()) ?? null;
}

/** The role this folder's NAME reads as, at guess depth — the pinned table, then the belts. */
export function nameRoleOf(path: string, parents: readonly string[] = []): FolderRole | null {
  const tabled = tableRoleOf(path, parents);
  if (tabled) return tabled;
  if (!atGuessDepth(path, parents)) return null;
  for (const role of ["sent", "junk", "trash"] as const) if (BELT[role]!(path)) return role;
  return null;
}

/**
 * Which folder holds `role`, by a precedence ohmail owns rather than the IMAP library's: the
 * server's SPECIAL-USE flag; then the folder stored at the last attach, so a role never moves;
 * then a name, with 0.25.8's own tie-breaks so a first attach decides as it did — the pinned
 * table first by path, then the belts by path segment (both imapflow 1.5.0's sorts).
 */
export function decideFolderRole(
  role: FolderRole, folders: readonly RoleFolder[], stored: string | null | undefined, ctx: RoleContext,
): RoleDecision {
  const parents = ctx.guessParents ?? [];
  const usable = folders.map((f) => (ctx.serverFlags ? f : withoutRoleFlags(f))).filter(eligible);
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
  const tabled = unflagged.filter((f) => tableRoleOf(f.path, parents) === role).map((f) => f.path)
    .sort((a, b) => a.localeCompare(b));
  if (tabled.length > 0) return { path: tabled[0]!, by: "name", candidates: tabled };
  const belt = BELT[role];
  const belted = belt
    ? unflagged.filter((f) => atGuessDepth(f.path, parents) && belt(f.path)).map((f) => f.path).sort(bySegments)
    : [];
  if (belted.length > 0) return { path: belted[0]!, by: "name", candidates: belted };
  return { path: null, by: "none", candidates: [] };
}
