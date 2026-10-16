import { describe, it, expect } from "vitest";
import { OhmailEngine } from "../src/engine.js";
import { MutationRejectedError } from "../src/types.js";
import type { AttachmentWire, EngineAdapter } from "../src/adapters/adapter.js";

/**
 * THE DESKTOP'S SAVE HOLDS NO BYTES, AND THE TILE STILL SAYS WHAT IS HAPPENING. `deliverAttachment`
 * runs a delivery the shell performs (the engine streams the part to disk): the item reads
 * `loading` meanwhile and returns to where it was, a refusal lands as a fetch refusal would, and no
 * blob is fetched into this window at any point.
 */

function makeAdapter(fetched: string[]): EngineAdapter {
  return {
    sync: async () => ({ changes: [], cursor: "1", hasMore: false }) as never,
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    listAttachments: async () => [wire()],
    fetchAttachment: async (id) => { fetched.push(id); return new Blob(["x"]); },
  };
}

function wire(): AttachmentWire {
  return { id: "a1", filename: "clip.mp4", contentType: "video/mp4", sizeBytes: 40 * 1024 * 1024, inline: false, messageId: "m1" };
}

function stateOf(engine: OhmailEngine): string | undefined {
  const held = engine.attachmentsOf("m1");
  return held.state === "ready" ? held.items[0]?.state : undefined;
}

describe("deliverAttachment — a save by id", () => {
  it("a press during a preview's fetch waits for it, then saves", async () => {
    const fetched: string[] = [];
    const engine = new OhmailEngine({ adapter: makeAdapter(fetched) });
    await engine.loadAttachments("m1");
    const preview = engine.openAttachment("m1", "a1");
    let saves = 0;
    const answer = await engine.deliverAttachment("m1", "a1", async () => { saves += 1; return true as const; });
    await preview;
    expect(answer).toBe(true);
    expect(saves).toBe(1);
    expect(stateOf(engine)).toBe("ready");
  });

  it("reads loading while the shell saves, returns to idle, and fetches nothing into the window", async () => {
    const fetched: string[] = [];
    const engine = new OhmailEngine({ adapter: makeAdapter(fetched) });
    await engine.loadAttachments("m1");
    let during: string | undefined;
    const answer = await engine.deliverAttachment("m1", "a1", async () => {
      during = stateOf(engine);
      return true as const;
    });
    expect(answer).toBe(true);
    expect(during).toBe("loading");
    expect(stateOf(engine)).toBe("idle");
    expect(fetched).toEqual([]);
    expect(engine.attachmentBlobOf("m1", "a1")).toBeUndefined();
  });

  it("a refusal at the ceiling is too_large, and too_large is never asked again", async () => {
    const engine = new OhmailEngine({ adapter: makeAdapter([]) });
    await engine.loadAttachments("m1");
    const refused = new MutationRejectedError("over the limit", { status: 413, code: "payload_too_large" });
    expect(await engine.deliverAttachment("m1", "a1", async () => { throw refused; })).toBeUndefined();
    expect(stateOf(engine)).toBe("too_large");
    let asked = false;
    await engine.deliverAttachment("m1", "a1", async () => { asked = true; return true; });
    expect(asked).toBe(false);
  });

  it("any other refusal is failed with its facts, and only a retry asks again", async () => {
    const engine = new OhmailEngine({ adapter: makeAdapter([]) });
    await engine.loadAttachments("m1");
    const refused = new MutationRejectedError("the message moved", { status: 404, code: "not_found", retryable: true });
    await engine.deliverAttachment("m1", "a1", async () => { throw refused; });
    const held = engine.attachmentsOf("m1");
    expect(held.state === "ready" && held.items[0]).toMatchObject({ state: "failed", code: "not_found", status: 404, retryable: true });
    let asked = 0;
    await engine.deliverAttachment("m1", "a1", async () => { asked += 1; return true; });
    expect(asked).toBe(0);
    await engine.deliverAttachment("m1", "a1", async () => { asked += 1; return true; }, { retry: true });
    expect(asked).toBe(1);
    expect(stateOf(engine)).toBe("idle");
  });

  it("a second press while one is saving is not a second save", async () => {
    const engine = new OhmailEngine({ adapter: makeAdapter([]) });
    await engine.loadAttachments("m1");
    let release: () => void = () => {};
    let calls = 0;
    const first = engine.deliverAttachment("m1", "a1", () => { calls += 1; return new Promise<true>((r) => { release = () => r(true); }); });
    const second = await engine.deliverAttachment("m1", "a1", async () => { calls += 1; return true; });
    release();
    expect(await first).toBe(true);
    expect(second).toBeUndefined();
    expect(calls).toBe(1);
  });
});
