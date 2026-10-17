import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "../app/shell/engine-config.js";

/**
 * THE WEB DOOR DRAWS AN EMBEDDED PICTURE BY ITS OBJECT URL. `createEngine` — the construction the
 * shell performs, over its gate and HTTP adapter — says `inlineImageUrls: "object"`, so the map the
 * mail frame resolves `cid:` against holds the part's own `blob:` URL, never a `data:` copy. The
 * option is said by the door, not detected: dropped, the engine falls back to `data:` and this pin
 * goes red (`desktop`'s twin is `apps/desktop/test/inline-pictures-desktop-door.test.ts`).
 */

const ARMED = { NEXT_PUBLIC_API_BASE: "/api" } as const;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const originalFetch = globalThis.fetch;

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  // Stubbed BEFORE `createEngine`: the adapter binds the global at construction.
  globalThis.fetch = ((url: string) => {
    if (url.endsWith("/api/messages/m1/attachments")) {
      return Promise.resolve(json(200, {
        items: [{ id: "att-1", filename: "logo.png", contentType: "image/png", sizeBytes: PNG.length, inline: true, contentId: "logo@corp", messageId: "m1" }],
      }));
    }
    if (url.endsWith("/api/attachments/att-1")) {
      return Promise.resolve(new Response(PNG, { status: 200, headers: { "content-type": "image/png" } }));
    }
    return Promise.resolve(json(404, { error: { code: "not_found", message: "no stub for this route" } }));
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("the web door's embedded pictures", () => {
  it("are the parts' own object URLs, the ones the strip holds", async () => {
    const engine = createEngine(false, ARMED);
    await engine.loadInlineImages("m1", ["logo@corp"]);
    const drawn = engine.inlineImagesOf("m1").get("logo@corp");
    expect(drawn, "the web door minted a data: copy").toMatch(/^blob:/);
    const held = engine.attachmentsOf("m1", { includeInlineParts: true });
    expect(held.state === "ready" ? held.items[0]?.objectUrl : null).toBe(drawn);
    engine.releaseAttachments("m1");
  });
});
