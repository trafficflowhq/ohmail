import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OhmailEngine, INLINE_IMAGE_MAX_BYTES, type StagedPreview } from "../src/engine.js";
import type { AttachmentWire, EngineAdapter } from "../src/adapters/adapter.js";

/**
 * EMBEDDED PICTURES BY OBJECT URL (`inlineImageUrls: "object"`, the browser doors). The map's value
 * is the part's own object URL, which the mail frame loads by reference; a `data:` copy of twelve
 * pictures was copied again at every step that read it (about 1 GB of renderer for 16 MiB). What
 * this file holds: one URL per part and no second carrier; the closed default; the same byte gates
 * as the `data:` mint; a URL owned by its own message; a staged preview neither taken nor released;
 * and a map that never names a revoked URL.
 */

let live: Set<string>;
let revoked: string[];
beforeEach(() => {
  live = new Set();
  revoked = [];
  let n = 0;
  (globalThis as { URL: unknown }).URL = {
    createObjectURL: () => {
      const url = `blob:https://app.ohmail.test/${String(++n).padStart(8, "0")}`;
      live.add(url);
      return url;
    },
    revokeObjectURL: (url: string) => {
      revoked.push(url);
      live.delete(url);
    },
  };
});
afterEach(() => {
  delete (globalThis as { URL?: unknown }).URL;
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const STAGED = `attachment-preview://localhost/${"ab".repeat(16)}`;

function wire(o: Partial<AttachmentWire> = {}): AttachmentWire {
  return {
    id: o.id ?? "a1",
    filename: o.filename ?? "logo.png",
    contentType: o.contentType ?? "image/png",
    sizeBytes: o.sizeBytes ?? PNG.length,
    inline: o.inline ?? true,
    contentId: o.contentId === undefined ? "logo@corp" : o.contentId,
    messageId: o.messageId ?? "m1",
  };
}

/** One engine over the given parts per message; `hold` parks a part's fetch until released. */
function rig(
  parts: AttachmentWire[],
  opts: { mode?: "object" | "data"; bytes?: (id: string) => Uint8Array; hold?: Map<string, Promise<void>> } = {},
) {
  const fetched: string[] = [];
  const adapter: EngineAdapter = {
    sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date().toISOString() }) as never,
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    listAttachments: async (messageId: string) => parts.filter((p) => p.messageId === messageId),
    fetchAttachment: async (id: string) => {
      fetched.push(id);
      await opts.hold?.get(id);
      return new Blob([opts.bytes?.(id) ?? PNG], { type: "image/png" });
    },
  };
  const engine = new OhmailEngine({ adapter, ...(opts.mode ? { inlineImageUrls: opts.mode } : {}) });
  return { engine, fetched };
}

const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const itemOf = (engine: OhmailEngine, messageId: string, id: string) => {
  const held = engine.attachmentsOf(messageId, { includeInlineParts: true });
  return held.state === "ready" ? held.items.find((i) => i.id === id) : undefined;
};

