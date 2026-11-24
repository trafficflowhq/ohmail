import type { AttachmentWire } from "@ohmail/wire";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  OhmailEngine,
  INLINE_IMAGE_MAX_BYTES,
  INLINE_IMAGE_MAX_PARTS,
} from "../src/engine.js";
import type { EngineAdapter } from "../src/adapters/adapter.js";

/**
 * ── EMBEDDED (`cid:`) IMAGES: FETCHED FROM THE PART'S OWN BYTES, MINTED AS `data:` URIs ─────
 *
 * `loadInlineImages` is the automatic half of the attachment byte machinery: it runs when a
 * reader OPENS a message whose html references embedded parts, so everything here is about what
 * that automation may and may not spend. The map it fills (`inlineImagesOf`) is what the mail
 * renderer resolves `cid:` references against; the values are `data:` URIs carrying the bytes,
 * so the sandboxed frame fetches nothing to draw them.
 *
 * The budget tests are the point, not decoration: the trigger is not a press, so the bound on
 * what one open can spend must come from this code — a hostile message can reference any number
 * of parts at any claimed size, and each fetch is an IMAP connection to the user's own server.
 */

let created: Blob[];
beforeEach(() => {
  created = [];
  (globalThis as { URL: unknown }).URL = {
    createObjectURL: (b: Blob) => {
      created.push(b);
      return `blob:${created.length}`;
    },
    revokeObjectURL: () => {},
  };
});
afterEach(() => {
  delete (globalThis as { URL?: unknown }).URL;
});

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString("base64");

function makeAdapter(over: Partial<EngineAdapter> = {}): EngineAdapter {
  return {
    sync: async () => ({ changes: [], cursor: "1", hasMore: false }) as never,
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    listAttachments: async () => [],
    fetchAttachment: async () => new Blob([PNG_BYTES], { type: "image/png" }),
    ...over,
  };
}

function wire(o: Partial<AttachmentWire> = {}): AttachmentWire {
  return {
    id: o.id ?? "a1",
    filename: o.filename ?? "logo.png",
    contentType: o.contentType ?? "image/png",
    sizeBytes: o.sizeBytes ?? PNG_BYTES.length,
    inline: o.inline ?? true,
    contentId: o.contentId === undefined ? "logo@corp" : o.contentId,
    messageId: o.messageId ?? "m1",
  };
}

/** An engine whose adapter counts byte fetches — the spend every assertion here is about. */
function engineWith(parts: AttachmentWire[], over: Partial<EngineAdapter> = {}) {
  const fetched: string[] = [];
  const engine = new OhmailEngine({
    adapter: makeAdapter({
      listAttachments: async () => parts,
      fetchAttachment: async (id: string) => {
        fetched.push(id);
        return new Blob([PNG_BYTES], { type: "image/png" });
      },
      ...over,
    }),
  });
  return { engine, fetched };
}

