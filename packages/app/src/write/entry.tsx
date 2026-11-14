/**
 * THE SCREEN'S ENTRY: a shell imports it, hands it its editor, and registers the answer: `Letter` as the place
 * `write`'s reading column, `reply` in the reader's parts. Made once per shell (at module scope), so neither
 * component changes identity and neither mounts again.
 */
import type { PaneProps } from "../frame/contract.js";
import { useReplyVerbs, useWriting } from "./above.js";
import { Letter as LetterView } from "./Letter.js";
import { ReplySheet } from "./Reply.js";
import { WritePartsContext } from "./parts.js";
import type { WriteEntry, WriteParts } from "./ports.js";

export function writeEntry(parts: WriteParts): WriteEntry {
  function Letter(pane: PaneProps) {
    return (
      <WritePartsContext.Provider value={parts}>
        <LetterView {...pane} />
      </WritePartsContext.Provider>
    );
  }
  function Sheet(props: { readonly letters: readonly string[] }) {
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
  return { Letter, reply: { Sheet, useOpen, useVerbs: useReplyVerbs } };
}
