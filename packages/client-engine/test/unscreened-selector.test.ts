import { afterEach, describe, expect, it, vi } from "vitest";
import { OhmailEngine, UNSCREENED_REASK_MS } from "../src/engine.js";
import { unscreenedGroups, unscreenedTotalIsFloor, unscreenedTotalOf } from "../src/selectors.js";
import type { EngineAdapter, UnscreenedGroupWire, UnscreenedWire } from "../src/adapters/adapter.js";
import type { EngineMessage, Folder, SyncChange } from "../src/types.js";

/**
 * "N MESSAGES FROM SENDERS YOU HAVE NOT DECIDED ABOUT" — WHAT THE CLIENT MAY SAY ABOUT IT.
 *
 * The set is a SERVER derivation: membership is what the ARRIVAL GATE would answer for each
 * message, over rules and contacts `/sync` carries only part of. So the client's whole job is to
 * hold the door's answer without improving on it — the headline number is the server's, a refresh
 * REPLACES the set rather than merging into it, and a door that cannot answer leaves no row at all
 * rather than a confident zero.
 */

const NOW = new Date("2026-09-22T09:00:00Z");
const ARRIVED = "2024-03-01T08:00:00.000Z";

const group = (o: { address: string; count: number; newestAt?: string }): UnscreenedGroupWire => ({
  newestAt: ARRIVED, ...o,
});

/** A door that answers `unscreened` from a script and records every press. */
function doorWith(answers: UnscreenedWire[]): {
  adapter: EngineAdapter; presses: Array<readonly string[] | undefined>;
} {
  const presses: Array<readonly string[] | undefined> = [];
  let i = 0;
  const adapter = {
    sync: async () => ({
      changes: { creates: [], updates: [], moves: [], deletes: [] },
      cursor: null, hasMore: false, serverTime: NOW.toISOString(),
    }),
    mutate: async () => ({ ok: true as const, changes: [] }),
    unscreened: async () => answers[Math.min(i++, answers.length - 1)]!,
    screenUnscreened: async (addresses?: readonly string[]) => {
      presses.push(addresses);
      return { screened: [], total: 5 };
    },
  } as unknown as EngineAdapter;
  return { adapter, presses };
}

const engineOn = async (adapter: EngineAdapter): Promise<OhmailEngine> => {
  const engine = new OhmailEngine({ adapter, now: () => NOW });
  await engine.start();
  return engine;
};

