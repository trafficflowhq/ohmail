import type { AttachmentWire } from "@ohmail/wire";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OhmailEngine } from "../src/engine.js";
import type { EngineAdapter } from "../src/adapters/adapter.js";

/**
 * ═══ A RUNTIME WITH NO `URL.createObjectURL` STILL GETS THE BYTES ════════════════════════════
 *
 * Every React Native phone is such a runtime, and the defect this pins was measured on a paired
 * device: `openAttachment` patched `ready` with the blob SPREAD CONDITIONALLY on the URL mint,
 * so the phone's items landed ready-with-no-blob while HTTP answered 200 — every tile press
 * failed and every embedded picture starved. The URL is a browser convenience, never the byte
 * carrier. Node suites were green because node HAS `createObjectURL` — this file is the
 * device-shaped control: the global carries none, exactly like the phone.
 * Mutation watched (applied, red, restored `cmp`-proven): the unconditional `blob: minted.blob`
 * in `openAttachment`'s ready patch back to the conditional spread ⇒ three cases red.
 */

beforeEach(() => {
  // RN-shaped: a URL global exists for parsing, but no createObjectURL and no revoke.
  (globalThis as { URL: unknown }).URL = {};
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
    contentId: o.contentId ?? null,
  };
}

describe("openAttachment where nothing can mint a URL", () => {
  it("reaches ready WITH the typed blob and no objectUrl", async () => {
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [wire({ id: "a1", contentType: "application/pdf", filename: "r.pdf" })],
        fetchAttachment: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "application/pdf" }),
      }),
    });
    await engine.loadAttachments("m1");
    await engine.openAttachment("m1", "a1");

    const list = engine.attachmentsOf("m1");
    expect(list.state).toBe("ready");
    const item = list.state === "ready" ? list.items[0]! : undefined;
    expect(item!.state).toBe("ready");
    expect(item!.objectUrl).toBeUndefined();
    const blob = engine.attachmentBlobOf("m1", "a1");
    expect(blob).toBeInstanceOf(Blob);
    expect(blob!.type).toBe("application/pdf");
  });

  it("the held bytes satisfy a second press — no re-fetch without a URL", async () => {
    let fetches = 0;
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [wire({ id: "a1" })],
        fetchAttachment: async () => {
          fetches += 1;
          return new Blob(["bytes"]);
        },
      }),
    });
    await engine.loadAttachments("m1");
    await engine.openAttachment("m1", "a1");
    await engine.openAttachment("m1", "a1");
    expect(fetches).toBe(1);
  });

  it("the mime downgrade survives the missing URL — an SVG is never held as image/svg+xml", async () => {
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [wire({ id: "s1", contentType: "image/svg+xml", filename: "x.svg" })],
        fetchAttachment: async () => new Blob(["<svg/>"], { type: "image/svg+xml" }),
      }),
    });
    await engine.loadAttachments("m1");
    await engine.openAttachment("m1", "s1");
    expect(engine.attachmentBlobOf("m1", "s1")!.type).toBe("application/octet-stream");
  });

  it("the inline-image mint feeds from the held bytes — the phone's cid pictures draw", async () => {
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [
          wire({ id: "i1", contentType: "image/png", filename: "logo.png", inline: true, contentId: "logo@corp", sizeBytes: 3 }),
        ],
        fetchAttachment: async () => new Blob([new Uint8Array([9, 8, 7])], { type: "image/png" }),
      }),
    });
    await engine.loadAttachments("m1");
    await engine.loadInlineImages("m1", ["logo@corp"]);
    const minted = engine.inlineImagesOf("m1").get("logo@corp");
    expect(minted).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/);
  });
});
