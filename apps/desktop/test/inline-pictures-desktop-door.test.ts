import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalEngine } from "../src/bridge-fetch.js";

/**
 * THE DESKTOP WINDOW DRAWS AN EMBEDDED PICTURE BY ITS OBJECT URL. `createLocalEngine` — the engine
 * the window runs, over the shell's `engine_request` — says `inlineImageUrls: "object"`, so the map
 * the mail frame resolves `cid:` against holds the part's own `blob:` URL. A `data:` copy of twelve
 * pictures (16 MiB) grew the Linux renderer by about 1 GB; dropped, the option falls back to `data:`
 * and this pin goes red. The shell is a stand-in answering as Tauri does: one byte array per call.
 */

type Invoke = (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
const host = globalThis as { __TAURI_INTERNALS__?: { invoke: Invoke } };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

/** The shell's `engine_request` answer: [4 bytes BE: meta length][meta JSON][body]. */
function encode(status: number, body: Uint8Array, contentType: string): Uint8Array {
  const meta = new TextEncoder().encode(JSON.stringify({ status, statusText: "", h: [["content-type", contentType]] }));
  const out = new Uint8Array(4 + meta.byteLength + body.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(body, 4 + meta.byteLength);
  return out;
}
const json = (status: number, value: unknown): Uint8Array =>
  encode(status, new TextEncoder().encode(JSON.stringify(value)), "application/json");

beforeEach(() => {
  host.__TAURI_INTERNALS__ = {
    invoke: async (command, payload) => {
      if (command !== "engine_request") throw new Error(`the stand-in has no ${command}`);
      const url = String((payload as { url: string }).url);
      if (url === "/messages/m1/attachments") {
        return json(200, {
          items: [{ id: "att-1", filename: "logo.png", contentType: "image/png", sizeBytes: PNG.length, inline: true, contentId: "logo@corp", messageId: "m1" }],
        });
      }
      if (url === "/attachments/att-1") return encode(200, PNG, "image/png");
      return json(404, { error: { code: "not_found", message: "not in the stand-in" } });
    },
  };
});
afterEach(() => {
  delete host.__TAURI_INTERNALS__;
});

describe("the desktop window's embedded pictures", () => {
  it("are the parts' own object URLs, the ones the strip holds", async () => {
    const engine = createLocalEngine("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    await engine.loadInlineImages("m1", ["logo@corp"]);
    const drawn = engine.inlineImagesOf("m1").get("logo@corp");
    expect(drawn, "the desktop window minted a data: copy").toMatch(/^blob:/);
    const held = engine.attachmentsOf("m1", { includeInlineParts: true });
    expect(held.state === "ready" ? held.items[0]?.objectUrl : null).toBe(drawn);
    engine.releaseAttachments("m1");
  });
});
