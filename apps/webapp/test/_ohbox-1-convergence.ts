/**
 * ONE MIRROR's LETTERS, for `cross-surface-convergence.test.tsx` and the Reads case moved beside it
 * (`cross-surface-convergence-reads.test.tsx`): share ohbox-1's helper (the join folds it). Moved word for word.
 */
import type { EngineMessage, Folder } from "@ohmail/wire";
import {
  MemoryMirrorStore,
  waterlineIdOf,
  type SyncChange,
} from "@ohmail/client-engine";

export const NOW = new Date("2026-08-31T08:01:00.000Z");
export const VIEW = { now: NOW, zone: "UTC" };

let seq = 0;

export function msg(o: {
  id: string;
  date: string;
  unread: boolean;
  folder?: string;
  lastReadAt?: string | null;
  threadId?: string;
  /** `setAt` where it matters: the badge counts what arrived after the pin went up. */
  triage?: { state: string; setAt?: string } | null;
}): EngineMessage {
  return {
    id: o.id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: o.threadId ?? null,
    messageIdHeader: null,
    subject: `Subject ${o.id}`,
    from: { name: o.id, address: `${o.id}@example.com` },
    to: [],
    cc: [],
    date: o.date,
    folder: (o.folder ?? "INBOX") as Folder,
    snippet: `snippet ${o.id}`,
    unread: o.unread,
    lastReadAt: o.lastReadAt ?? null,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: (o.triage ?? null) as EngineMessage["triage"],
    labels: [],
    remoteContent: "none",
    updatedAt: o.date,
  } as EngineMessage;
}

export async function mirrorOf(
  rows: EngineMessage[],
  waterline?: { view: "reads" | "receipts"; newestSeenId: string },
): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  /**
   * THE `message_state` RECORD RIDES WITH THE ROW, because the two are what the mirror really
   * holds and the pile selectors read DIFFERENT ones of them: `isResurfaced` reads the message's
   * `triage` projection, `parkedMessageIds` reads the state entities. A fixture carrying only
   * the projection is a mirror that cannot express "parked", and the disjointness this file
   * asserts would pass over a mailbox where nothing was ever parked.
   */
  const states: SyncChange[] = rows
    .filter((m) => m.triage != null)
    .map((m) => ({
      type: "message_state", op: "create", id: `st:${m.id}`, seq: ++seq, updatedAt: m.updatedAt,
      entity: {
        messageId: m.id,
        state: (m.triage as { state: string }).state,
        bubbleUpAt: null,
        setAt: (m.triage as { setAt?: string }).setAt ?? m.updatedAt,
        updatedAt: m.updatedAt,
      },
    })) as SyncChange[];
  await store.applyChanges([
    ...rows.map((m) => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
    ...states,
  ] as SyncChange[]);
  if (waterline) {
    await store.putLocal("view_meta", waterlineIdOf(waterline.view), {
      newestSeenId: waterline.newestSeenId,
    });
  }
  return store;
}

/** Newest first — `d(0)` is the newest, matching `messagesIn`'s date-descending order. */
export const d = (i: number): string => `2026-08-${String(30 - i).padStart(2, "0")}${"T"}09:00:00.000Z`;
