/**
 * THE WATERLINE MOVES ON LEAVING. The line is "new since the last visit": it holds still for the whole visit and moves
 * once, on the way out, in one anchored commit. The anchor is the newest item the visit showed; the flip set is the
 * unread ids from it down to the foot of the last screen that this visit read by the rule. A visit no hand drove
 * writes nothing. As today's two streams derive it (`ReadsView`, `ReceiptsView`) and the shell commits it
 * (`commitFeedSeen`).
 */

/** What a stream knows when it is left. */
export interface StreamLeaveState {
  /** A hand (or a press in the stream) drove it this visit. */
  readonly drove: boolean;
  /** The newest item shown this visit. */
  readonly newestSeenId: string | null;
  /** The last item on screen at the leave. */
  readonly bottomVisibleId: string | null;
  /** The visit read it (live, or by the rule while its body was not in) and it was not marked unread. */
  readonly read: (id: string) => boolean;
}

/** The one commit of a leave: `feed_mark_seen` with the line's new place and the ids it flips. */
export interface StreamLeaveCommit {
  readonly upToId: string;
  readonly messageIds: readonly string[];
}

/** The commit a leave writes, or null where it writes nothing. `order` is the stream's order, top to bottom. */
export function streamLeaveCommit(
  state: StreamLeaveState,
  order: readonly { readonly id: string; readonly unread: boolean }[],
): StreamLeaveCommit | null {
  if (!state.drove || !state.newestSeenId) return null;
  const a = order.findIndex((m) => m.id === state.newestSeenId);
  if (a < 0) return null;
  const b = state.bottomVisibleId ? order.findIndex((m) => m.id === state.bottomVisibleId) : -1;
  const end = b >= a ? b : a;
  return {
    upToId: state.newestSeenId,
    messageIds: order
      .slice(a, end + 1)
      .filter((m) => m.unread && state.read(m.id))
      .map((m) => m.id),
  };
}

/** A commit that flips nothing and leaves the line where it stands is not sent. */
export function leaveSaysSomething(commit: StreamLeaveCommit, heldUpToId: string | null): boolean {
  return commit.messageIds.length > 0 || heldUpToId !== commit.upToId;
}
