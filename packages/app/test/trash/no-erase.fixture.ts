/**
 * WHAT TRASH'S LIVE HOOK TAKES OF THE SEAM, WHERE THE COMPILER READS IT: each line is one `live.ts` might write over
 * the hook's own `args`, and each must be refused. A line that compiled would leave its expect-error unused, and this
 * file would not compile clean; `seat.test.tsx` compiles it under the options this folder is checked with and expects
 * it clean. Compiled, never run.
 */
import type { useTrashLive } from "@ohmail/app-logic/trash";

export const triedLines = (args: Parameters<typeof useTrashLive>[0]): unknown[] => [
  // @ts-expect-error the delete window's press is no member of what Trash reads of the seam
  args.press.deleting.remove({ id: "t1" }),
  // @ts-expect-error nor is the seam's raw dispatch
  args.press.dispatchPress({ kind: "message_delete", messageId: "t1" }),
  // @ts-expect-error the seam's one mutation door takes a letter's read state, and no delete
  args.press.mutateAndReport({ kind: "message_delete", messageId: "t1" }, null),
  // @ts-expect-error nor a move
  args.press.mutateAndReport({ kind: "move", messageId: "t1", folder: "Archive" }, null),
];
