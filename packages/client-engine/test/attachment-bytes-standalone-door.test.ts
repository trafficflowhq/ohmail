import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OhmailEngine } from "../src/engine.js";
import { HttpAdapter } from "../src/adapters/http-adapter.js";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import { bytesBlob, canBuildBlobFromBytes, responseBlob, retypedBlob } from "../src/bytes-blob.js";
import type { EngineAdapter } from "../src/adapters/adapter.js";

/**
 * ═══ THE RESPONSE THE APP MADE OF ITSELF ═════════════════════════════════════════════════════
 *
 * Measured on the Android live-mailbox rig (RIG-022's AVD, the standalone door against a real
 * IMAP server, 2026-09-20): with the paired door's attachment fix in the build, the cid picture
 * still drew blank and the tile still answered "Couldn't open this file.", and NOTHING was
 * logged. The seam is not the object-URL mint — it is one line earlier. React Native's Blob is
 * native-backed and `BlobManager.createFromParts` throws on every ArrayBuffer and ArrayBufferView
 * part, so `res.blob()` works only for a response the PLATFORM delivered (XHR hands back a native
 * blob, which the polyfill returns untouched). On the standalone door the response is built
 * inside the app — the local engine answers `new Response(<ArrayBuffer>)` — and the polyfill then
 * constructs the Blob itself, which the platform refuses. The paired door never meets it.
 *
 * The doubles here fail that way, with the wrapping and the partial state:
 *  · `RnBlob` refuses an ArrayBuffer or view part and accepts strings and blobs, and only the
 *    PLATFORM (`RnBlob.native`) can make one from bytes;
 *  · `RnResponse` marks the body USED BEFORE it constructs, exactly as whatwg-fetch does, so a
 *    fix that caught `blob()` and then asked for `arrayBuffer()` would read "Already read" —
 *    asserted below, because that is the fix this seam invites and it does not work;
 *  · `blob()` throws SYNCHRONOUSLY, as the polyfill's does.
 *
 * Mutations watched (applied, red, restored cmp-proven): the capability probe in `responseBlob`
 * forced true ⇒ the standalone arms red; `retypedBlob`'s carrier branch removed ⇒ the downgrade
 * arm red; `bytesBlob`'s catch removed ⇒ every standalone arm red.
 */

const RealBlob = globalThis.Blob;

/** React Native's Blob. Only the platform can make one from bytes; this class is what JS gets. */
class RnBlob {
  readonly type: string;
  private readonly bytes: Uint8Array;

  /** What the platform hands back — an XHR response body. Never reachable from JS. */
  static native(bytes: Uint8Array, type: string): RnBlob {
    const b = Object.create(RnBlob.prototype) as { bytes: Uint8Array; type: string };
    b.bytes = bytes;
    b.type = type;
    return b as unknown as RnBlob;
  }

  constructor(parts: readonly unknown[] = [], opts?: { type?: string }) {
    const out: number[] = [];
    for (const part of parts) {
      if (part instanceof ArrayBuffer || ArrayBuffer.isView(part)) {
        throw new Error("Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not supported");
      }
      const text = part instanceof RnBlob ? new TextDecoder().decode(part.bytes) : String(part);
      for (const byte of new TextEncoder().encode(text)) out.push(byte);
    }
    this.bytes = new Uint8Array(out);
    this.type = opts?.type ?? "";
  }

  get size(): number { return this.bytes.byteLength; }

  /** The app's own polyfill over the native FileReader (`src/polyfills/blob-arraybuffer.ts`). */
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.bytes.buffer.slice(this.bytes.byteOffset, this.bytes.byteOffset + this.bytes.byteLength) as ArrayBuffer;
  }
}

/** whatwg-fetch's Response over a body the app built, or over one the platform delivered. */
class RnResponse {
  bodyUsed = false;
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Headers;
  private readonly bodyArrayBuffer?: ArrayBuffer;
  private readonly bodyBlob?: RnBlob;

  constructor(body: ArrayBuffer | RnBlob, init: { status?: number; headers?: Record<string, string> } = {}) {
    if (body instanceof RnBlob) this.bodyBlob = body;
    else this.bodyArrayBuffer = body;
    this.status = init.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = new Headers(init.headers ?? {});
  }

