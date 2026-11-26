/**
 * THE SCREEN'S ENTRY: a shell imports it, hands it its editor, and registers the answer: `Letter` as the place
 * `write`'s reading column, `reply` in the reader's parts. Made once per shell (at module scope), so neither
 * component changes identity and neither mounts again.
 */
import type { PaneProps } from "../frame/contract.js";
import { useReplyVerbs, useWriting } from "./above.js";
import { lazyView } from "../frame/lazy-view.js";
import { ReplySheet } from "./Reply.js";
import { WritePartsContext } from "./parts.js";
import type { WriteEntry, WriteParts } from "./ports.js";

const loadLetter = () => import("./Letter.js").then(({ Letter }) => ({ default: Letter }));
const LetterView = lazyView(loadLetter);
export const preloadLetter = LetterView.preload;

export function writeEntry(parts: WriteParts): WriteEntry {
  function Letter(pane: PaneProps) {
    return (
      <WritePartsContext.Provider value={parts}>
        <LetterView {...pane} />
      </WritePartsContext.Provider>
    );
  }
  function Sheet(props: { readonly letters: readonly string[]; readonly keysHere?: boolean }) {
    return (
      <WritePartsContext.Provider value={parts}>
        <ReplySheet {...props} />
      </WritePartsContext.Provider>
    );
  }
  /** Reply, Reply all and Forward open the one composition's reply on that letter. */
  function useOpen() {
    const writing = useWriting();
    return (messageId: string, how: "reply" | "reply_all" | "forward"): void => {
      if (how === "forward") writing.openForward(messageId);
      else writing.openReply(messageId, how === "reply_all");
    };
  }
  /**
   * Draft reply opens the reply on that letter (keeping the audience its editor already holds) and asks the drafter,
   * as a list's row answers it (`answerThrough`); null where the composition has no drafter.
   */
  function useDraft() {
    const writing = useWriting();
    if (!writing.draftReply.offered) return null;
    return (messageId: string): void => {
      writing.openReply(messageId, writing.replyTo === messageId && writing.replyAll);
      writing.draftReply.open(messageId);
    };
  }
  function useTarget() {
    return useWriting().reply?.messageId ?? null;
  }
  function useSendPhase() {
    const writing = useWriting();
    return (lane: string) => writing.replySendState(lane).phase;
  }
  return { Letter, reply: { Sheet, useTarget, useSendPhase, useOpen, useVerbs: useReplyVerbs, useDraft } };
}