describe("inlineImageUrls: \"object\" — the frame draws the part's own object URL", () => {
  it("the map's value IS the part's object URL: one URL per part, no second carrier", async () => {
    const { engine, fetched } = rig([wire()], { mode: "object" });
    await engine.loadInlineImages("m1", ["logo@corp"]);
    const url = engine.inlineImagesOf("m1").get("logo@corp");
    expect(url).toMatch(/^blob:/);
    expect(url, "not the item's own URL").toBe(itemOf(engine, "m1", "a1")?.objectUrl);
    expect(live.size, "a second URL was minted for the frame").toBe(1);
    expect(fetched).toEqual(["a1"]);
  });

  it("the default, and any value but \"object\", is the data: carrier — the closed branch", async () => {
    for (const mode of [undefined, "blob" as unknown as "data", "data"] as const) {
      const { engine } = rig([wire()], mode === undefined ? {} : { mode });
      await engine.loadInlineImages("m1", ["logo@corp"]);
      expect(engine.inlineImagesOf("m1").get("logo@corp"), `mode ${String(mode)}`)
        .toBe(`data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);
    }
  });

  it("the data: mint's two refusals hold: a size that lied small, and an empty part, draw nothing", async () => {
    const { engine, fetched } = rig(
      [wire({ id: "liar", contentId: "big@corp", sizeBytes: 10 }), wire({ id: "empty", contentId: "nil@corp" })],
      { mode: "object", bytes: (id) => (id === "liar" ? new Uint8Array(INLINE_IMAGE_MAX_BYTES + 1) : new Uint8Array(0)) },
    );
    await engine.loadInlineImages("m1", ["big@corp", "nil@corp"]);
    expect(fetched).toEqual(["liar", "empty"]);
    expect(engine.inlineImagesOf("m1").size, "a URL past the real-byte gate was drawn from").toBe(0);
  });

  it("two messages sharing a Content-ID draw their own parts, and a release revokes only its own", async () => {
    const { engine } = rig([wire({ id: "a1" }), wire({ id: "b1", messageId: "m2" })], { mode: "object" });
    await engine.loadInlineImages("m1", ["logo@corp"]);
    await engine.loadInlineImages("m2", ["logo@corp"]);
    const a = engine.inlineImagesOf("m1").get("logo@corp")!;
    const b = engine.inlineImagesOf("m2").get("logo@corp")!;
    expect(a).not.toBe(b);
    engine.releaseAttachments("m1");
    expect(revoked).toEqual([a]);
    expect(engine.inlineImagesOf("m2").get("logo@corp")).toBe(b);
    expect(live.has(b)).toBe(true);
  });

  for (const mode of ["object", "data"] as const) {
    it(`a staged preview stands: the pass neither takes nor releases it, and draws when the overlay closes (${mode})`, async () => {
      const released: string[] = [];
      const { engine, fetched } = rig([wire()], { mode });
      await engine.loadAttachments("m1");
      await engine.stageAttachment("m1", "a1", async (): Promise<StagedPreview> => ({
        kind: "url", url: STAGED, release: () => released.push(STAGED),
      }));
      await engine.loadInlineImages("m1", ["logo@corp"]);
      expect(released, "the pass released the preview the overlay shows").toEqual([]);
      expect(fetched, "the pass fetched over a staged preview").toEqual([]);
      expect(engine.inlineImagesOf("m1").size).toBe(0);
      expect(itemOf(engine, "m1", "a1")?.objectUrl).toBe(STAGED);

      engine.releasePreviews("m1");
      await settle();
      expect(released).toEqual([STAGED]);
      expect(fetched, "the picture was not fetched once the overlay closed").toEqual(["a1"]);
      const drawn = engine.inlineImagesOf("m1").get("logo@corp");
      expect(drawn).toMatch(mode === "object" ? /^blob:/ : /^data:image\/png;base64,/);

      engine.releaseAttachments("m1");
      expect(live.size, "a URL outlived the message").toBe(0);
      expect(released).toEqual([STAGED]);
    });
  }

  it("a revoked URL leaves the map with it: a fetch over a drawn part never leaves a dead URL in the frame", async () => {
    const { engine } = rig([wire()], { mode: "object" });
    await engine.loadInlineImages("m1", ["logo@corp"]);
    const first = engine.inlineImagesOf("m1").get("logo@corp")!;
    const dead: string[] = [];
    const stop = engine.subscribe(() => {
      for (const url of engine.inlineImagesOf("m1").values()) if (!live.has(url)) dead.push(url);
    });
    // A desktop save over the drawn part fails; the press over the failed card fetches again.
    await engine.deliverAttachment("m1", "a1", async () => { throw new Error("the disk is full"); });
    await engine.openAttachment("m1", "a1", { retry: true });
    await settle();
    stop();
    expect(revoked).toContain(first);
    expect(dead, "the map named a revoked URL").toEqual([]);
    const now = engine.inlineImagesOf("m1").get("logo@corp");
    expect(now).toBe(itemOf(engine, "m1", "a1")?.objectUrl);
    expect(live.has(now!)).toBe(true);
  });

  it("a URL revoked while the pass walked on is not drawn from; the next pass draws the live one", async () => {
    let let2go: () => void = () => {};
    const hold = new Map([["a2", new Promise<void>((r) => { let2go = r; })]]);
    const { engine } = rig([wire({ id: "a1", contentId: "c1" }), wire({ id: "a2", contentId: "c2" })], { mode: "object", hold });
    const pass = engine.loadInlineImages("m1", ["c1", "c2"]);
    await settle();
    const first = itemOf(engine, "m1", "a1")?.objectUrl;
    expect(first).toMatch(/^blob:/);
    await engine.deliverAttachment("m1", "a1", async () => { throw new Error("the disk is full"); });
    await engine.openAttachment("m1", "a1", { retry: true });
    expect(revoked).toContain(first);
    let2go();
    await pass;
    await settle();
    const map = engine.inlineImagesOf("m1");
    expect([...map.values()].filter((url) => !live.has(url)), "a revoked URL was drawn from").toEqual([]);
    expect(map.get("c1")).toBe(itemOf(engine, "m1", "a1")?.objectUrl);
    expect(map.get("c2")).toMatch(/^blob:/);
  });
});
