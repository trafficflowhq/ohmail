import type { ScreenerWaitingWire, UnscreenedWire } from "@ohmail/wire";
import { describe, expect, it } from "vitest";
import { MemoryMirrorStore, OhmailEngine, type EngineAdapter } from "../src/index.js";

/**
 * A WRITE THAT CHANGES NO RECORD MOVES NO VERSION. The queue page and the undecided-sender offer
 * are re-asked after drains; an answer equal to what the mirror holds must not bump the version or
 * notify, because every bump re-derives the lists on every client. A changed answer still writes.
 */

const NOW = new Date("2026-09-29T09:00:00.000Z");
const item = (id: string) => ({
  messageId: id, address: `${id}@example.test`, name: null, receivedAt: NOW.toISOString(),
  subject: `s ${id}`, snippet: "s", mailboxId: "mb",
});
const page = (ids: string[], total = ids.length): ScreenerWaitingWire =>
  ({ items: ids.map(item), nextCursor: null, total, inFlight: [] });
const offer = (groups: Array<[string, number]>): UnscreenedWire =>
  ({ groups: groups.map(([address, count]) => ({ address, count, newestAt: NOW.toISOString() })), total: groups.length, max: 200 });

function rig(queue: ScreenerWaitingWire[], offers: UnscreenedWire[]) {
  let q = 0;
  let o = 0;
  const adapter = {
    sync: async () => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: "c0", hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async () => ({ ok: true as const, changes: [] }),
    screenerWaiting: async () => queue[Math.min(q++, queue.length - 1)]!,
    unscreened: async () => offers[Math.min(o++, offers.length - 1)]!,
  } as unknown as EngineAdapter;
  const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => NOW, storePolicy: { mode: "full" } });
  let notifies = 0;
  engine.subscribe(() => { notifies += 1; });
  return { engine, notifies: () => notifies };
}

describe("an equal answer writes nothing", () => {
  it("two identical queue answers bump the version once; a changed answer bumps it again", async () => {
    const { engine, notifies } = rig([page(["a", "b"]), page(["a", "b"]), page(["a", "b", "c"])], [offer([])]);
    await engine.start();
    const v0 = engine.read().version();
    const n0 = notifies();
    await engine.refreshScreenerWaiting();
    const v1 = engine.read().version();
    expect(v1).toBeGreaterThan(v0);
    expect(notifies()).toBe(n0 + 1);
    await engine.refreshScreenerWaiting();
    expect(engine.read().version()).toBe(v1);
    expect(notifies()).toBe(n0 + 1);
    await engine.refreshScreenerWaiting();
    expect(engine.read().version()).toBeGreaterThan(v1);
    expect(notifies()).toBe(n0 + 2);
  });

  it("a queue answer that moves only its count still writes", async () => {
    const { engine } = rig([page(["a"], 5), page(["a"], 6)], [offer([])]);
    await engine.start();
    await engine.refreshScreenerWaiting();
    const v1 = engine.read().version();
    await engine.refreshScreenerWaiting();
    expect(engine.read().version()).toBeGreaterThan(v1);
  });

  it("two identical offers bump the version once; a changed offer bumps it again", async () => {
    const { engine, notifies } = rig([page([])],
      [offer([["a@x.test", 3]]), offer([["a@x.test", 3]]), offer([["a@x.test", 4]])]);
    await engine.start();
    const n0 = notifies();
    await engine.refreshUnscreened();
    const v1 = engine.read().version();
    expect(notifies()).toBe(n0 + 1);
    await engine.refreshUnscreened();
    expect(engine.read().version()).toBe(v1);
    expect(notifies()).toBe(n0 + 1);
    await engine.refreshUnscreened();
    expect(engine.read().version()).toBeGreaterThan(v1);
  });

  it("an offer that drops a group writes the removal", async () => {
    const { engine } = rig([page([])], [offer([["a@x.test", 3], ["b@x.test", 1]]), offer([["a@x.test", 3]])]);
    await engine.start();
    await engine.refreshUnscreened();
    const v1 = engine.read().version();
    await engine.refreshUnscreened();
    expect(engine.read().version()).toBeGreaterThan(v1);
    expect(engine.read().list("unscreened_sender_group").length).toBe(1);
  });

  it("holds on a runtime whose JSON replacer is not handed its holder (Hermes, measured on the phone)", async () => {
    /* The phone's runtime calls the replacer without its holder as `this`; an ignore keyed on
       `this` ignored nothing there, and every equal queue answer wrote. Driven here by withholding
       the holder the same way. */
    const real = JSON.stringify;
    JSON.stringify = ((v: unknown, r?: unknown, sp?: string | number) => (typeof r === "function"
      ? real(v, (k: string, x: unknown) => (r as (k: string, x: unknown) => unknown).call(undefined, k, x), sp)
      : real(v, r as never, sp))) as typeof JSON.stringify;
    try {
      const { engine, notifies } = rig([page(["a", "b"]), page(["a", "b"])], [offer([])]);
      await engine.start();
      await engine.refreshScreenerWaiting();
      const v1 = engine.read().version();
      const n1 = notifies();
      await engine.refreshScreenerWaiting();
      expect(engine.read().version(), "an equal answer wrote under a holder-less replacer").toBe(v1);
      expect(notifies()).toBe(n1);
    } finally {
      JSON.stringify = real;
    }
  });

  it("an equal first page keeps the walk's record, so a walk over pages already noted writes nothing", async () => {
    /* The phone walks every page after each ask; the ask used to drop the page row's walk record
       and the walk wrote it back page by page, each write a whole re-derivation. */
    const first: ScreenerWaitingWire = { items: ["a", "b"].map(item), nextCursor: "p2", total: 4, inFlight: [] };
    const second: ScreenerWaitingWire = { items: ["c", "d"].map(item), nextCursor: null, total: 4, inFlight: [] };
    const adapter = {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c0", hasMore: false, serverTime: NOW.toISOString() }),
      mutate: async () => ({ ok: true as const, changes: [] }),
      screenerWaiting: async (a?: { cursor?: string }) => (a?.cursor === "p2" ? second : first),
      unscreened: async () => offer([]),
    } as unknown as EngineAdapter;
    const engine = new OhmailEngine({ adapter, store: new MemoryMirrorStore(), now: () => NOW, storePolicy: { mode: "full" } });
    await engine.start();
    await engine.refreshScreenerWaiting();
    await engine.screenerWaitingPage(null);
    await engine.screenerWaitingPage("p2");
    const walked = engine.read().version();
    const pageRow = () => engine.read().list<{ id: string; walked?: unknown }>("screener_waiting").find((r) => r.id === "page");
    expect(pageRow()?.walked, "the walk was not noted: the arm measures nothing").toBeDefined();
    await engine.refreshScreenerWaiting();
    expect(engine.read().version(), "an equal ask dropped the walk record").toBe(walked);
    expect(pageRow()?.walked).toBeDefined();
    await engine.screenerWaitingPage(null);
    await engine.screenerWaitingPage("p2");
    expect(engine.read().version(), "a walk over noted pages wrote").toBe(walked);
  });
});
