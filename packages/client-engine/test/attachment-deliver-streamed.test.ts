import { describe, it, expect, vi } from "vitest";
import { OhmailEngine, type StagedPreview } from "../src/engine.js";
import { MutationRejectedError } from "../src/types.js";
import type { AttachmentWire, EngineAdapter } from "../src/adapters/adapter.js";

/**
 * THE DESKTOP'S SAVE HOLDS NO BYTES, AND THE TILE STILL SAYS WHAT IS HAPPENING. `deliverAttachment`
 * runs a delivery the shell performs (the engine streams the part to disk): an item not yet fetched
 * reads `loading` meanwhile and goes back to `idle`, a refusal lands as a fetch refusal would, and no
 * blob is fetched into this window at any point. A part the window already shows (`ready`) keeps its
 * state and its bytes through the save, as a browser's download leaves the page alone: it reads
 * `saving` meanwhile, and a refusal is the press's to say.
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

function itemOf(engine: OhmailEngine) {
  const held = engine.attachmentsOf("m1");
  return held.state === "ready" ? held.items[0] : undefined;
}

const ticks = async (): Promise<void> => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

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

  it("a save refused busy waits for a connection and lands, never shown as failed", async () => {
    vi.useFakeTimers();
    try {
      const engine = new OhmailEngine({ adapter: makeAdapter([]) });
      await engine.loadAttachments("m1");
      const states: string[] = [];
      const stop = engine.subscribe(() => states.push(stateOf(engine) ?? "none"));
      let calls = 0;
      const save = engine.deliverAttachment("m1", "a1", async () => {
        calls += 1;
        if (calls === 1) throw new MutationRejectedError("busy", { status: 429, code: "mailbox_busy", retryable: true, retryAfterMs: 1000 });
        return true as const;
      });
      await vi.advanceTimersByTimeAsync(5_000);
      stop();
      expect(await save).toBe(true);
      expect(calls).toBe(2);
      expect(states).not.toContain("failed");
      expect(stateOf(engine)).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
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

describe("deliverAttachment — a save of a part this window already shows", () => {
  it("leaves it ready with the same bytes: `saving` while the shell saves, and nothing else moves", async () => {
    const fetched: string[] = [];
    const engine = new OhmailEngine({ adapter: makeAdapter(fetched) });
    await engine.loadAttachments("m1");
    await engine.openAttachment("m1", "a1");
    const blob = engine.attachmentBlobOf("m1", "a1");
    expect(blob).toBeDefined();
    const states: string[] = [];
    const stop = engine.subscribe(() => states.push(stateOf(engine) ?? "none"));
    let during: ReturnType<typeof itemOf>;
    const answer = await engine.deliverAttachment("m1", "a1", async () => { during = itemOf(engine); return true as const; });
    stop();
    expect(answer).toBe(true);
    expect(during).toMatchObject({ state: "ready", saving: true });
    expect(states, "the item left ready while the shell saved").not.toContain("loading");
    expect(itemOf(engine)?.state).toBe("ready");
    expect(itemOf(engine)?.saving).not.toBe(true);
    expect(engine.attachmentBlobOf("m1", "a1"), "the save replaced the bytes on screen").toBe(blob);
    expect(fetched).toEqual(["a1"]);
  });

  it("a refusal leaves it ready and answers `refused`'s word for the press; without one, nothing", async () => {
    const engine = new OhmailEngine({ adapter: makeAdapter([]) });
    await engine.loadAttachments("m1");
    await engine.openAttachment("m1", "a1");
    const refused = new MutationRejectedError("the mail server did not answer", { status: 502, code: "upstream_unavailable", retryable: true });
    const seen: unknown[] = [];
    const answer = await engine.deliverAttachment("m1", "a1", async (): Promise<string> => { throw refused; }, {
      refused: (err) => { seen.push(err); return "not saved"; },
    });
    expect(answer).toBe("not saved");
    expect(seen).toEqual([refused]);
    expect(itemOf(engine), "the refusal replaced the part on screen").toMatchObject({ state: "ready" });
    expect(itemOf(engine)?.code).toBeUndefined();
    expect(await engine.deliverAttachment("m1", "a1", async () => { throw refused; })).toBeUndefined();
    expect(stateOf(engine)).toBe("ready");
    expect(itemOf(engine)?.saving).not.toBe(true);
  });

  it("two presses that waited on the preview's fetch are one save", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const adapter: EngineAdapter = { ...makeAdapter([]), fetchAttachment: async () => { await gate; return new Blob(["x"]); } };
    const engine = new OhmailEngine({ adapter });
    await engine.loadAttachments("m1");
    const preview = engine.openAttachment("m1", "a1");
    let calls = 0;
    const first = engine.deliverAttachment("m1", "a1", async () => { calls += 1; return true as const; });
    const second = engine.deliverAttachment("m1", "a1", async () => { calls += 1; return true as const; });
    release();
    await preview;
    expect(await first).toBe(true);
    expect(await second).toBeUndefined();
    expect(calls).toBe(1);
  });

  it("a preview opened again while the save runs stages the part, rather than waiting on the save", async () => {
    // The overlay closes over a picture whose save is still running (its staged file goes) and opens
    // again: the save stages nothing, so a preview handed its flight would draw nothing.
    const engine = new OhmailEngine({ adapter: makeAdapter([]) });
    await engine.loadAttachments("m1");
    const url = `attachment-preview://localhost/${"ab".repeat(16)}`;
    let staged = 0;
    const stage = async (): Promise<StagedPreview> => { staged += 1; return { kind: "url", url, release: () => {} }; };
    await engine.stageAttachment("m1", "a1", stage);
    let finish: () => void = () => {};
    const save = engine.deliverAttachment("m1", "a1", () => new Promise<true>((r) => { finish = () => r(true); }));
    await ticks();
    engine.releasePreviews("m1");
    expect(stateOf(engine)).toBe("idle");
    const reopened = engine.stageAttachment("m1", "a1", stage);
    await ticks();
    expect(staged, "the second open waited on the save instead of staging").toBe(2);
    await reopened;
    expect(itemOf(engine)).toMatchObject({ state: "ready", objectUrl: url });
    finish();
    expect(await save).toBe(true);
    expect(itemOf(engine)).toMatchObject({ state: "ready", objectUrl: url });
    expect(itemOf(engine)?.saving).not.toBe(true);
  });
});
