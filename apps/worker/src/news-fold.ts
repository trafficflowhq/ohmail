import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type { Logger } from "@trafficflow/core/mail";
import { assertMayWriteToMailbox, writeDoorOf, type MailboxWriteAuthority } from "./lease.js";

/**
 * THE NEWS FOLD — a legacy `ohmail/Reads` beside `ohmail/News` folded into News on any organizer
 * pass, not only at attach. That folder is re-made after the 0.22 rename by an older install,
 * another mail client or a server rule, and nothing reads it: the resolver prefers News and the
 * scan leaves ohmail's folders out. A sweep only, behind `ensureFolders`' lease-only door; the
 * folder's guarded DELETE stays with the attach. A reader never calls this.
 */

export interface NewsFoldDeps {
  adapter: MailboxAdapter;
  accountId: string;
  mailboxId: string;
  writeAuthority: MailboxWriteAuthority;
  log?: Logger;
}

export type NewsFoldResult = { moved: number; acted: "merged" | "none"; refused: string | null };

/** One fold when the last LIST named the old folder beside News; `null`, and no command, otherwise. */
export async function newsFoldPass(deps: NewsFoldDeps): Promise<NewsFoldResult | null> {
  const { adapter, accountId, mailboxId, log } = deps;
  if (adapter.foldLegacyNews === undefined || (adapter.legacyNewsBeside?.() ?? null) === null) return null;
  await assertMayWriteToMailbox(deps.writeAuthority, "folder_sweep");
  const out = await adapter.foldLegacyNews(writeDoorOf(deps.writeAuthority));
  log?.info("news_fold_ran", { mailboxId, accountId, moved: out.moved, acted: out.acted, refused: out.refused });
  return out;
}
