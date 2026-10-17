import { describe, it, expect } from "vitest";
import { OhmailEngine, type StagedPreview } from "../src/engine.js";
import { MutationRejectedError } from "../src/types.js";
import type { AttachmentWire, EngineAdapter } from "../src/adapters/adapter.js";

/**
 * THE DESKTOP'S PREVIEW HOLDS NO IMAGE BYTE: `stageAttachment` takes the shell's answer — a URL on
 * its preview scheme, the capped text, or "too large" — and the URL is the ledger's like any minted
 * one, so every release path (the overlay closing, the message released, the engine torn down)
 * calls the shell's release exactly once. Nothing is fetched into this document.
 */

function wire(id: string, contentType: string, contentId: string | null = null): AttachmentWire {
  return { id, filename: `${id}.bin`, contentType, sizeBytes: 40 * 1024 * 1024, inline: contentId !== null, contentId, messageId: "m1" } as AttachmentWire;
}

function makeEngine(fetched: string[], parts = [wire("a1", "image/png"), wire("t1", "text/plain")]): OhmailEngine {
  const adapter: EngineAdapter = {
    sync: async () => ({ changes: [], cursor: "1", hasMore: false }) as never,
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    listAttachments: async () => parts,
    fetchAttachment: async (id) => { fetched.push(id); return new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }); },
  };
  return new OhmailEngine({ adapter });
}

function itemOf(engine: OhmailEngine, id: string) {
  const held = engine.attachmentsOf("m1", { includeInlineParts: true });
  return held.state === "ready" ? held.items.find((i) => i.id === id) : undefined;
}

function staged(url: string, released: string[]): StagedPreview {
  return { kind: "url", url, release: () => released.push(url) };
}

