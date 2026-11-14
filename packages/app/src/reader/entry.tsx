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

/**
 * The entry over parts a shell reads in each render: its doors change identity while they fetch, and a column whose
 * component is made once still draws the door as it stands now. `useParts` is a hook, called first in each render.
 */
export function readerEntryFrom(useParts: () => ReaderParts): ReaderEntry {
  function Reading(pane: PaneProps) {
    const parts = useParts();
    return (
      <PartsContext.Provider value={parts}>
        <Reader {...pane} />
      </PartsContext.Provider>
    );
  }
  function Actions({ messageId }: { readonly messageId: string }) {
    const parts = useParts();
    return (
      <PartsContext.Provider value={parts}>
        <LetterActions messageId={messageId} />
      </PartsContext.Provider>
    );
  }
  return { Reading, Actions };
}

/** The entry over parts that never change: a test's, a states page's. */
export function readerEntry(parts: ReaderParts): ReaderEntry {
  return readerEntryFrom(() => parts);
}
