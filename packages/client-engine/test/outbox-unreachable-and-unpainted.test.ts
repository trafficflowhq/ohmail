import { describe, expect, it } from "vitest";
import {
  MemoryMirrorStore,
  MutationRejectedError,
  OhmailEngine,
  OUTBOX_TYPE,
  OUTBOX_UNREACHABLE_CEILING_MS,
  type EngineAdapter,
  type EngineMessage,
  type EngineMutation,
  type MirrorStore,
} from "@ohmail/client-engine";
import { DEMO_NOW, FixturesAdapter } from "@ohmail/testing/adapter";

/**
 * Two halves of DESKTOP-OUTBOX-IS-NOT-DURABLE that live in the engine every surface shares.
 *
 * 1. A verb the desktop's Cloud door keeps answering `offline_read_only` spends none of the
 *    give-up ceiling, so it waited for ever with nothing on screen. Past a day it moves to the
 *    unsaved-changes list; a younger one, and any other wait, stays queued.
 * 2. The desktop window's mirror is EMPTY when a relaunch restores the outbox, so a restored
 *    delete painted nothing and the message came back with the first drain. It is painted at the
 *    drain's settle once its row is there.
 */

const HOUR = 60 * 60 * 1000;
const UNREACHABLE = () => new MutationRejectedError("ohmail Cloud is out of reach", {
  status: 503, code: "offline_read_only", retryable: true,
});
const NETWORK = () => new MutationRejectedError("network failure", { code: "network", retryable: true });

function wire(inner: FixturesAdapter, fail: { next: (() => Error) | null }): EngineAdapter {
  return {
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: () => inner.fetchBody(),
    sync: (params) => inner.sync(params),
    async mutate(m: EngineMutation, o) {
      if (fail.next) throw fail.next();
      const out = await inner.mutate(m, o);
      return { changes: [], seq: out.seq };
    },
  };
}

describe("a verb waiting on an unreachable server is shown after a day", () => {
  async function queuedAt(ageMs: number, error: () => Error, transportIsUnreachable?: boolean) {
    let clock = DEMO_NOW.getTime();
    const fail = { next: null as (() => Error) | null };
    const engine = new OhmailEngine({
      adapter: wire(new FixturesAdapter(), fail), store: new MemoryMirrorStore(), now: () => new Date(clock),
      ...(transportIsUnreachable === undefined ? {} : { outboxTransportIsUnreachable: transportIsUnreachable }),
    });
    await engine.start();
    fail.next = error;
    const res = await engine.mutate({ kind: "mark_seen", messageIds: ["giulia"], unread: false });
    expect(res.status).toBe("queued");
    clock += ageMs;
    await engine.syncOnce();
    return engine;
  }

  it("past the ceiling it leaves the queue for the unsaved-changes list, under its original key", async () => {
    const engine = await queuedAt(OUTBOX_UNREACHABLE_CEILING_MS + HOUR, UNREACHABLE);
    expect(engine.pendingMutations()).toHaveLength(0);
    const shown = engine.abandoned();
    expect(shown).toHaveLength(1);
    expect(shown[0]!.mutation.kind).toBe("mark_seen");
  });

  it("inside the ceiling it stays queued and nothing is shown", async () => {
    const engine = await queuedAt(OUTBOX_UNREACHABLE_CEILING_MS - HOUR, UNREACHABLE);
    expect(engine.pendingMutations()).toHaveLength(1);
    expect(engine.abandoned()).toHaveLength(0);
  });

  it("a verb the network drops keeps waiting at any age — only the unreachable server is bounded", async () => {
    const engine = await queuedAt(OUTBOX_UNREACHABLE_CEILING_MS + HOUR, NETWORK);
    expect(engine.pendingMutations()).toHaveLength(1);
    expect(engine.abandoned()).toHaveLength(0);
  });

  /** The paired page: nothing but the wire between it and its host, so a dropped wire IS the host away. */
  it("where the transport is the server, a dropped wire past the day is shown too", async () => {
    const TIMEOUT = () => new MutationRejectedError("timed out", { code: "timeout", retryable: true });
    for (const error of [NETWORK, TIMEOUT]) {
      const engine = await queuedAt(OUTBOX_UNREACHABLE_CEILING_MS + HOUR, error, true);
      expect(engine.pendingMutations()).toHaveLength(0);
      expect(engine.abandoned()).toHaveLength(1);
    }
  });

  it("…and inside the day it waits", async () => {
    const engine = await queuedAt(OUTBOX_UNREACHABLE_CEILING_MS - HOUR, NETWORK, true);
    expect(engine.pendingMutations()).toHaveLength(1);
    expect(engine.abandoned()).toHaveLength(0);
  });

  it("control: said false, a dropped wire keeps waiting at any age", async () => {
    const engine = await queuedAt(OUTBOX_UNREACHABLE_CEILING_MS + HOUR, NETWORK, false);
    expect(engine.pendingMutations()).toHaveLength(1);
    expect(engine.abandoned()).toHaveLength(0);
  });
});

describe("a restored verb whose row was not yet in the mirror is painted when the row arrives", () => {
  /** A relaunched desktop window: an empty mirror holding only the previous window's outbox rows. */
  async function relaunchedWith(outbox: MirrorStore): Promise<{ engine: OhmailEngine; fail: { next: (() => Error) | null } }> {
    const store = new MemoryMirrorStore();
    const rows = outbox.entries<unknown>(OUTBOX_TYPE).map((e) => ({ type: OUTBOX_TYPE, id: e.id, entity: e.entity }));
    await store.commitLocal(rows, []);
    const fail = { next: UNREACHABLE as (() => Error) | null };
    const engine = new OhmailEngine({ adapter: wire(new FixturesAdapter(), fail), store, now: () => DEMO_NOW });
    return { engine, fail };
  }

  async function queuedDelete(): Promise<MirrorStore> {
    const fail = { next: null as (() => Error) | null };
    const store = new MemoryMirrorStore();
    const first = new OhmailEngine({ adapter: wire(new FixturesAdapter(), fail), store, now: () => DEMO_NOW });
    await first.start();
    fail.next = UNREACHABLE;
    expect((await first.mutate({ kind: "message_delete", messageId: "giulia" })).status).toBe("queued");
    return store;
  }

  it("the delete queued before the relaunch keeps the message off screen once the drain brings it", async () => {
    const { engine } = await relaunchedWith(await queuedDelete());
    await engine.hydrate();
    await engine.syncOnce();
    // The row IS in the mirror — the server never heard of the delete…
    expect(engine.store.get<EngineMessage>("message", "giulia")).toBeDefined();
    // …and the person's delete still stands on screen, waiting.
    expect(engine.read().get<EngineMessage>("message", "giulia")).toBeUndefined();
    expect(engine.pendingMutations()).toHaveLength(1);
  });

  it("control: with nothing queued, the same drain shows the message", async () => {
    const { engine } = await relaunchedWith(new MemoryMirrorStore());
    await engine.hydrate();
    await engine.syncOnce();
    expect(engine.read().get<EngineMessage>("message", "giulia")).toBeDefined();
  });

  it("once the server takes the delete, the message is gone from the mirror too", async () => {
    const { engine, fail } = await relaunchedWith(await queuedDelete());
    await engine.hydrate();
    await engine.syncOnce();
    fail.next = null;
    await engine.syncOnce();
    expect(engine.pendingMutations()).toHaveLength(0);
    expect(engine.read().get<EngineMessage>("message", "giulia")).toBeUndefined();
  });
});
