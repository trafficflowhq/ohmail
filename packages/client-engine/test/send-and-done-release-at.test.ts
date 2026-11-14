/**
 * SEND + DONE: THE ROW CARRIES THE INTENT, THE RELEASE IS READ AT THE RELEASE.
 *
 * `releasePlanAt` re-reads the source's row from the mirror it is handed and narrows it to the
 * members the press saw; the outbox row is written by pick (`section`, `source`, `messageIds`); an
 * older row carrying the press-time mutations is still a Send + Done and what it carried is never
 * dispatched.
 */
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, MutationRejectedError, OhmailEngine, OUTBOX_TYPE,
  applySendAndDone, asSendAndDoneIntent, intentOf, ohboxView, releasePlanAt, sendAndDonePlanFor,
  type EngineMessage, type EngineMutation, type EntityReader, type MutationResult,
} from "@ohmail/client-engine";
import { DEMO_NOW, FixturesAdapter } from "@ohmail/testing/adapter";

/** The fixture's ids, built from their numbers. */
const tid = (n: number): string => `T${n}`;

function mkMsg(p: Partial<EngineMessage> & { id: string }): EngineMessage {
  return {
    accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `s-${p.id}`, from: { name: "N", address: "n@example.invalid" },
    to: [], cc: [], date: "2026-08-01T09:00:00.000Z", arrivedAt: "2026-08-01T09:00:00.000Z",
    folder: "INBOX", snippet: "", unread: false, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-01T09:00:00.000Z",
    ...p,
  } as EngineMessage;
}
function worldOf(messages: EngineMessage[], version = 1): EntityReader {
  const by: Record<string, unknown[]> = { message: messages, message_state: [], thread: [] };
  return {
    list: <T,>(t: string) => (by[t] ?? []) as T[],
    get: <T,>(t: string, id: string) => (by[t] ?? []).find((e) => (e as { id?: string }).id === id) as T | undefined,
    entries: <T,>(t: string) => (by[t] ?? []).map((entity, i) => ({ id: (entity as { id?: string }).id ?? String(i), entity: entity as T, seq: i })),
    version: () => version,
  } as unknown as EntityReader;
}

describe("releasePlanAt", () => {
  it("narrows the row at the release to the members the press saw", () => {
    const pressed = worldOf([mkMsg({ id: "a1", threadId: tid(1), unread: true })]);
    const intent = intentOf(sendAndDonePlanFor(pressed, "a1")!, "a1");
    expect(intent).toEqual({ section: "new", source: "a1", messageIds: ["a1"] });
    const later = worldOf([
      mkMsg({ id: "a1", threadId: tid(1), unread: true }),
      mkMsg({ id: "a2", threadId: tid(1), unread: true, date: "2026-08-02T09:00:00.000Z" }),
    ], 7);
    const release = releasePlanAt(later, intent)!;
    expect(release.messageIds).toEqual(["a1"]);
    expect(release.mutations).toEqual([{ kind: "mark_seen", messageIds: ["a1"], unread: false }]);
    expect(release.undo).toEqual([{ kind: "mark_seen", messageIds: ["a1"], unread: true }]);
    expect(release.readAt).toBe(7);
  });

  it("is null when the source left the Ohbox, is already read, or shares no member with the press", () => {
    const intent = { section: "new" as const, source: "a1", messageIds: ["a1"] };
    expect(releasePlanAt(worldOf([mkMsg({ id: "a1", unread: true, folder: "ohmail/Receipts" as EngineMessage["folder"] })]), intent)).toBeNull();
    expect(releasePlanAt(worldOf([mkMsg({ id: "a1", unread: false })]), intent)).toBeNull();
    expect(releasePlanAt(worldOf([mkMsg({ id: "a1", unread: true })]), { ...intent, messageIds: ["zz"] })).toBeNull();
    expect(releasePlanAt(worldOf([mkMsg({ id: "a1", unread: true })]), intent)).not.toBeNull();
  });

  it("reads an older row's plan as an intent and keeps nothing it carried", () => {
    const old = {
      section: "new", messageIds: ["a1"],
      mutations: [{ kind: "move", messageId: "a1", folder: "ohmail/Receipts" }],
      undo: [{ kind: "mark_seen", messageIds: ["a1"], unread: true }],
    };
    expect(asSendAndDoneIntent(old)).toEqual({ section: "new", source: "a1", messageIds: ["a1"] });
    expect(asSendAndDoneIntent({ section: "elsewhere", messageIds: ["a1"] })).toBeUndefined();
    expect(asSendAndDoneIntent({ section: "new", messageIds: [] })).toBeUndefined();
    expect(asSendAndDoneIntent(null)).toBeUndefined();
  });
});

