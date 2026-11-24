import type { AttachmentWire } from "@ohmail/wire";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OhmailEngine } from "../src/engine.js";
import { MutationRejectedError } from "../src/types.js";
import type { EngineAdapter } from "../src/adapters/adapter.js";

/**
 * THE PICTURES OF THE LETTER ON SCREEN ARE NOT KEPT WAITING. Every embedded picture is one round trip
 * to the person's own mail server. A thread of five letters with thirty pictures between them drew
 * the letter being read last, one picture at a time, and showed none of them until the last had
 * arrived: grey boxes for several seconds. Here each round trip is one second of a fake clock, and
 * the cases count how many the letter on screen waits.
 */

beforeEach(() => {
  let n = 0;
  (globalThis as { URL: unknown }).URL = {
    createObjectURL: () => `blob:${++n}`,
    revokeObjectURL: () => {},
  };
});
afterEach(() => {
  delete (globalThis as { URL?: unknown }).URL;
  vi.useRealTimers();
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const ROUND_TRIP_MS = 1_000;

const busy = () => new MutationRejectedError("busy", { status: 429, code: "mailbox_busy", retryable: true, retryAfterMs: 10_000 });

/**
 * The API's door for one mailbox: two at once, a third is answered busy. Each ask takes one round trip.
 * `busyFor` answers busy to those parts' first ask, as when another window holds the mailbox.
 */
function door(max = 2, busyFor: ReadonlySet<string> = new Set()) {
  let held = 0;
  const refused = new Set<string>();
  const stats = { asks: [] as string[], inAsk: 0, peak: 0 };
  const fetchAttachment = async (id: string): Promise<Blob> => {
    stats.asks.push(id);
    stats.inAsk += 1;
    stats.peak = Math.max(stats.peak, stats.inAsk);
    try {
      if (busyFor.has(id) && !refused.has(id)) { refused.add(id); throw busy(); }
      if (held >= max) throw busy();
      held += 1;
      try {
        await new Promise((r) => setTimeout(r, ROUND_TRIP_MS));
        return new Blob([PNG], { type: "image/png" });
      } finally { held -= 1; }
    } finally { stats.inAsk -= 1; }
  };
  return { fetchAttachment, stats };
}

function pictures(messageId: string, n: number): AttachmentWire[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${messageId}-p${i}`, filename: `p${i}.png`, contentType: "image/png", sizeBytes: PNG.length,
    inline: true, contentId: `${messageId}-c${i}`, messageId,
  }));
}

const cids = (id: string, n: number) => Array.from({ length: n }, (_, i) => `${id}-c${i}`);

/** One mailbox, one letter per entry of `letters` with that many pictures; `files` adds a plain file to a letter. */
function thread(
  letters: Record<string, number>,
  { files = {}, busyFor, mode = "object" }: { files?: Record<string, string>; busyFor?: ReadonlySet<string>; mode?: "object" | "data" } = {},
) {
  const d = door(2, busyFor);
  const lists: Record<string, AttachmentWire[]> = {};
  for (const [id, n] of Object.entries(letters)) {
    lists[id] = pictures(id, n);
    const file = files[id];
    if (file) lists[id].push({ id: file, filename: "invoice.pdf", contentType: "application/pdf", sizeBytes: 10, inline: false, contentId: null, messageId: id });
  }
  const adapter: EngineAdapter = {
    sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date().toISOString() }) as never,
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    listAttachments: async (id: string) => lists[id] ?? [],
    fetchAttachment: d.fetchAttachment,
  };
  return { engine: new OhmailEngine({ adapter, inlineImageUrls: mode }), stats: d.stats };
}

/** Advance the clock by whole round trips, plus a moment for the answers to be drawn. */
const roundTrips = (n: number) => vi.advanceTimersByTimeAsync(n * ROUND_TRIP_MS + 10);

describe("the letter on screen draws its embedded pictures without waiting", () => {
  it("its four pictures take two round trips, two at a time, and each is drawn as it lands", async () => {
    vi.useFakeTimers();
    const { engine, stats } = thread({ m1: 4 });
    const pass = engine.loadInlineImages("m1", cids("m1", 4), { first: true });

    await roundTrips(1);
    expect(engine.inlineImagesOf("m1").size, "pictures drawn after one round trip").toBe(2);
    await roundTrips(1);
    expect(engine.inlineImagesOf("m1").size, "pictures drawn after two round trips").toBe(4);
    await pass;
    expect(stats.peak, "never more at once than the door admits").toBe(2);
  });

  it("it goes ahead of the letters above it in the thread", async () => {
    vi.useFakeTimers();
    const { engine } = thread({ m1: 3, m2: 3, m3: 3 });
    // The column draws the older letters first; the newest is the one on screen.
    void engine.loadInlineImages("m1", cids("m1", 3));
    void engine.loadInlineImages("m2", cids("m2", 3));
    void engine.loadInlineImages("m3", cids("m3", 3), { first: true });

    await roundTrips(2);
    expect(engine.inlineImagesOf("m3").size, "the letter on screen after two round trips").toBe(3);
    await roundTrips(10);
    expect(["m1", "m2", "m3"].map((id) => engine.inlineImagesOf(id).size), "the others still all arrive").toEqual([3, 3, 3]);
  });

  it("a letter scrolled onto the screen moves its waiting pictures up", async () => {
    vi.useFakeTimers();
    const { engine } = thread({ m1: 4, m2: 2 });
    void engine.loadInlineImages("m1", cids("m1", 4));
    void engine.loadInlineImages("m2", cids("m2", 2));
    await vi.advanceTimersByTimeAsync(10);
    // The person scrolls to m2: its body asks again, now as the letter on screen.
    void engine.loadInlineImages("m2", cids("m2", 2), { first: true });

    await roundTrips(1);
    expect(engine.inlineImagesOf("m2").size, "m2 after one round trip").toBe(1);
    await roundTrips(1);
    expect(engine.inlineImagesOf("m2").size, "m2 after two round trips").toBe(2);
  });

  it("a press on a file is the next ask once one of the letter's pictures lands", async () => {
    vi.useFakeTimers();
    const { engine, stats } = thread({ m1: 4 }, { files: { m1: "f1" } });
    void engine.loadInlineImages("m1", cids("m1", 4), { first: true });
    await vi.advanceTimersByTimeAsync(10);
    void engine.openAttachment("m1", "f1");

    await roundTrips(3);
    expect(stats.asks.slice(0, 3), "the press is the next ask once a slot frees").toEqual(["m1-p0", "m1-p1", "f1"]);
    expect(engine.inlineImagesOf("m1").size).toBe(4);
  });

  it("a press is not kept waiting by pictures that wait out a busy mailbox", async () => {
    vi.useFakeTimers();
    const { engine, stats } = thread({ m1: 2 }, { files: { m1: "f1" }, busyFor: new Set(["m1-p0", "m1-p1"]) });
    void engine.loadInlineImages("m1", cids("m1", 2), { first: true });
    await vi.advanceTimersByTimeAsync(10);
    void engine.openAttachment("m1", "f1");

    await roundTrips(1);
    expect(stats.asks, "the press is asked while both pictures wait").toContain("f1");
    const held = engine.attachmentsOf("m1", { includeInlineParts: true });
    expect(held.state === "ready" && held.items.find((i) => i.id === "f1")?.state).toBe("ready");
    await roundTrips(15);
    expect(engine.inlineImagesOf("m1").size, "the pictures still arrive").toBe(2);
  });

  it("data: pictures (the phone) arrive two at a time and are drawn together", async () => {
    vi.useFakeTimers();
    const { engine, stats } = thread({ m1: 4 }, { mode: "data" });
    const pass = engine.loadInlineImages("m1", cids("m1", 4), { first: true });

    await roundTrips(1);
    expect(engine.inlineImagesOf("m1").size, "nothing drawn before the pass ends").toBe(0);
    await roundTrips(1);
    await pass;
    expect(engine.inlineImagesOf("m1").size).toBe(4);
    expect(stats.peak).toBe(2);
  });

  it("control: letters not on screen still ask one picture at a time", async () => {
    vi.useFakeTimers();
    const { engine, stats } = thread({ m1: 2, m2: 2 });
    const all = Promise.all([engine.loadInlineImages("m1", cids("m1", 2)), engine.loadInlineImages("m2", cids("m2", 2))]);
    await roundTrips(5);
    await all;
    expect(stats.peak).toBe(1);
    expect([engine.inlineImagesOf("m1").size, engine.inlineImagesOf("m2").size]).toEqual([2, 2]);
  });
});