describe("the undecided-sender offer, client side", () => {
  it("holds the door's groups largest first, and takes the total from the server", async () => {
    const { adapter } = doorWith([{
      groups: [group({ address: "small@x.test", count: 2 }), group({ address: "big@x.test", count: 9 })],
      total: 11,
      max: 200,
    }]);
    const engine = await engineOn(adapter);
    await engine.refreshUnscreened();

    const rows = unscreenedGroups(engine.read());
    expect(rows.map((r) => [r.id, r.count])).toEqual([["big@x.test", 9], ["small@x.test", 2]]);
    expect(unscreenedTotalOf(engine.read())).toBe(11);
    expect(unscreenedTotalIsFloor(engine.read()), "a door that says nothing is read as whole").toBe(false);
    expect(rows[0]!.newestAt).toBe(ARRIVED);
  });

  it("a total the server's walk stopped at is held as a floor, and a whole answer replaces it", async () => {
    const { adapter } = doorWith([
      { groups: [group({ address: "a@x.test", count: 1000 })], total: 1000, complete: false, max: 200 },
      { groups: [group({ address: "a@x.test", count: 400 })], total: 400, complete: true, max: 200 },
    ]);
    const engine = await engineOn(adapter);
    await engine.refreshUnscreened();
    expect(unscreenedTotalIsFloor(engine.read())).toBe(true);
    await engine.refreshUnscreened();
    expect(unscreenedTotalIsFloor(engine.read())).toBe(false);
    expect(unscreenedTotalOf(engine.read())).toBe(400);
  });

  it("a refresh REPLACES the set — a group the door no longer names is gone", async () => {
    const { adapter } = doorWith([
      { groups: [group({ address: "a@x.test", count: 3 }), group({ address: "b@x.test", count: 1 })], total: 4, max: 200 },
      { groups: [group({ address: "a@x.test", count: 1 })], total: 1, max: 200 },
    ]);
    const engine = await engineOn(adapter);
    await engine.refreshUnscreened();
    expect(unscreenedGroups(engine.read())).toHaveLength(2);

    await engine.refreshUnscreened();
    const rows = unscreenedGroups(engine.read());
    expect(rows.map((r) => r.id)).toEqual(["a@x.test"]);
    // The stale row's count would still read 3 if the set had been merged into.
    expect(rows[0]!.count).toBe(1);
    expect(unscreenedTotalOf(engine.read())).toBe(1);
  });

  it("a door with no such verb leaves NO row — never a confident zero", async () => {
    const adapter = {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: null, hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async () => ({ ok: true as const, changes: [] }),
    } as unknown as EngineAdapter;
    const engine = await engineOn(adapter);
    await engine.refreshUnscreened();
    expect(unscreenedGroups(engine.read())).toEqual([]);
    // Zero rows and zero total read the same here, and that is the point: the surface renders no
    // row for either, so "you have none" is a sentence this path never produces.
    expect(unscreenedTotalOf(engine.read())).toBe(0);
    expect(await engine.screenUnscreenedSenders()).toBe(0);
  });

  it("the press carries the caller's groups, or nothing at all for every group", async () => {
    const { adapter, presses } = doorWith([{ groups: [group({ address: "a@x.test", count: 1 })], total: 1, max: 200 }]);
    const engine = await engineOn(adapter);

    expect(await engine.screenUnscreenedSenders()).toBe(5);
    expect(await engine.screenUnscreenedSenders(["a@x.test"])).toBe(5);
    // Absent is EVERY group and an empty array is none — two different requests, never collapsed.
    expect(presses).toEqual([undefined, ["a@x.test"]]);
  });

  it("the press re-reads, so the screen states what is LEFT rather than what was pressed", async () => {
    const { adapter } = doorWith([
      { groups: [group({ address: "a@x.test", count: 3 })], total: 3, max: 200 },
      { groups: [], total: 0, max: 200 },
    ]);
    const engine = await engineOn(adapter);
    await engine.refreshUnscreened();
    expect(unscreenedTotalOf(engine.read())).toBe(3);

    await engine.screenUnscreenedSenders();
    expect(unscreenedGroups(engine.read())).toEqual([]);
  });
});

/**
 * THE OFFER FOLLOWS THE STORE LIVE. A first import fills the Ohbox page by page while the Ohbox is
 * open; the offer the surface read at mount said nothing, and only leaving the tab re-asked. Ohbox
 * mail coming in now re-asks at the settle, at most once per {@link UNSCREENED_REASK_MS}, the due ask
 * kept for the first settle after it; a mailbox or settings change re-asks at the next settle.
 */
