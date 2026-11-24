/**
 * A WITHDRAWN SEND IS NOT A PENDING ONE. Cancel keeps the queued send's durable row, marked, until
 * the next boot drops it; the raw outbox reader counted the row without reading the mark, so a
 * cancelled send still read as "on its way" to the compose hold and the reply-lane promotion. Both
 * branches of the reader — the stamped cache and the plain read — are driven by a real withdrawal.
 * Mutation: the reader's `withdrawn` filter removed → cases 1 and 2 red.
 */
import type { EngineMutation } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, MutationRejectedError, OhmailEngine,
} from "@ohmail/client-engine";
import { sendPendingInDurableOutbox } from "@ohmail/app-logic/writing/mail-send";

const NOW = new Date("2026-09-27T09:00:00.000Z");

async function offlineEngine(): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  const engine = new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: "1", hasMore: false, serverTime: NOW.toISOString(),
      }),
      fetchBody: async () => null,
      mutate: async () => { throw new MutationRejectedError("network failure", { code: "network", retryable: true }); },
      // The server never saw the key, so a Cancel tombstones it (`SendService.withdraw`).
      withdrawSend: async () => ({ outcome: "withdrawn" as const }),
    } as never,
  });
  await engine.start();
  return engine;
}

const send: EngineMutation = {
  kind: "mail_send", inReplyTo: null, mailboxId: "mb", subject: "Invoice 12", body: "on its way",
  to: [{ name: null, address: "ada@fake.test" }], cc: [], bcc: [],
} as unknown as EngineMutation;

/** The same engine through a reader that has no stamp — the reader's uncached branch. */
const unstamped = (engine: OhmailEngine): OhmailEngine => ({
  read: () => {
    const r = engine.read();
    return { list: (t: string) => r.list(t) };
  },
} as unknown as OhmailEngine);

describe("a send cancelled while it waits on the outbox", () => {
  it("1 — the stamped reader stops calling it pending", async () => {
    const engine = await offlineEngine();
    const queued = await engine.mutate(send);
    expect(queued.status).toBe("queued");
    expect(sendPendingInDurableOutbox(engine, "compose"), "a queued send is not pending").toBe(true);

    expect(await engine.withdrawQueued(queued.key)).toBe("withdrawn");
    expect(sendPendingInDurableOutbox(engine, "compose"), "the cancelled send still reads as on its way").toBe(false);
  });

  it("2 — and so does the plain read", async () => {
    const engine = await offlineEngine();
    const queued = await engine.mutate(send);
    expect(sendPendingInDurableOutbox(unstamped(engine), "compose")).toBe(true);

    await engine.withdrawQueued(queued.key);
    expect(sendPendingInDurableOutbox(unstamped(engine), "compose"), "the cancelled send still reads as on its way").toBe(false);
  });

  it("CONTROL: a second send queued on the lane after the cancel is pending", async () => {
    const engine = await offlineEngine();
    const first = await engine.mutate(send);
    await engine.withdrawQueued(first.key);
    await engine.mutate({ ...(send as object), body: "written again" } as EngineMutation);
    expect(sendPendingInDurableOutbox(engine, "compose"), "the new send is not seen").toBe(true);
    expect(sendPendingInDurableOutbox(unstamped(engine), "compose")).toBe(true);
  });
});
