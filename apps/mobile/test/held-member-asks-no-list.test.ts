/**
 * A MEMBER THE PRESENTATION HOLDS BACK COSTS NO FILE LIST (PHONE-HELD-MEMBER-ATTACHMENT-LISTS-READ-THE-RAW-MIRROR).
 * The open asked the lists of the conversation off the RAW mirror while the panel draws the PRESENTED
 * one, so a held member (an undecided sender's mail still in INBOX) cost one list request nobody was
 * shown. The open now asks over the panel's members; a message the presentation does not hold keeps
 * the raw conversation, the panel's own fallback.
 */
import type { EngineMessage } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, OhmailEngine, type EntityReader, type SyncChange } from "@ohmail/client-engine";
import { liveActions } from "../src/state/live";

const NOW = new Date("2026-09-11T12:00:00.000Z");
const member = (id: string, hour: number): EngineMessage => ({
  id, accountId: "acct-1", mailboxId: "mb-1", threadId: "th-q", messageIdHeader: null,
  subject: "the poster", from: { name: "Ida", address: "ida@example.invalid" },
  to: [], cc: [], date: `2026-09-10T0${hour}:00:00.000Z`, folder: "INBOX", snippet: `text of ${id}`,
  unread: false, hasAttachments: true, attachmentCount: 1, sensitivity: {}, triage: null,
  labels: [], remoteContent: "none", updatedAt: "2026-09-10T09:00:00.000Z",
} as unknown as EngineMessage);

async function world(): Promise<{ engine: OhmailEngine; listed: string[] }> {
  const listed: string[] = [];
  const store = new MemoryMirrorStore();
  await store.load();
  const rows = [member("q0", 5), member("held", 6), member("q2", 8)];
  let seq = 0;
  await store.applyChanges(rows.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })) as SyncChange[]);
  const engine = new OhmailEngine({
    store, now: () => NOW,
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async (id: string) => ({ text: `text of ${id}`, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
      listAttachments: async (id: string) => { listed.push(id); return []; },
      fetchAttachment: async () => new Blob(["x"]),
    },
  } as never);
  return { engine, listed };
}

/** The presentation, as the world's projection holds a member back: the raw mirror less `held`. */
const without = (raw: EntityReader, id: string): EntityReader => new Proxy(raw, {
  get(target, prop, recv) {
    if (prop === "get") return <T>(type: string, key: string): T | undefined => (type === "message" && key === id ? undefined : target.get<T>(type, key));
    if (prop === "list") return <T>(type: string): T[] => target.list<T>(type).filter((m) => type !== "message" || (m as { id?: string }).id !== id);
    return Reflect.get(target, prop, recv);
  },
});

const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0)); };

describe("the open asks the lists of the conversation the panel shows", () => {
  it("a held member's list is not asked", async () => {
    const { engine, listed } = await world();
    const acts = liveActions({
      engine, toast: () => undefined, uuid: () => "00000000-0000-4000-8000-000000000001", zone: "UTC",
      presented: () => without(engine.read(), "held"),
    });
    await acts.openMessage("q2");
    await settle();
    expect([...listed].sort(), "a list was asked for a member the panel does not show").toEqual(["q0", "q2"]);
  });

  it("with nothing held back every member is asked (control)", async () => {
    const { engine, listed } = await world();
    const acts = liveActions({ engine, toast: () => undefined, uuid: () => "00000000-0000-4000-8000-000000000001", zone: "UTC" });
    await acts.openMessage("q2");
    await settle();
    expect([...listed].sort()).toEqual(["held", "q0", "q2"]);
  });

  it("a message the presentation does not hold keeps the raw conversation, the panel's fallback", async () => {
    const { engine, listed } = await world();
    const acts = liveActions({
      engine, toast: () => undefined, uuid: () => "00000000-0000-4000-8000-000000000001", zone: "UTC",
      presented: () => without(engine.read(), "q2"),
    });
    await acts.openMessage("q2");
    await settle();
    expect([...listed].sort()).toEqual(["held", "q0", "q2"]);
  });
});
