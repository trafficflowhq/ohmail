import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { LegacyNewsRepair, WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import type { Logger } from "@trafficflow/core/mail";

/**
 * THE LEGACY NEWS REPAIR — a store a pre-0.22 build wrote still spells News `ohmail/Reads` on its
 * locators, instances and `folder_state` rows after the server rename. Ingest compared those names
 * as text, so every re-read of such a letter was a second copy, never the same letter: its filings,
 * deletes and read marks addressed a locator the server no longer resolves once News was renumbered.
 *
 * The organizer's, on every visit until the store is clean, before the cursor is built (so this
 * cycle's walk and filing read the repaired rows). Database only, content-matched, one bounded
 * chunk per visit under the visit's fenced group: see `DrizzleRepo.repairLegacyNews`. A letter with
 * no live copy left is kept and marked missing on the server, with an audit row; a later lane puts
 * it back. A reader never repairs. Runs only while the adapter says the pile lives at News with no
 * `ohmail/Reads` beside it (that folder folds first, `news-fold.ts`).
 */

/** Messages one visit repairs, in one short transaction; the rest wait for the re-kick. */
export const LEGACY_NEWS_REPAIR_PER_VISIT = 200;

/** The attach each connection was found clean under: a rename or merge there re-arms the check. */
const cleanAt = new WeakMap<MailboxAdapter, number>();

export interface NewsRepairDeps {
  repo: WorkerRepo;
  adapter: MailboxAdapter;
  accountId: string;
  mailboxId: string;
  /** The visit's fenced group: the repair and its audit rows commit together or not at all. */
  write: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T>;
  log?: Logger;
}

export type NewsRepairResult = { owesMore: boolean; repair: LegacyNewsRepair | null };

/** One chunk of the repair when it is owed; `{ owesMore: false, repair: null }`, and no statement, otherwise. */
export async function legacyNewsRepairPass(deps: NewsRepairDeps): Promise<NewsRepairResult> {
  const { repo, adapter, accountId, mailboxId, log } = deps;
  const gate = adapter.legacyNewsRepairGate?.() ?? null;
  if (gate === null || typeof repo.repairLegacyNews !== "function") return { owesMore: false, repair: null };
  if (cleanAt.get(adapter) === gate.attach) return { owesMore: false, repair: null };
  // A read first: a clean store writes nothing, so the known-set memo survives the check.
  if (typeof repo.hasLegacyNewsRows === "function" && !(await repo.hasLegacyNewsRows(accountId, mailboxId))) {
    cleanAt.set(adapter, gate.attach);
    return { owesMore: false, repair: null };
  }
  const repair = await deps.write(async (r) => {
    const out = await r.repairLegacyNews!(accountId, mailboxId, { limit: LEGACY_NEWS_REPAIR_PER_VISIT });
    if (out.examined > 0) {
      await r.recordAudit(accountId, "sync.legacy_news_repaired", {
        mailboxId, examined: out.examined, repointed: out.repointed, forgotten: out.forgotten,
        missing: out.missing.length, spellings: out.spellings, more: out.more,
      }, null);
    }
    for (const messageId of out.missing) {
      await r.recordAudit(accountId, "sync.message_missing", {
        mailboxId, messageId,
        reason: "the mail server holds no copy of this letter that ohmail knows of; the mirror keeps "
          + "its copy and the letter is marked missing on the server",
      }, null);
    }
    return out;
  });
  if (repair.skipped === undefined && repair.examined === 0) cleanAt.set(adapter, gate.attach);
  if (repair.examined > 0) {
    log?.info("legacy_news_repaired", {
      mailboxId, accountId, examined: repair.examined, repointed: repair.repointed, forgotten: repair.forgotten,
      missing: repair.missing.length, spellings: repair.spellings, more: repair.more,
    });
  }
  if (repair.missing.length > 0) {
    log?.warn("legacy_news_letters_missing", {
      mailboxId, accountId, missing: repair.missing.length,
      reason: "letters the store spelled the pre-0.22 way have no copy on the mail server that ohmail "
        + "knows of; they stay in the mirror, marked missing, and are not reaped",
    });
  }
  return { owesMore: repair.more, repair };
}
