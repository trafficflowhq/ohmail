import { and, eq, sql, type SQL } from "drizzle-orm";
import { mailboxFolders, messageInstances } from "@trafficflow/db";
import { dialect } from "@trafficflow/db/dialect";
import {
  WATCHED_FOLDERS, epochOf, epochVerdict, isImapBoundExceeded, type FolderStatusAnswer,
} from "@trafficflow/core/adapters/imap";
import { IMAP_DOOR_DEADLINE_MS, isImapDoorTimeout, withinDoorBudget } from "./imap-door.js";
import { verdictFor } from "./imap-probe.js";
import type { ApiDeps } from "./deps.js";

/**
 * THE MAILBOX SELF-CHECK — one on-demand read per mailbox: for every folder the mirror reads
 * (its `mailbox_folders` rows), one STATUS against the store's count of instances under that
 * folder and the epoch the server states now. One connection, a per-folder deadline and one
 * whole-read budget that the dial and every folder spend. Read-only on the server and here: no
 * lease, no `ohmail/_meta`, no repair. It answers the same on an organizer and a reader.
 */

/** The whole read, dial included — the one budget every API-side dial runs under. */
export const MAILBOX_CHECK_BUDGET_MS = IMAP_DOOR_DEADLINE_MS;
/** One folder's STATUS. A server that stops answering costs this, then the connection. */
export const MAILBOX_CHECK_FOLDER_DEADLINE_MS = 5_000;
/** Folders asked in one read; the rest read `budget`. Above the passive-folder ceiling. */
export const MAILBOX_CHECK_FOLDERS_MAX = 512;
/** Kept back from every folder's deadline so the read ends inside its own budget. */
const MARGIN_MS = 250;
/** A folder is not asked with less room than this; it reads `budget` instead. */
const FOLDER_MIN_MS = 50;

/** Per folder, closed. The diagnostic leaf holds a copy; a test holds the two equal. */
export const MAILBOX_CHECK_FOLDER_CLASSES = [
  "in_step", "server_more", "mirror_more", "uidvalidity_changed", "unreadable",
] as const;
/** Why a folder could not be compared, closed. The first six are the folder's, the rest the dial's. */
export const MAILBOX_CHECK_UNREADABLE = [
  "timeout", "budget", "refused", "short_reply", "dropped", "auth", "connect", "tls", "busy",
  "no_login", "unknown",
] as const;

type CheckFolderClass = (typeof MAILBOX_CHECK_FOLDER_CLASSES)[number];
type CheckUnreadable = (typeof MAILBOX_CHECK_UNREADABLE)[number];

/** One folder's reading. `server`/`mirror` are message counts; the difference is theirs. */
type FolderCheck =
  | { folder: string; k: "in_step" | "server_more" | "mirror_more" | "uidvalidity_changed"; server: number; mirror: number }
  | { folder: string; k: "unreadable"; error: CheckUnreadable };

interface MailboxCheck {
  mailboxId: string;
  checkedAt: string;
  elapsedMs: number;
  /** The worst folder's class, in {@link MAILBOX_CHECK_FOLDER_CLASSES} order; `empty` with no folder. */
  verdict: CheckFolderClass | "empty";
  folders: FolderCheck[];
}

/** One folder as the store holds it: the epoch its cursor recorded, and instance counts by epoch. */
export interface MirrorFolder {
  folder: string;
  epoch: string | null;
  counts: ReadonlyMap<string, number>;
}

type Answer = FolderStatusAnswer | { k: "timeout" };

/**
 * THE COMPARISON, pure. A recorded epoch the server now contradicts is `uidvalidity_changed`;
 * otherwise the server's MESSAGES against the store's instances under the server's epoch. A
 * folder the server no longer has compares as zero there. A cold cursor (no epoch yet) is
 * compared by count, which is what it holds.
 */
export function compareFolder(m: MirrorFolder, a: Answer): FolderCheck {
  const folder = m.folder;
  const held = (epoch: string | null): number => m.counts.get(epoch ?? "") ?? 0;
  switch (a.k) {
    case "status": {
      if (!epochOf(a.uidValidity).known) return { folder, k: "unreadable", error: "short_reply" };
      if (epochVerdict(epochOf(m.epoch), epochOf(a.uidValidity)) === "stale") {
        return { folder, k: "uidvalidity_changed", server: a.messages, mirror: held(m.epoch) };
      }
      return byCount(folder, a.messages, held(a.uidValidity));
    }
    case "absent": return byCount(folder, 0, epochOf(m.epoch).known ? held(m.epoch) : 0);
    case "refused": return { folder, k: "unreadable", error: "refused" };
    case "short": return { folder, k: "unreadable", error: "short_reply" };
    case "dropped": return { folder, k: "unreadable", error: "dropped" };
    case "timeout": return { folder, k: "unreadable", error: "timeout" };
  }
}

function byCount(folder: string, server: number, mirror: number): FolderCheck {
  const k = server === mirror ? "in_step" : server > mirror ? "server_more" : "mirror_more";
  return { folder, k, server, mirror };
}