describe("the undecided-sender offer follows the import", () => {
  afterEach(() => { vi.useRealTimers(); });

  function importDoor() {
    const log: SyncChange[] = [];
    let seq = 0;
    let total = 0;
    const asks = { n: 0 };
    const adapter = {
      sync: async ({ since }: { since: string | null }) => ({
        changes: { creates: [], updates: log.filter((c) => c.seq > Number(since ?? 0)), moves: [], deletes: [] },
        cursor: String(seq), hasMore: false, serverTime: new Date().toISOString(),
      }),
      mutate: async () => ({ ok: true as const, changes: [] }),
      unscreened: async (): Promise<UnscreenedWire> => {
        asks.n++;
        return total === 0 ? { groups: [], total: 0, max: 200 }
          : { groups: [group({ address: "p1@fx.test", count: total })], total, max: 200 };
      },
    } as unknown as EngineAdapter;
    const push = (c: Pick<SyncChange, "type" | "op" | "id" | "entity">): void => {
      seq++;
      log.push({ ...c, seq, updatedAt: new Date().toISOString() } as SyncChange);
    };
    const letter = (id: string, folder: string): void => push({
      type: "message", op: "create", id,
      entity: {
        id, accountId: "acct-1", mailboxId: "mb1", threadId: null, messageIdHeader: `<${id}@fx.test>`,
        subject: "A note", from: { name: "", address: "p1@fx.test" }, to: [], cc: [],
        date: new Date().toISOString(), folder: folder as Folder, snippet: "", unread: true, hasAttachments: false,
        attachmentCount: 0, sensitivity: {} as EngineMessage["sensitivity"], triage: null, labels: [],
        remoteContent: "none", updatedAt: new Date().toISOString(),
      } satisfies EngineMessage,
    });
    return { adapter, asks, push, letter, setTotal: (n: number) => { total = n; } };
  }

  /** An engine whose clock and timers the test moves; a surface asked once at mount. */
  async function mounted(door: ReturnType<typeof importDoor>, ask = true): Promise<OhmailEngine> {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const engine = new OhmailEngine({ adapter: door.adapter, now: () => new Date() });
    await engine.start();
    if (ask) await engine.refreshUnscreened();
    return engine;
  }

  const settle = async (engine: OhmailEngine): Promise<void> => {
    await engine.syncOnce();
    await vi.advanceTimersByTimeAsync(0);
  };

  it("a pull that brings Ohbox mail re-asks, and the open screen shows the offer", async () => {
    const door = importDoor();
    const engine = await mounted(door);
    expect(door.asks.n).toBe(1);
    await vi.advanceTimersByTimeAsync(UNSCREENED_REASK_MS);
    for (let i = 0; i < 5; i++) door.letter(`m${i}`, "INBOX");
    door.setTotal(5);
    await settle(engine);
    expect(door.asks.n).toBe(2);
    expect(unscreenedTotalOf(engine.read())).toBe(5);
  });

  it("CONTROL — a pull of Sent mail only asks nothing", async () => {
    const door = importDoor();
    const engine = await mounted(door);
    await vi.advanceTimersByTimeAsync(UNSCREENED_REASK_MS);
    door.letter("s1", "Sent");
    await settle(engine);
    await vi.advanceTimersByTimeAsync(UNSCREENED_REASK_MS);
    expect(door.asks.n).toBe(1);
  });

  it("CONTROL — inside the 30 s the ask waits, and the first poll after them makes it, with nothing new", async () => {
    const door = importDoor();
    const engine = await mounted(door);
    door.letter("m1", "INBOX");
    door.setTotal(1);
    await settle(engine);
    door.letter("m2", "INBOX");
    await settle(engine);
    expect(door.asks.n, "asked inside the limit").toBe(1);
    await vi.advanceTimersByTimeAsync(UNSCREENED_REASK_MS);
    expect(door.asks.n, "the engine asked on its own clock").toBe(1);
    await settle(engine);
    expect(door.asks.n, "the due ask was dropped").toBe(2);
    expect(unscreenedTotalOf(engine.read())).toBe(1);
  });

  it("CONTROL — a settings or mailbox change asks at the next settle, inside the 30 s too", async () => {
    const door = importDoor();
    const engine = await mounted(door);
    door.push({ type: "settings", op: "update", id: "acct-1", entity: { updatedAt: new Date().toISOString() } });
    await settle(engine);
    expect(door.asks.n).toBe(2);
    door.push({ type: "mailbox", op: "update", id: "mb1", entity: { id: "mb1" } });
    await settle(engine);
    expect(door.asks.n).toBe(3);
  });

  it("CONTROL — before any surface asked, Ohbox mail asks nothing", async () => {
    const door = importDoor();
    const engine = await mounted(door, false);
    door.letter("m1", "INBOX");
    await settle(engine);
    await vi.advanceTimersByTimeAsync(UNSCREENED_REASK_MS);
    expect(door.asks.n).toBe(0);
  });
});