describe("stageAttachment — a preview by id", () => {
  it("an image is ready with the shell's URL and no bytes; closing the overlay releases it once and re-arms", async () => {
    const fetched: string[] = [];
    const released: string[] = [];
    const engine = makeEngine(fetched);
    await engine.loadAttachments("m1");
    let during: string | undefined;
    await engine.stageAttachment("m1", "a1", async () => {
      during = itemOf(engine, "a1")?.state;
      return staged("attachment-preview://localhost/aa", released);
    });
    expect(during).toBe("loading");
    expect(itemOf(engine, "a1")).toMatchObject({ state: "ready", objectUrl: "attachment-preview://localhost/aa" });
    expect(engine.attachmentBlobOf("m1", "a1")).toBeUndefined();
    expect(fetched).toEqual([]);
    // A second ask while ready asks the shell nothing.
    let asked = 0;
    await engine.stageAttachment("m1", "a1", async () => { asked += 1; return staged("x", released); });
    expect(asked).toBe(0);
    engine.releasePreviews("m1");
    expect(released).toEqual(["attachment-preview://localhost/aa"]);
    expect(itemOf(engine, "a1")).toMatchObject({ state: "idle" });
    expect(itemOf(engine, "a1")?.objectUrl).toBeUndefined();
    engine.releaseAttachments("m1");
    expect(released).toEqual(["attachment-preview://localhost/aa"]);
  });

  it("a message's release and a teardown release staged previews too", async () => {
    const released: string[] = [];
    const engine = makeEngine([]);
    await engine.loadAttachments("m1");
    await engine.stageAttachment("m1", "a1", async () => staged("u1", released));
    engine.releaseAttachments("m1");
    expect(released).toEqual(["u1"]);
    await engine.loadAttachments("m1");
    await engine.stageAttachment("m1", "a1", async () => staged("u2", released));
    engine.releaseAllAttachments();
    expect(released).toEqual(["u1", "u2"]);
  });

  it("a preview released while the shell staged it is released as soon as it lands", async () => {
    const released: string[] = [];
    const engine = makeEngine([]);
    await engine.loadAttachments("m1");
    let land: () => void = () => {};
    const flight = engine.stageAttachment("m1", "a1", () => new Promise<StagedPreview>((r) => { land = () => r(staged("late", released)); }));
    engine.releaseAttachments("m1");
    land();
    await flight;
    expect(released).toEqual(["late"]);
  });

  it("text arrives as the capped blob; over the cap it is previewTooLarge and nothing is held", async () => {
    const engine = makeEngine([]);
    await engine.loadAttachments("m1");
    await engine.stageAttachment("m1", "t1", async () => ({ kind: "text", text: new Blob(["hello"]) }));
    expect(await engine.attachmentBlobOf("m1", "t1")?.text()).toBe("hello");
    const other = makeEngine([]);
    await other.loadAttachments("m1");
    await other.stageAttachment("m1", "t1", async () => ({ kind: "too_large" }));
    expect(itemOf(other, "t1")).toMatchObject({ state: "ready", previewTooLarge: true });
    expect(other.attachmentBlobOf("m1", "t1")).toBeUndefined();
  });

  it("a refusal lands as a fetch refusal would, and only a retry asks again", async () => {
    const engine = makeEngine([]);
    await engine.loadAttachments("m1");
    await engine.stageAttachment("m1", "a1", async () => {
      throw new MutationRejectedError("over the limit", { status: 413, code: "payload_too_large" });
    });
    expect(itemOf(engine, "a1")?.state).toBe("too_large");
    await engine.stageAttachment("m1", "t1", async () => {
      throw new MutationRejectedError("the message moved", { status: 404, code: "not_found", retryable: true });
    });
    expect(itemOf(engine, "t1")).toMatchObject({ state: "failed", code: "not_found" });
    let asked = 0;
    await engine.stageAttachment("m1", "t1", async () => { asked += 1; return { kind: "too_large" }; });
    expect(asked).toBe(0);
    await engine.stageAttachment("m1", "t1", async () => { asked += 1; return { kind: "too_large" }; }, { retry: true });
    expect(asked).toBe(1);
  });

  it("a staged URL carries no bytes: an embedded picture's fetch still fetches, and the staged file goes", async () => {
    const fetched: string[] = [];
    const released: string[] = [];
    const engine = makeEngine(fetched, [wire("a1", "image/png", "logo@x")]);
    await engine.loadAttachments("m1");
    await engine.stageAttachment("m1", "a1", async () => staged("u-inline", released));
    await engine.openAttachment("m1", "a1");
    expect(fetched).toEqual(["a1"]);
    expect(released).toEqual(["u-inline"]);
    expect(engine.attachmentBlobOf("m1", "a1")).toBeDefined();
  });
});

describe("the window owns the eviction", () => {
  it("past the cap the oldest staged preview is released and back to idle; a revisit stages it again", async () => {
    const { STAGED_PREVIEWS_KEPT } = await import("../src/engine.js");
    const n = STAGED_PREVIEWS_KEPT + 1;
    const parts = Array.from({ length: n }, (_, i) => wire(`p${i}`, "image/png"));
    const engine = makeEngine([], parts);
    await engine.loadAttachments("m1");
    const released: string[] = [];
    const asked: string[] = [];
    let serial = 0;
    const stage = (id: string) => () => { asked.push(id); return Promise.resolve(staged(`u${serial++}-${id}`, released)); };
    for (const p of parts) await engine.stageAttachment("m1", p.id, stage(p.id));
    expect(released, "the window kept more staged previews than its cap").toEqual(["u0-p0"]);
    expect(itemOf(engine, "p0")).toMatchObject({ state: "idle" });
    expect(itemOf(engine, "p0")?.objectUrl).toBeUndefined();
    expect(itemOf(engine, "p1")).toMatchObject({ state: "ready", objectUrl: "u1-p1" });
    await engine.stageAttachment("m1", "p0", stage("p0"));
    expect(asked.filter((id) => id === "p0")).toHaveLength(2);
    expect(itemOf(engine, "p0")).toMatchObject({ state: "ready", objectUrl: `u${n}-p0` });
    expect(released).toEqual(["u0-p0", "u1-p1"]);
    expect(itemOf(engine, "p1")?.state).toBe("idle");
  });
});