describe("the outbox row", () => {
  function engineOver(store: MemoryMirrorStore, net: { offline: boolean }, wire: EngineMutation[]): OhmailEngine {
    const inner = new FixturesAdapter({ now: () => DEMO_NOW });
    return new OhmailEngine({
      store, now: () => DEMO_NOW,
      adapter: {
        sync: inner.sync.bind(inner),
        fetchBody: inner.fetchBody.bind(inner),
        mutate: async (m: EngineMutation, o: { idempotencyKey: string }) => {
          if (m.kind === "mail_send" && net.offline) {
            throw new MutationRejectedError("network failure", { code: "network", retryable: true });
          }
          wire.push(m);
          return inner.mutate(m, o);
        },
      } as never,
    });
  }
  const sourceOf = (engine: OhmailEngine): string =>
    ohboxView(engine.read()).newForYou.find((m) => sendAndDonePlanFor(engine.read(), m.id) !== null)!.id;
  const reply = (inReplyTo: string): EngineMutation => ({ kind: "mail_send", inReplyTo, body: "ok" }) as unknown as EngineMutation;
  const outboxRows = (store: MemoryMirrorStore) => store.list<{ id: string; andDone?: Record<string, unknown> }>(OUTBOX_TYPE);

  it("carries the intent's three fields and nothing else, whatever the caller hands it", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    const engine = engineOver(store, { offline: true }, []);
    await engine.start();
    const src = sourceOf(engine);
    const release = sendAndDonePlanFor(engine.read(), src)!;
    // A caller spreading the whole read in: only the intent may reach the row.
    const queued = await engine.mutate(reply(src), { andDone: { ...release, source: src } as never });
    expect(queued.status).toBe("queued");
    const [row] = outboxRows(store);
    expect(Object.keys(row!.andDone ?? {}).sort(), "the row carries a plan, not an intent").toEqual(["messageIds", "section", "source"]);
    expect(engine.pendingMutations()[0]!.andDone).toEqual({ section: release.section, source: src, messageIds: release.messageIds });
  });

  it("an older row restored by this build releases by re-reading, and what it carried never reaches the wire", async () => {
    const store = new MemoryMirrorStore();
    await store.load();
    const first = engineOver(store, { offline: true }, []);
    await first.start();
    const src = sourceOf(first);
    const queued = await first.mutate(reply(src), { andDone: intentOf(sendAndDonePlanFor(first.read(), src)!, src) });
    const [row] = outboxRows(store);
    // The base's shape: no source, the press-time mutations — swapped for a move that must never run.
    const old = {
      section: "new", messageIds: [src],
      mutations: [{ kind: "move", messageId: src, folder: "ohmail/Receipts" }],
      undo: [{ kind: "mark_seen", messageIds: [src], unread: true }],
    };
    await store.commitLocal([{ type: OUTBOX_TYPE, id: row!.id, entity: { ...row, andDone: old } }], []);

    const wire: EngineMutation[] = [];
    const second = engineOver(store, { offline: false }, wire);
    await second.start();
    let late: MutationResult[] = [];
    for (let i = 0; i < 40 && !late.some((r) => r.key === queued.key); i++) {
      await new Promise((r) => setTimeout(r, 5));
      late = [...late, ...await second.flushPending()];
    }
    const mine = late.find((r) => r.key === queued.key);
    expect(mine?.status, "the restored send was not confirmed").toBe("confirmed");
    expect(mine?.andDone).toEqual({ section: "new", source: src, messageIds: [src] });
    const release = releasePlanAt(second.read(), mine!.andDone!)!;
    expect(await applySendAndDone(release, async (m) => (await second.mutate(m)).status !== "rolled_back")).toBe(true);
    expect(wire.filter((m) => m.kind === "move"), "a carried mutation was dispatched").toEqual([]);
    expect(wire.filter((m) => m.kind === "mark_seen")).toHaveLength(1);
    expect(wire.filter((m) => m.kind === "mail_send")).toHaveLength(1);
  });
});
