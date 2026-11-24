import type { EngineMessage, EngineMutation } from "@ohmail/wire";
import { MemoryMirrorStore, MutationRejectedError, OhmailEngine, OUTBOX_TYPE } from "@ohmail/client-engine";
import { expect, it } from "vitest";

const now = new Date("2026-10-23T09:00:00.000Z");
const decision = {
  kind: "screener_decide", senderId: "one", decision: "no", dest: "screened", scope: "sender",
  confirmedIds: ["one", "two"], unsubscribeIds: ["one"],
} as const satisfies EngineMutation;

async function scene(offlineFirst = false, restore = false) {
  const store = new MemoryMirrorStore();
  await store.load();
  const sent: EngineMutation[] = [];
  const id = "restored";
  if (restore) {
    await store.commitLocal([{
      type: OUTBOX_TYPE, id, entity: { v: 3, id, key: id, at: now.getTime(), n: 0, mutation: decision },
    }], []);
  }
  await store.applyChanges(decision.confirmedIds.map((id, i) => ({
    type: "message", op: "create", seq: i + 1, id, updatedAt: now.toISOString(),
    entity: { id, folder: "ohmail/Screener", from: { address: "sender" + "@" + "example.invalid" }, unread: true } as EngineMessage,
  })));
  const engine = new OhmailEngine({
    store, now: () => now, outboxAutoReplay: false,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "2", hasMore: false, serverTime: now.toISOString(),
      }),
      fetchBody: async () => null,
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      mutate: async (wire) => {
        sent.push(wire);
        if (offlineFirst && sent.length === 1) {
          throw new MutationRejectedError("network failure", { code: "network", retryable: true });
        }
        return { changes: [], seq: null };
      },
    },
  });
  await engine.start();
  return { engine, id, sent, store };
}

it("sends the unsubscribe grant once and keeps the confirmed filing IDs in the outbox", async () => {
  const { engine, sent, store } = await scene(true);
  const result = await engine.mutate(decision);
  expect(result.status).toBe("queued");
  const queued = store.get<{ mutation: EngineMutation }>(OUTBOX_TYPE, result.id)?.mutation;
  expect(queued).toMatchObject({ confirmedIds: decision.confirmedIds });
  expect(queued).not.toHaveProperty("unsubscribeIds");
  expect((await engine.retryQueued(result.id))?.status).toBe("confirmed");
  expect(sent).toHaveLength(2);
  expect(sent[0]).toMatchObject(decision);
  expect(sent[1]).toMatchObject({ confirmedIds: decision.confirmedIds });
  expect(sent[1]).not.toHaveProperty("unsubscribeIds");
});

it("drops a legacy restored grant while replaying the confirmed filing IDs", async () => {
  const { engine, id, sent } = await scene(false, true);
  await engine.retryQueued(id);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ confirmedIds: decision.confirmedIds });
  expect(sent[0]).not.toHaveProperty("unsubscribeIds");
});
