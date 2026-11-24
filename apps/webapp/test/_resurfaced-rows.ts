import type { EngineMessage, MessageStateDTO } from "@ohmail/wire";
import {
  resurfacedThreads,
  type EntityReader,
  type ResurfacedThreadRow,
} from "@ohmail/client-engine";

/**
 * THE ROWS A HARNESS HANDS `OhboxView`, BUILT BY THE ENGINE'S OWN SELECTOR.
 *
 * `OhboxView` takes rows now, not pinned messages. A helper that folded the messages itself would
 * be a second implementation of the fold, and the view would then be measured against a harness
 * that agrees with it by construction — so this stamps a `resurfaced` claim on the messages named
 * and asks `resurfacedThreads` the real question. `pinnedAt` defaults to the newest arrival in the
 * whole set, which means nothing counts as "since the pin" unless a caller says otherwise.
 */
export function pinnedRows(
  pinned: readonly EngineMessage[],
  others: readonly EngineMessage[] = [],
  pinnedAt?: string,
): ResurfacedThreadRow[] {
  const all = [...pinned, ...others];
  const newest = all.reduce((best, m) => {
    const t = Date.parse(m.date ?? m.arrivedAt ?? "");
    return Number.isNaN(t) || t < best ? best : t;
  }, 0);
  const setAt = pinnedAt ?? new Date(newest + 1000).toISOString();
  const claims: MessageStateDTO[] = pinned.map((m) => ({
    messageId: m.id, state: "resurfaced", bubbleUpAt: null, setAt, updatedAt: setAt,
  }));
  const byId = new Map(claims.map((c) => [c.messageId, c]));
  const messages = all.map((m) => {
    const c = byId.get(m.id);
    return c ? { ...m, triage: c } : m;
  });
  const reader = {
    list: <T,>(type: string) => (type === "message" ? messages : type === "message_state" ? claims : []) as T[],
    get: <T,>(type: string, id: string) =>
      (type === "message" ? messages.find((m) => m.id === id) : undefined) as T | undefined,
    entries: <T,>(type: string) =>
      (type === "message" ? messages : []).map((entity, i) => ({ id: entity.id, entity: entity as T, seq: i })),
    version: () => 1,
  } as unknown as EntityReader;
  return resurfacedThreads(reader);
}