  blob(): Promise<Blob> {
    if (this.bodyUsed) return Promise.reject(new TypeError("Already read"));
    this.bodyUsed = true;
    if (this.bodyBlob) return Promise.resolve(this.bodyBlob as unknown as Blob);
    // Synchronous, as the polyfill's is — and the platform refuses it.
    return Promise.resolve(new (globalThis.Blob as unknown as new (p: unknown[]) => Blob)([this.bodyArrayBuffer!]));
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    if (this.bodyUsed) return Promise.reject(new TypeError("Already read"));
    this.bodyUsed = true;
    if (this.bodyArrayBuffer) return Promise.resolve(this.bodyArrayBuffer);
    return this.bodyBlob!.arrayBuffer();
  }
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);

const asArrayBuffer = (b: Uint8Array): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** The engine over the real HttpAdapter, with one message carrying a PDF and a cid picture. */
function phoneEngine(bodyOf: (bytes: Uint8Array, type: string) => ArrayBuffer | RnBlob): {
  engine: OhmailEngine;
  byteCalls: string[];
} {
  const byteCalls: string[] = [];
  const items = [
    { id: "a1", filename: "notes.pdf", contentType: "application/pdf", sizeBytes: PDF.byteLength, inline: false, contentId: null, messageId: "m1" },
    { id: "i1", filename: "sig.png", contentType: "image/png", sizeBytes: PNG.byteLength, inline: true, contentId: "cid-1", messageId: "m1" },
  ];
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  const adapter = new HttpAdapter({
    baseUrl: "/api",
    getCookie: () => "csrf-token",
    fetch: async (url: string): Promise<Response> => {
      if (url.endsWith("/attachments") ) return json({ items });
      if (url.includes("/attachments/")) {
        const id = url.slice(url.lastIndexOf("/") + 1);
        byteCalls.push(id);
        const [bytes, type] = id === "i1" ? [PNG, "image/png"] : [PDF, "application/pdf"];
        return new RnResponse(bodyOf(bytes, type), { headers: { "content-type": type } }) as unknown as Response;
      }
      if (url.includes("download-all")) {
        byteCalls.push("zip");
        return new RnResponse(bodyOf(PDF, "application/zip"), { headers: { "content-type": "application/zip" } }) as unknown as Response;
      }
      return json({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date(0).toISOString() });
    },
  });
  return { engine: new OhmailEngine({ adapter: adapter as unknown as EngineAdapter }), byteCalls };
}

beforeEach(() => {
  (globalThis as { Blob: unknown }).Blob = RnBlob;
});
afterEach(() => {
  (globalThis as { Blob: unknown }).Blob = RealBlob;
});

describe("the double is the runtime, not a convenience", () => {
  it("React Native refuses a Blob built from bytes, and the platform's own still arrives", async () => {
    expect(() => new (globalThis.Blob as unknown as new (p: unknown[]) => Blob)([PDF]))
      .toThrow(/ArrayBuffer/);
    expect(canBuildBlobFromBytes()).toBe(false);
    const native = RnBlob.native(PDF, "application/pdf");
    expect(new Uint8Array(await native.arrayBuffer())).toEqual(PDF);
  });

  it("the response marks its body USED before it throws, so catching blob() and asking for arrayBuffer() is too late", async () => {
    const res = new RnResponse(asArrayBuffer(PDF), { headers: { "content-type": "application/pdf" } });
    // SYNCHRONOUS, as whatwg-fetch's is — `await res.blob()` never even gets a promise to reject.
    expect(() => res.blob()).toThrow(/ArrayBuffer/);
    await expect(res.arrayBuffer()).rejects.toThrow(/Already read/);
  });
});

describe("the standalone door — a response the app built", () => {
  const standalone = () => phoneEngine((bytes) => asArrayBuffer(bytes));

  it("a pressed attachment lands ready and carries its exact bytes", async () => {
    const { engine } = standalone();
    await engine.start();
    await engine.loadAttachments("m1");
    await engine.openAttachment("m1", "a1");

    const list = engine.attachmentsOf("m1");
    const item = list.state === "ready" ? list.items.find((i) => i.id === "a1") : undefined;
    expect(item?.state, `the press refused: ${item?.error ?? "(no error recorded)"}`).toBe("ready");
    const blob = engine.attachmentBlobOf("m1", "a1")!;
    expect(blob, "the item is ready with no byte carrier").toBeTruthy();
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PDF);
    expect(blob.size).toBe(PDF.byteLength);
  });

  it("an embedded picture draws — the cid pass mints its data URI", async () => {
    const { engine } = standalone();
    await engine.start();
    await engine.loadInlineImages("m1", ["cid-1"]);
    const minted = engine.inlineImagesOf("m1");
    expect(minted.size, "no cid picture was minted").toBe(1);
    expect(minted.get("cid-1")).toMatch(/^data:image\/png;base64,/);
  });

  it("download-all returns the zip's bytes", async () => {
    const { engine } = standalone();
    await engine.start();
    await engine.loadAttachments("m1");
    const zip = await engine.downloadAllAttachments("m1");
    expect(zip, "download-all answered nothing").toBeTruthy();
    expect(new Uint8Array(await zip!.arrayBuffer())).toEqual(PDF);
  });
});

