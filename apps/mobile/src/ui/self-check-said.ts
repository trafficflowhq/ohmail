/**
 * WHAT "CHECK THIS MAILBOX" SAYS, per press — pure, so the node suite drives every arm (there is no
 * React Native renderer in this workspace). The sentence's parts are the desktop's own, narrowed in
 * `net/mailboxes.ts`; only the words are this phone's, and every join is the deck's.
 */
import { Copy } from "../copy";
import type { MailboxCheck, SelfCheckDiffer } from "../net/mailboxes";

export type SelfCheckPress = { k: "rest" } | { k: "busy" } | { k: "done"; check: MailboxCheck } | { k: "failed" };

export interface SelfCheckRowSaid {
  /** The sentence under the button, or null while nothing has been asked. */
  sentence: string | null;
  action: string;
  busy: boolean;
}

const item = (d: SelfCheckDiffer): string =>
  d.k === "server_more" ? Copy.selfCheckServerMore(d.folder, d.n)
    : d.k === "mirror_more" ? Copy.selfCheckMirrorMore(d.folder, d.n)
      : Copy.selfCheckRenumbered(d.folder);

const listOf = (items: string[], total: number): string =>
  (total > items.length ? Copy.selfCheckAndMore(items.join(", "), total - items.length) : items.join(", "));

function unreached(error: string): string {
  switch (error) {
    case "timeout": return Copy.selfCheckUnreachedTimeout;
    case "auth": return Copy.selfCheckUnreachedAuth;
    case "connect": return Copy.selfCheckUnreachedConnect;
    case "tls": return Copy.selfCheckUnreachedTls;
    case "busy": return Copy.selfCheckUnreachedBusy;
    case "no_login": return Copy.selfCheckUnreachedNoLogin;
    default: return Copy.selfCheckUnreachedOther;
  }
}

/** The sentence one answer says. */
export function selfCheckSentence(check: MailboxCheck): string {
  if (check.k === "refused") return Copy.selfCheckFailed;
  const said = check.said;
  switch (said.k) {
    case "in_step": return Copy.selfCheckInStep;
    case "empty": return Copy.selfCheckEmpty;
    case "unreached": return unreached(said.error);
    case "differs": {
      const unreadList = listOf(said.unread, said.unreadCount);
      if (said.differCount === 0) return Copy.selfCheckOnlyUnread(said.unreadCount, unreadList);
      const list = listOf(said.differ.map(item), said.differCount);
      return said.unreadCount === 0
        ? Copy.selfCheckDiffers(said.differCount, list)
        : Copy.selfCheckDiffersAndUnread(said.differCount, list, said.unreadCount, unreadList);
    }
  }
}

export function selfCheckRowSaid(p: SelfCheckPress): SelfCheckRowSaid {
  switch (p.k) {
    case "rest": return { sentence: null, action: Copy.selfCheckAction, busy: false };
    case "busy": return { sentence: null, action: Copy.selfCheckChecking, busy: true };
    case "done": return { sentence: selfCheckSentence(p.check), action: Copy.selfCheckAction, busy: false };
    case "failed": return { sentence: Copy.selfCheckFailed, action: Copy.selfCheckAction, busy: false };
  }
}
