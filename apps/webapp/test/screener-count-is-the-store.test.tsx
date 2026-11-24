/** @vitest-environment jsdom */
import type { EngineMessage, ScreenerWaitingWire } from "@ohmail/wire";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { OhmailEngine, MemoryMirrorStore, type SyncChange } from "@ohmail/client-engine";
import { useScreenerState } from "@ohmail/app-logic/screener/screener-state";
import { useScreenerWords } from "../../../packages/app/src/screener/words.js";
import { inWords, mountPlace } from "../../../packages/app/test/screener/screener-world.js";
import { settleFirstPaint } from "./_first-paint.js";

const NOW = new Date("2026-09-26T09:00:00.000Z");
let seq = 0;

function held(id: string, from: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-09-26T08:00:00.000Z", folder: "ohmail/Screener", snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-26T08:00:00.000Z",
  };
}

const FIRST: ScreenerWaitingWire = {
  items: [held("m0", "a@one.test"), held("m1", "b@one.test")].map((m) => ({
    messageId: m.id, address: m.from.address, name: null, receivedAt: m.date!, subject: m.subject, snippet: m.snippet, mailboxId: "mb",
  })),
  nextCursor: "n", total: 250, inFlight: [],
};
const ONWARD: ScreenerWaitingWire = {
  items: [{ messageId: "far", address: "far@away.test", name: "Far", receivedAt: "2026-01-01T08:00:00.000Z", subject: "An old note", snippet: "old", mailboxId: "mb" }],
  nextCursor: null, total: null, inFlight: [],
};

type Door = "answers" | "refuses" | "none" | "empty-later";
/** Opens the "empty-later" door: the store answers that nobody waits, once released. */
let releaseDoor: () => void = () => {};
/** Every render's waiting count and rows, as the Ohbox strip and the rail would read them. */
let seen: string[] = [];

async function engineWith(door: Door): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([held("m0", "a@one.test"), held("m1", "b@one.test")].map((m): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  return new OhmailEngine({
    store, now: () => NOW,
    adapter: {
      sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
      mutate: async () => ({ changes: [], seq: null }),
      fetchBody: async () => null,
      withdrawSend: async () => ({ outcome: "unsupported" }),
      ...(door === "none" ? {} : {
        screenerWaiting: async (p?: { cursor?: string }) => {
          if (door === "refuses") throw new Error("offline");
          if (door === "empty-later") {
            await new Promise<void>((r) => { releaseDoor = r; });
            return { items: [], nextCursor: null, total: 0, inFlight: [] };
          }
          return p?.cursor ? ONWARD : FIRST;
        },
      }),
    },
  });
}

afterEach(cleanup);

async function mount(door: Door) {
  const engine = await engineWith(door);
  const { result } = renderHook(() => {
    const [version, update] = useState(0);
    useEffect(() => engine.subscribe(() => update((n) => n + 1)), []);
    const model = useScreenerState(engine, null, version, () => {}, useScreenerWords());
    seen.push(`${model.waitingCount}:${model.waiting.map((row) => row.from.address).join(",")}`);
    return model;
  }, { wrapper: ({ children }: { children: ReactNode }) => inWords(children) });
  await settleFirstPaint();
  if (door !== "empty-later") await waitFor(() => expect(result.current.queueSettled).toBe(true));
  const world = mountPlace(result.current, { engine });
  return {
    model: () => result.current,
    showCurrent: () => world.again(result.current),
  };
}

const count = (name: string) => screen.getByRole("button", { name });
const far = () => screen.queryByRole("option", { name: /Far.*An old note/ });

describe("the Screener's count is the store's", () => {
  it("states the store's total over a mirror that holds two of its senders, and pages onward", async () => {
    const place = await mount("answers");
    expect(count("Waiting 250")).toBeTruthy();
    expect(screen.queryByText(/counted on this device/i)).toBeNull();
    expect(far()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show more senders" }));
    await waitFor(() => expect(place.model().waiting).toHaveLength(3));
    place.showCurrent();
    expect(far()).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show more senders" })).toBeNull();
  });

  it("names the count as this device's own while the store has not answered", async () => {
    await mount("refuses");
    expect(count("Waiting 2")).toBeTruthy();
    expect(screen.getByText("Counted on this device")).toBeTruthy();
  });

  it("never states the device's own senders while the store's first answer is on its way", async () => {
    seen = [];
    const place = await mount("empty-later");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter((value) => value !== "0:")).toEqual([]);
    expect(screen.queryByText("No one’s waiting")).toBeNull();
    await act(async () => { releaseDoor(); });
    await waitFor(() => expect(place.model().queueSettled).toBe(true));
    place.showCurrent();
    expect(seen.filter((value) => value !== "0:")).toEqual([]);
    expect(screen.getByRole("region", { name: "Messages" }).textContent).toContain("No one’s waiting");
  });

  it("a client with no store keeps the plain sentence", async () => {
    await mount("none");
    expect(count("Waiting 2")).toBeTruthy();
    expect(screen.queryByText(/counted on this device/i)).toBeNull();
  });
});