describe("the paired door — a response the platform delivered — is unchanged", () => {
  it("a pressed attachment lands ready and carries its exact bytes", async () => {
    const { engine } = phoneEngine((bytes, type) => RnBlob.native(bytes, type));
    await engine.start();
    await engine.loadAttachments("m1");
    await engine.openAttachment("m1", "a1");
    const blob = engine.attachmentBlobOf("m1", "a1")!;
    expect(blob, "the paired door lost its bytes").toBeTruthy();
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PDF);
  });
});

describe("the carrier answers what the product reads off a Blob", () => {
  it("size, type, arrayBuffer, text and slice", async () => {
    const carrier = bytesBlob(new TextEncoder().encode("BEGIN:VCALENDAR — Grüße"), "text/calendar");
    expect(carrier.size).toBe(new TextEncoder().encode("BEGIN:VCALENDAR — Grüße").byteLength);
    expect(carrier.type).toBe("text/calendar");
    expect(await carrier.text()).toBe("BEGIN:VCALENDAR — Grüße");
    expect(new Uint8Array(await carrier.slice(0, 5).arrayBuffer())).toEqual(new TextEncoder().encode("BEGIN"));
  });

  it("text() decodes UTF-8 where the runtime has no TextDecoder", async () => {
    const D = globalThis.TextDecoder;
    const bytes = new TextEncoder().encode("Grüße 😀");
    try {
      (globalThis as { TextDecoder?: unknown }).TextDecoder = undefined;
      expect(await bytesBlob(bytes, "text/plain").text()).toBe("Grüße 😀");
    } finally {
      (globalThis as { TextDecoder?: unknown }).TextDecoder = D;
    }
  });

  it("a re-type keeps the bytes instead of stringifying the carrier", async () => {
    const carrier = bytesBlob(PDF, "application/pdf");
    const typed = retypedBlob(carrier, "application/octet-stream");
    expect(typed.type).toBe("application/octet-stream");
    expect(new Uint8Array(await typed.arrayBuffer()), "the re-type replaced the file with [object Object]").toEqual(PDF);
  });

  it("responseBlob reads a platform-delivered body through the same one door", async () => {
    const res = new RnResponse(RnBlob.native(PDF, "application/pdf"), { headers: { "content-type": "application/pdf" } });
    const blob = await responseBlob(res as unknown as Response);
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(PDF);
  });
});

describe("the sent copy's seed", () => {
  it("carries the bytes it was given, on a runtime that cannot build a Blob", async () => {
    const inner = new FixturesAdapter();
    const adapter: EngineAdapter = {
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: () => inner.fetchBody(),
      sync: (p) => inner.sync(p),
      listAttachments: async () => [],
      fetchAttachment: async () => { throw new Error("must not fetch — the seed holds the copy's list"); },
      mutate: async (m, o) => ({ ...(await inner.mutate(m, o)), providerMessageId: "<fix021-standalone@ohmail.test>" }),
    };
    const engine = new OhmailEngine({ adapter });
    await engine.start();
    const res = await engine.mutate({
      kind: "mail_send", inReplyTo: "giulia", body: "Gerne — Donnerstag?",
      attachments: [{ filename: "photo.jpg", contentType: "image/jpeg", contentBase64: Buffer.from(PNG).toString("base64") }],
    });
    expect(res.status).toBe("confirmed");
    const copy = engine.read().list<{ id: string; local?: boolean }>("message").find((x) => x.local === true);
    const list = engine.attachmentsOf(copy!.id);
    const item = list.state === "ready" ? list.items[0]! : undefined;
    expect(item!.state).toBe("ready");
    expect(item!.blob, "the phone's sent copy holds no bytes").toBeTruthy();
    expect(new Uint8Array(await item!.blob!.arrayBuffer())).toEqual(PNG);
    expect(item!.objectUrl).toBeUndefined();
  });
});