describe("loadInlineImages — the automatic fetch of what the document references", () => {
  it("mints a referenced image as a data: URI, from the part's own bytes", async () => {
    const { engine, fetched } = engineWith([wire({ id: "a1", contentId: "logo@corp" })]);
    await engine.loadInlineImages("m1", ["logo@corp"]);

    const map = engine.inlineImagesOf("m1");
    expect(map.get("logo@corp")).toBe(`data:image/png;base64,${PNG_B64}`);
    expect(fetched).toEqual(["a1"]);
  });

  it("the wire's contentId reaches the item, and its absence is null", async () => {
    const { engine } = engineWith([
      wire({ id: "a1", contentId: "logo@corp" }),
      { ...wire({ id: "a2", inline: false, filename: "invoice.pdf", contentType: "application/pdf" }), contentId: undefined },
    ]);
    await engine.loadAttachments("m1");
    const held = engine.attachmentsOf("m1", { includeInlineParts: true });
    if (held.state !== "ready") throw new Error(`expected ready, got ${held.state}`);
    expect(held.items.find((i) => i.id === "a1")!.contentId).toBe("logo@corp");
    expect(held.items.find((i) => i.id === "a2")!.contentId).toBeNull();
  });

  it("fetches ONLY what the document references — an unreferenced part costs nothing", async () => {
    const { engine, fetched } = engineWith([
      wire({ id: "a1", contentId: "shown@corp" }),
      wire({ id: "a2", contentId: "unreferenced@corp" }),
    ]);
    await engine.loadInlineImages("m1", ["shown@corp"]);
    expect(fetched).toEqual(["a1"]);
    expect(engine.inlineImagesOf("m1").has("unreferenced@corp")).toBe(false);
  });

  it("never pays for a part whose DECLARED type or size the mint would refuse anyway", async () => {
    const { engine, fetched } = engineWith([
      // Not a raster image: a cid-referenced stylesheet, calendar, or SVG is not drawn by <img>.
      wire({ id: "svg", contentId: "vec@corp", contentType: "image/svg+xml" }),
      wire({ id: "cal", contentId: "cal@corp", contentType: "text/calendar" }),
      // Declared over the per-part ceiling.
      wire({ id: "big", contentId: "big@corp", sizeBytes: INLINE_IMAGE_MAX_BYTES + 1 }),
    ]);
    await engine.loadInlineImages("m1", ["vec@corp", "cal@corp", "big@corp"]);
    expect(fetched).toEqual([]);
    expect(engine.inlineImagesOf("m1").size).toBe(0);
  });

  it("a cid: on a NON-IMAGE part — a PDF — renders nothing inline and costs nothing", async () => {
    /**
     * The body may reference any part it likes; only the four raster types are ever minted.
     * A referenced PDF stays exactly what it was: a row in the Files list (mime.ts marks it
     * `inline`, and the strip lists every inline part), fetched only by a human press.
     */
    const { engine, fetched } = engineWith([
      wire({ id: "pdf", contentId: "doc@corp", contentType: "application/pdf", filename: "terms.pdf" }),
    ]);
    await engine.loadInlineImages("m1", ["doc@corp"]);
    expect(fetched).toEqual([]);
    expect(engine.inlineImagesOf("m1").size).toBe(0);
    // Still listed — the strip's widened read reaches it, so the file is not hidden by the ref.
    await engine.loadAttachments("m1");
    const held = engine.attachmentsOf("m1", { includeInlineParts: true });
    if (held.state !== "ready") throw new Error(`expected ready, got ${held.state}`);
    expect(held.items.map((i) => i.filename)).toEqual(["terms.pdf"]);
  });

  it("two parts sharing one Content-ID: the FIRST in wire order wins, deterministically", async () => {
    /**
     * RFC 5322 does not stop a sender minting the same id twice. The join is `find` over wire
     * order, so the earlier part's bytes answer the reference on every open — never a mixture,
     * never the other part on a re-read. Mutation: make the lookup take the LAST match — the
     * fetched id and the minted bytes both go red.
     */
    const first = new Blob([new Uint8Array([1, 1, 1])], { type: "image/png" });
    const second = new Blob([new Uint8Array([2, 2, 2])], { type: "image/png" });
    const fetched: string[] = [];
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [
          wire({ id: "a-first", contentId: "dup@corp" }),
          wire({ id: "a-second", contentId: "dup@corp" }),
        ],
        fetchAttachment: async (id: string) => {
          fetched.push(id);
          return id === "a-first" ? first : second;
        },
      }),
    });
    await engine.loadInlineImages("m1", ["dup@corp"]);
    expect(fetched).toEqual(["a-first"]);
    expect(engine.inlineImagesOf("m1").get("dup@corp"))
      .toBe(`data:image/png;base64,${Buffer.from([1, 1, 1]).toString("base64")}`);
  });

  it("a part whose declared size LIED small is refused at the mint, on the real byte count", async () => {
    const liar = new Blob([new Uint8Array(INLINE_IMAGE_MAX_BYTES + 1)], { type: "image/png" });
    let asks = 0;
    const { engine } = engineWith(
      [wire({ id: "a1", contentId: "logo@corp", sizeBytes: 10 })],
      {
        fetchAttachment: async () => {
          asks += 1;
          return liar;
        },
      },
    );
    await engine.loadInlineImages("m1", ["logo@corp"]);
    // The fetch happened — a claim about real bytes can only be tested by paying for it once —
    // but no URI was minted, so the srcdoc never swallows megabytes the metadata never admitted.
    expect(asks).toBe(1);
    expect(engine.inlineImagesOf("m1").size).toBe(0);
  });

  it(`stops at ${INLINE_IMAGE_MAX_PARTS} parts per message, in the order the document references them`, async () => {
    const parts = Array.from({ length: INLINE_IMAGE_MAX_PARTS + 3 }, (_, i) =>
      wire({ id: `a${i}`, contentId: `cid${i}@corp` }),
    );
    const { engine, fetched } = engineWith(parts);
    await engine.loadInlineImages("m1", parts.map((p) => p.contentId!));
    expect(fetched.length).toBe(INLINE_IMAGE_MAX_PARTS);
    // Reference order: the first images in the document won the budget.
    expect(fetched[0]).toBe("a0");
    expect(fetched[INLINE_IMAGE_MAX_PARTS - 1]).toBe(`a${INLINE_IMAGE_MAX_PARTS - 1}`);
  });

  it("a part that FAILED is not re-asked by a later pass — automation may not retry a refusal", async () => {
    let asks = 0;
    const { engine } = engineWith(
      [wire({ id: "a1", contentId: "logo@corp" })],
      {
        fetchAttachment: async () => {
          asks += 1;
          throw new Error("mail server unavailable");
        },
      },
    );
    await engine.loadInlineImages("m1", ["logo@corp"]);
    expect(asks).toBe(1);
    expect(engine.inlineImagesOf("m1").size).toBe(0);

    await engine.loadInlineImages("m1", ["logo@corp"]);
    expect(asks, "a re-render's re-ask must not become a second IMAP connection").toBe(1);
  });

  it("an image already minted is not fetched again, and the map identity is stable between asks", async () => {
    const { engine, fetched } = engineWith([wire({ id: "a1", contentId: "logo@corp" })]);
    await engine.loadInlineImages("m1", ["logo@corp"]);
    const first = engine.inlineImagesOf("m1");

    await engine.loadInlineImages("m1", ["logo@corp"]);
    expect(fetched).toEqual(["a1"]);
    expect(engine.inlineImagesOf("m1")).toBe(first);
  });

  it("releaseAttachments drops the minted URIs with the rest of the message's byte state", async () => {
    const { engine } = engineWith([wire({ id: "a1", contentId: "logo@corp" })]);
    await engine.loadInlineImages("m1", ["logo@corp"]);
    expect(engine.inlineImagesOf("m1").size).toBe(1);

    engine.releaseAttachments("m1");
    expect(engine.inlineImagesOf("m1").size).toBe(0);
  });

  it("is a no-op for a client with no attachment service — absence is a real answer", async () => {
    const engine = new OhmailEngine({
      adapter: {
        sync: async () => ({ changes: [], cursor: "1", hasMore: false }) as never,
        mutate: async () => ({ changes: [], seq: null }),
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async () => null,
      },
    });
    await engine.loadInlineImages("m1", ["logo@corp"]);
    expect(engine.inlineImagesOf("m1").size).toBe(0);
  });
});
