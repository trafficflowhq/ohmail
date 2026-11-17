/**
 * THE READER'S ENTRY: a shell imports it, hands it today's parts, and puts the answer in `features.reader`. Made
 * once per shell (at module scope), so the column's component never changes identity and never mounts again.
 */
import type { PaneProps } from "../frame/contract.js";
import type { ReaderEntry } from "../host/index.js";
import { LetterActions } from "./actions/ActionBar.js";
import { PartsContext } from "./parts.js";
import type { ReaderParts } from "./ports.js";
import { Reader } from "./Reader.js";

export function readerEntry(parts: ReaderParts): ReaderEntry {
  function Reading(pane: PaneProps) {
    return (
      <PartsContext.Provider value={parts}>
        <Reader {...pane} />
      </PartsContext.Provider>
    );
  }
  function Actions({ messageId }: { readonly messageId: string }) {
    return (
      <PartsContext.Provider value={parts}>
        <LetterActions messageId={messageId} />
      </PartsContext.Provider>
    );
  }
  return { Reading, Actions };
}
