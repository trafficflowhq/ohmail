/**
 * HOW MANY MESSAGES A ROW STANDS FOR, and the sentence that says so.
 *
 * Seven lists drew `⤷ N` off `m.threadCount`, which is the DEMO world's field
 * (`EngineMessageExtras`) and is never set for real mail — so the capsule appeared in the
 * showcase and nowhere a person's own mailbox was. The engine answers it now
 * (`threadSizeIndex`: the server's thread length where the thread row has synced, the mirrored
 * members otherwise), and that answer WINS wherever it exists — the fixture's number survives
 * only in the demo, which has no mirror thread to count.
 */
import { heldUnpinned, type EngineMessage } from "@ohmail/client-engine";

/** What a row is handed: both props, or neither — a count without its words is a silent badge. */
export interface RowThreadProps {
  threadCount?: number;
  threadLabel?: string;
}

/** A conversation of one is not a conversation: no badge, and nothing said. */
export function rowThread(count: number, say: (n: number) => string): RowThreadProps {
  return count > 1 ? { threadCount: count, threadLabel: say(count) } : {};
}

/**
 * The row's own count: the mirror's derivation, else the demo world's own field. A row that stands
 * held (the engine's `heldUnpinned`: a held folder and no pin) opens the whole thread and asks for
 * the whole length; a pinned one, in its held folder or presented in INBOX, counts as placed.
 */
export function rowThreadOf(
  m: Pick<EngineMessage, "threadId"> & {
    folder?: EngineMessage["folder"]; triage?: { state?: string } | null; threadCount?: number;
  },
  of: ((threadId: string, held?: boolean) => number) | undefined,
  say: (n: number) => string,
): RowThreadProps {
  const held = heldUnpinned(m.folder, m.triage?.state);
  const derived = m.threadId != null && of ? of(m.threadId, held) : 0;
  return rowThread(derived > 1 ? derived : m.threadCount ?? 0, say);
}
