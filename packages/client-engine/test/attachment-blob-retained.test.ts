import type { AttachmentWire } from "@ohmail/wire";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OhmailEngine } from "../src/engine.js";
import type { EngineAdapter } from "../src/adapters/adapter.js";

/**
 * THE ENGINE RETAINS THE FETCHED BYTES, AND AS THE POST-DOWNGRADE TYPED BLOB.
 *
 * The Quick-Look preview parses a PDF or a text part from these bytes directly, because it must
 * NOT re-`fetch` the object URL — `connect-src 'self'` refuses a `blob:` fetch on the live host,
 * a fact no jsdom test can see. So the engine holds the Blob beside the URL. The security-critical
 * property is that it holds the DOWNGRADED blob: an `image/svg+xml` part is
 * `application/octet-stream`, so a consumer that minted its own URL from it could not run the SVG's
 * script as ohmail. This is the structural test that would fail if the wire blob were exposed.
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

function makeAdapter(over: Partial<EngineAdapter> = {}): EngineAdapter {
  return {
    sync: async () => ({ changes: [], cursor: "1", hasMore: false }) as never,
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    listAttachments: async () => [],
    fetchAttachment: async () => new Blob(["x"]),
    ...over,
  };
}

function wire(o: Partial<AttachmentWire> = {}): AttachmentWire {
  return {
    id: o.id ?? "a1",
    filename: o.filename ?? "file.bin",
    contentType: o.contentType ?? "application/octet-stream",
    sizeBytes: o.sizeBytes ?? 10,
    inline: o.inline ?? false,
    messageId: o.messageId ?? "m1",
  };
}

describe("attachmentBlobOf — the retained bytes", () => {
  it("a renderable image keeps its type, and the retained blob is the very one the URL was minted from", async () => {
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [wire({ id: "a1", contentType: "image/png", filename: "p.png" })],
        fetchAttachment: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
      }),
    });
    await engine.loadAttachments("m1");
    await engine.openAttachment("m1", "a1");

    const blob = engine.attachmentBlobOf("m1", "a1");
    expect(blob).toBeInstanceOf(Blob);
    expect(blob!.type).toBe("image/png");
    // Mint and retention are one act: the bytes a preview parses are the bytes the browser renders.
    expect(created[created.length - 1]).toBe(blob);
  });

  it("an SVG is retained as application/octet-stream, NEVER image/svg+xml", async () => {
    // The mutation this bites: `mintObjectUrl` returning the wire blob (or the engine storing it)
    // instead of the re-typed one. That blob still says `image/svg+xml`, and a preview that minted
    // its own URL from it and navigated to it would execute the SVG's script as ohmail.
    const wireBlob = new Blob(["<svg onload='steal()'></svg>"], { type: "image/svg+xml" });
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [wire({ id: "s1", contentType: "image/svg+xml", filename: "x.svg" })],
        fetchAttachment: async () => wireBlob,
      }),
    });
    await engine.loadAttachments("m1");
    await engine.openAttachment("m1", "s1");

    const blob = engine.attachmentBlobOf("m1", "s1")!;
    expect(blob.type).toBe("application/octet-stream");
    expect(blob).not.toBe(wireBlob);
    // The wire blob is untouched; the point is the engine never hands it out.
    expect(wireBlob.type).toBe("image/svg+xml");
  });

  it("is undefined before the bytes are fetched, and again once the list is released", async () => {
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [wire({ id: "a1", contentType: "application/pdf" })],
        fetchAttachment: async () => new Blob(["%PDF-1.7"], { type: "application/pdf" }),
      }),
    });
    await engine.loadAttachments("m1");
    expect(engine.attachmentBlobOf("m1", "a1"), "idle: nothing fetched yet").toBeUndefined();

    await engine.openAttachment("m1", "a1");
    expect(engine.attachmentBlobOf("m1", "a1")).toBeInstanceOf(Blob);

    engine.releaseAttachments("m1");
    expect(engine.attachmentBlobOf("m1", "a1"), "released with the list, like the URL").toBeUndefined();
  });
});
