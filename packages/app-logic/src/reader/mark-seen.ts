/**
 * THE READER'S MARK, through the one press seam: a letter's read state is its own confirmation on screen, so the
 * write says nothing; a refusal still speaks through the seam. The same mutation the shell's `markSeen` sends.
 */
import type { ShellDispatch } from "../press/shell-dispatch.js";
import type { ReaderMarkSeen } from "../reading/reader-seen.js";

export function markSeenOver(press: Pick<ShellDispatch, "mutateAndReport">): ReaderMarkSeen {
  return (ids, unread, via, readRow) => {
    if (ids.length === 0) return Promise.resolve(false);
    return press.mutateAndReport(
      {
        kind: "mark_seen",
        messageIds: ids,
        unread,
        ...(via ? { via } : {}),
        ...(!unread && readRow !== undefined ? { readRow } : {}),
      },
      null,
    );
  };
}
