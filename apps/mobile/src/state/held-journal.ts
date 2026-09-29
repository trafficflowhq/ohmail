/**
 * THE HELD WINDOWS' ONE JOURNAL DOOR — the delete window and the routing window both keep their
 * presses as client-local rows in the account's mirror, through this door and no second one. The
 * window's door is synchronous and the mirror's write is not, so this answers from its own copy at
 * once and queues the writes in order behind it. Its "stored" is the COPY's answer: `landed` is the
 * disk's, and a window reads it before a press may offer Undo.
 */
import {
  ROUTING_INTENT_TTL_MS, ROUTING_JOURNAL_TYPE, type DurableWrite, type StorageDoor,
} from "@ohmail/client-engine";

/** How long a stranded press is still the reader's word — the engine outbox's horizon, imported. */
export const HELD_PRESS_TTL_MS = ROUTING_INTENT_TTL_MS;

/** The part of the account's mirror the journal lives in — the app hands its `SqlMirrorStore`. */
export interface HeldJournal {
  get<T = unknown>(type: string, id: string): T | undefined;
  commitLocal(
    puts: ReadonlyArray<{ type: string; id: string; entity: unknown }>,
    deletes: ReadonlyArray<{ type: string; id: string }>,
  ): Promise<void>;
}

export interface JournalDoor extends StorageDoor {
  /** The disk's answer for every write so far — `lost` when any of them did not land. */
  landed: () => Promise<DurableWrite>;
}

export function journalDoor(journal: HeldJournal): JournalDoor {
  const copy = new Map<string, string | null>();
  const last = new Map<string, Promise<DurableWrite>>();
  const write = (key: string, value: string | null): DurableWrite => {
    copy.set(key, value);
    const row = { type: ROUTING_JOURNAL_TYPE, id: key };
    const put = value === null ? journal.commitLocal([], [row]) : journal.commitLocal([{ ...row, entity: { value } }], []);
    last.set(key, put.then((): DurableWrite => "stored", (): DurableWrite => "lost"));
    return "stored";
  };
  return {
    get: (key) => {
      if (copy.has(key)) return copy.get(key) ?? null;
      const row = journal.get<{ value?: unknown }>(ROUTING_JOURNAL_TYPE, key);
      return typeof row?.value === "string" ? row.value : null;
    },
    set: (key, value) => write(key, value),
    remove: (key) => write(key, null),
    landed: async () => ((await Promise.all(last.values())).includes("lost") ? "lost" : "stored"),
  };
}
