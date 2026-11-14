/**
 * THE READER'S MARK, through the one press seam: a letter's read state is its own confirmation on screen, so the
 * write says nothing; a refusal still speaks through the seam. The same mutation the shell's `markSeen` sends.
 */
import type { EngineMutation } from "@ohmail/wire";

/** The seam's own answer for a read-state write: whether the press stands. A reader's visit takes it as it is. */
export type PressMarkSeen = (
  ids: string[],
  unread: boolean,
  via?: "glance",
  readRow?: string,
) => Promise<boolean>;

/**
 * What of the press seam the mark takes: its one mutation door, narrowed to a letter's read state (`mark_seen`). The
 * seam is one (its door takes every mutation); a holder of this type sends nothing else through it.
 */
export interface MarkSeenSeam {
  readonly mutateAndReport: (
    mutation: Extract<EngineMutation, { kind: "mark_seen" }>,
    okSentence: string | null,
  ) => Promise<boolean>;
}

export function markSeenOver(press: MarkSeenSeam): PressMarkSeen {
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