/** The worst folder's class; `empty` for a mailbox with no folder to compare. */
export function worstOf(folders: readonly FolderCheck[]): MailboxCheck["verdict"] {
  let worst = -1;
  for (const f of folders) worst = Math.max(worst, MAILBOX_CHECK_FOLDER_CLASSES.indexOf(f.k));
  return worst < 0 ? "empty" : MAILBOX_CHECK_FOLDER_CLASSES[worst]!;
}

/** A dial that never produced an adapter, as one closed class. */
export function dialClass(err: unknown): CheckUnreadable {
  if (isImapDoorTimeout(err)) return "timeout";
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "mailbox_busy") return "busy";
  if (code === "upstream_unavailable") return "no_login";
  if (code === "mailbox_host_refused" || code === "mailbox_port_refused") return "connect";
  const v = verdictFor(err);
  const c = v.verdict === "ok" ? "unknown" : v.code;
  return c === "auth" || c === "tls" || c === "timeout" || c === "connect" ? c : "unknown";
}

/** The folders the mirror reads, INBOX and the organized folders first, then by name. */
async function mirrorOf(deps: ApiDeps, accountId: string, mailboxId: string): Promise<MirrorFolder[]> {
  const rows = await deps.db.select({ folder: mailboxFolders.folder, epoch: mailboxFolders.uidvalidity })
    .from(mailboxFolders).where(eq(mailboxFolders.mailboxId, mailboxId));
  const n = dialect(deps.db).castInt(sql`count(*)`).mapWith(Number) as unknown as SQL<number>;
  const counted = await deps.db
    .select({ folder: messageInstances.folder, epoch: messageInstances.uidvalidity, n })
    .from(messageInstances)
    .where(and(eq(messageInstances.accountId, accountId), eq(messageInstances.mailboxId, mailboxId)))
    .groupBy(messageInstances.folder, messageInstances.uidvalidity);
  const byFolder = new Map<string, Map<string, number>>();
  for (const c of counted) {
    const inner = byFolder.get(c.folder) ?? new Map<string, number>();
    inner.set(String(c.epoch), Number(c.n));
    byFolder.set(c.folder, inner);
  }
  const rank = (f: string): number => {
    const i = (WATCHED_FOLDERS as readonly string[]).indexOf(f);
    return i < 0 ? WATCHED_FOLDERS.length : i;
  };
  return rows
    .map((r) => ({
      folder: r.folder,
      epoch: r.epoch == null ? null : String(r.epoch),
      counts: byFolder.get(r.folder) ?? new Map<string, number>(),
    }))
    .sort((a, b) => rank(a.folder) - rank(b.folder) || (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
}

/**
 * THE READ. The clock starts before the store read and every step spends it: the dial is raced
 * against what is left, each folder gets the smaller of its own deadline and what is left less a
 * margin, and a folder with no room left reads `budget` rather than being asked. A per-folder
 * miss retires the connection, so the folders after it read `dropped` at once.
 */
export async function selfCheckMailbox(
  deps: ApiDeps, accountId: string, mailboxId: string,
  opts: { budgetMs?: number; folderMs?: number } = {},
): Promise<MailboxCheck> {
  const budgetMs = opts.budgetMs ?? MAILBOX_CHECK_BUDGET_MS;
  const folderMs = opts.folderMs ?? MAILBOX_CHECK_FOLDER_DEADLINE_MS;
  const startedAt = Date.now();
  const left = (): number => budgetMs - (Date.now() - startedAt);
  const checkedAt = (deps.now?.() ?? new Date()).toISOString();
  const held = await mirrorOf(deps, accountId, mailboxId);
  const answers = new Map<string, Answer>();
  let fallback: CheckUnreadable = "budget";
  if (held.length > 0) {
    let dialled = false;
    try {
      await withinDoorBudget(deps, mailboxId, async (adapter) => {
        dialled = true;
        for (const f of held.slice(0, MAILBOX_CHECK_FOLDERS_MAX)) {
          const room = left() - MARGIN_MS;
          if (room < FOLDER_MIN_MS) break;
          try {
            answers.set(f.folder, await adapter.folderStatus(f.folder, Math.min(folderMs, room)));
          } catch (err) {
            if (!isImapBoundExceeded(err)) throw err;
            answers.set(f.folder, { k: "timeout" });
          }
        }
      }, { budgetMs: Math.max(1, left()) });
    } catch (err) {
      fallback = !dialled ? dialClass(err) : isImapDoorTimeout(err) ? "budget" : "dropped";
      deps.logger?.warn?.("mailbox_self_check_read_failed", { mailboxId, err });
    }
  }
  const folders = held.map((f): FolderCheck => {
    const a = answers.get(f.folder);
    return a === undefined ? { folder: f.folder, k: "unreadable", error: fallback } : compareFolder(f, a);
  });
  return {
    mailboxId, checkedAt, elapsedMs: Date.now() - startedAt, verdict: worstOf(folders), folders,
  };
}
