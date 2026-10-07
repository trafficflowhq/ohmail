import { isResurfaced, threadOf, type EngineMessage, type EntityReader } from "@ohmail/client-engine";

/**
 * THE CONVERSATION A PANEL SHOWS — read off the PRESENTED mirror, the reader the Ohbox rows come
 * from, so a reply the presentation holds (an undecided sender's mail still physically in INBOX, a
 * screened-out rule not yet carried out) is in no panel and no attachment ask. A message the
 * presentation does not hold (a History row, one inside its undo window) reads the raw mirror. The
 * phone reads both the same way (`live.ts`). Pins are `winningStates`' on either reader.
 */
export function conversationOnScreen(presented: EntityReader, raw: EntityReader, messageId: string): EngineMessage[] {
  return threadOf(presented.get<EngineMessage>("message", messageId) ? presented : raw, messageId);
}

/**
 * WHAT THE READER'S MARK AS READ TAKES — the unread members of the conversation on screen (the
 * opened message alone where there is none), minus a resurfaced pin (its own Done answers it) and
 * minus the armed read, which presents as read already. The bar's FACE is this set's emptiness and
 * the press writes exactly this set, so the two cannot disagree. Wired on the Ohbox only.
 */
export function conversationReadSet(
  presented: EntityReader, raw: EntityReader, messageId: string, armedId: string | null,
): string[] {
  const panels = conversationOnScreen(presented, raw, messageId);
  const opened = presented.get<EngineMessage>("message", messageId) ?? raw.get<EngineMessage>("message", messageId);
  const members = panels.length > 0 ? panels : opened ? [opened] : [];
  return members
    .filter((m) => m.unread === true && !isResurfaced(m) && m.id !== armedId)
    .map((m) => m.id);
}

/** Whole-mirror walks `createReadSetMemo` has made — what its ratchet counts per render. */
let walks = 0;
export const readSetWalks = (): number => walks;

/**
 * `conversationReadSet`, memoized per mirror version and (thread, opened message): the Ohbox's column
 * and the sheet ask it on every render, and `threadOf` walks the whole mirror, so a render whose
 * mirror has not moved does no second walk. Any version, reader or armed-read change empties it.
 */
export function createReadSetMemo(): (presented: EntityReader, raw: EntityReader, messageId: string, armedId: string | null) => string[] {
  let stamp: readonly unknown[] = [];
  const cache = new Map<string, string[]>();
  return (presented, raw, messageId, armedId) => {
    const next = [presented, raw, presented.version(), raw.version(), armedId];
    if (next.some((v, i) => v !== stamp[i])) {
      stamp = next;
      cache.clear();
    }
    const m = presented.get<EngineMessage>("message", messageId) ?? raw.get<EngineMessage>("message", messageId);
    const key = `${m?.threadId ?? ""}|${messageId}`;
    let set = cache.get(key);
    if (set === undefined) {
      walks += 1;
      set = conversationReadSet(presented, raw, messageId, armedId);
      cache.set(key, set);
    }
    return set;
  };
}
