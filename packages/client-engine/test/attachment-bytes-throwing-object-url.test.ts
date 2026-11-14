import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OhmailEngine } from "../src/engine.js";
import { FixturesAdapter } from "@ohmail/testing/adapter";
import type { AttachmentWire, EngineAdapter } from "../src/adapters/adapter.js";

/**
 * ═══ THE RUNTIME'S BYTE LAYER FAILS PRESENT-AND-THROWING, NOT ABSENT ═════════════════════════
 *
 * Measured on a paired Android device (a preview build against the hosted service): the
 * rich reader drew every cid picture blank and every tile press answered the failed sentence
 * while HTTP served the bytes. The sibling control (`attachment-bytes-without-object-url`)
 * deletes `URL.createObjectURL` — but the phone's runtime INSTALLS one: Expo's winter runtime
 * attaches `createObjectURL` to its URL polyfill, and it throws `Cannot create URL for blob`
 * whenever the native blob store exports no URI scheme (every Android app without a
 * `blob_provider_authority` resource). A double that makes the capability ABSENT measures
 * nothing when production's shape is PRESENT-AND-THROWING — this file is that shape, verbatim:
 * a working URL class, a throwing mint, a no-op revoke, both installed exactly as the runtime
 * installs them. Two more measured shapes of the same family ride along: a Blob whose
 * `arrayBuffer()` rejects the way the app's FileReader polyfill rejects (`blob read failed`),
 * and React Native's Blob constructor, which throws on any ArrayBufferView part.
 *
 * Mutations watched (each applied, red, restored cmp-proven):
 *  · unguard `ObjectUrlLedger.mint`'s call ⇒ the first three cases red;
 *  · unguard the per-part inline mint ⇒ "one unreadable part" red;
 *  · make `seedSentAttachments` build the Blob itself again ⇒ the sent-seed case red.
 */

const urlGlobal = globalThis.URL as unknown as {
  createObjectURL?: (b: Blob) => string;
  revokeObjectURL?: (u: string) => void;
};
const originalCreate = urlGlobal.createObjectURL;
const originalRevoke = urlGlobal.revokeObjectURL;

beforeEach(() => {
  // Expo winter's exact install: URL parses fine, the mint throws, the revoke does nothing.
  urlGlobal.createObjectURL = () => {
    throw new Error("Cannot create URL for blob");
  };
  urlGlobal.revokeObjectURL = () => {};
});
afterEach(() => {
  urlGlobal.createObjectURL = originalCreate;
  urlGlobal.revokeObjectURL = originalRevoke;
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

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

describe("openAttachment where the mint is present and throwing", () => {
  it("reaches ready WITH the typed blob and no objectUrl — the throw is read as absence", async () => {
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [wire({ id: "a1", contentType: "application/pdf", filename: "r.pdf" })],
        fetchAttachment: async () => new Blob([PNG], { type: "application/pdf" }),
      }),
    });
    await engine.loadAttachments("m1");
    await engine.openAttachment("m1", "a1");

    const list = engine.attachmentsOf("m1");
    expect(list.state).toBe("ready");
    const item = list.state === "ready" ? list.items[0]! : undefined;
    expect(item!.state).toBe("ready");
    expect(item!.error).toBeUndefined();
    expect(item!.objectUrl).toBeUndefined();
    const blob = engine.attachmentBlobOf("m1", "a1");
    expect(blob).toBeInstanceOf(Blob);
    expect(blob!.type).toBe("application/pdf");
  });

  it("the held bytes satisfy a second press — no re-fetch", async () => {
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

  it("the cid mint feeds from the held bytes", async () => {
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [
          wire({ id: "i1", inline: true, contentId: "c1", contentType: "image/png", sizeBytes: PNG.length }),
        ],
        fetchAttachment: async () => new Blob([PNG], { type: "image/png" }),
      }),
    });
    await engine.loadAttachments("m1");
    await engine.loadInlineImages("m1", ["c1"]);
    const map = engine.inlineImagesOf("m1");
    expect(map.get("c1")).toMatch(/^data:image\/png;base64,/);
  });

  it("one part whose byte read fails costs that part alone — the app polyfill's own rejection", async () => {
    // The device shape: RN Blob has no arrayBuffer(); the app supplies one over FileReader,
    // whose wrapper rejects `blob read failed`. Same class, same wrapping, same partial state
    // (type and size readable, bytes not).
    const bad = new Blob([PNG], { type: "image/png" });
    Object.defineProperty(bad, "arrayBuffer", {
      value: () => Promise.reject(new Error("blob read failed")),
      configurable: true,
    });
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [
          wire({ id: "i1", inline: true, contentId: "c1", contentType: "image/png", sizeBytes: PNG.length }),
          wire({ id: "i2", inline: true, contentId: "c2", contentType: "image/png", sizeBytes: PNG.length }),
        ],
        fetchAttachment: async (id) => (id === "i1" ? bad : new Blob([PNG], { type: "image/png" })),
      }),
    });
    await engine.loadAttachments("m1");
    await engine.loadInlineImages("m1", ["c1", "c2"]);
    const map = engine.inlineImagesOf("m1");
    expect(map.get("c1")).toBeUndefined();
    expect(map.get("c2")).toMatch(/^data:image\/png;base64,/);
  });
});

describe("the sent-copy seed where a Blob cannot be built from bytes", () => {
  const RealBlob = globalThis.Blob;
  beforeEach(() => {
    // React Native's Blob, verbatim: `BlobManager.createFromParts` refuses byte parts.
    (globalThis as { Blob: unknown }).Blob = class RNShapedBlob extends RealBlob {
      constructor(parts?: BlobPart[], opts?: BlobPropertyBag) {
        for (const part of parts ?? []) {
          if (part instanceof ArrayBuffer || ArrayBuffer.isView(part)) {
            throw new Error("Creating blobs from 'ArrayBuffer' and 'ArrayBufferView' are not supported");
          }
        }
        super(parts, opts);
      }
    };
  });
  afterEach(() => {
    (globalThis as { Blob: unknown }).Blob = RealBlob;
  });

  it("the send confirms and the copy's list is seeded with its bytes, not thrown away", async () => {
    const inner = new FixturesAdapter();
    const adapter: EngineAdapter = {
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: () => inner.fetchBody(),
      sync: (p) => inner.sync(p),
      // Present so `attachmentsAvailable()` holds — the copy's list must come from the SEED;
      // a fetch here would be the fabricated-id 404 the seed exists to prevent.
      listAttachments: async () => [],
      fetchAttachment: async () => {
        throw new Error("must not fetch — the seed holds the copy's list");
      },
      mutate: async (m, o) => {
        const out = await inner.mutate(m, o);
        // The server's word that the mail left — what arms the optimistic Sent copy.
        return { ...out, providerMessageId: "<fix021-seed@ohmail.test>" };
      },
    };
    const engine = new OhmailEngine({ adapter });
    await engine.start();

    const res = await engine.mutate({
      kind: "mail_send",
      inReplyTo: "giulia",
      body: "Gerne — Donnerstag?",
      attachments: [{ filename: "photo.jpg", contentType: "image/jpeg", contentBase64: Buffer.from(PNG).toString("base64") }],
    });
    expect(res.status).toBe("confirmed");

    const copy = engine.read().list<{ id: string; local?: boolean }>("message").find((x) => x.local === true);
    expect(copy, "no optimistic Sent copy was materialised").toBeTruthy();
    const list = engine.attachmentsOf(copy!.id);
    expect(list.state).toBe("ready");
    const item = list.state === "ready" ? list.items[0]! : undefined;
    expect(item!.state).toBe("ready");
    expect(item!.filename).toBe("photo.jpg");
    // The seed holds the copy's ONLY bytes — `bytesBlob` carries them where the platform will
    // not build a Blob; the URL is still absent, the mint having thrown.
    expect(item!.blob).toBeTruthy();
    expect(new Uint8Array(await item!.blob!.arrayBuffer())).toEqual(PNG);
    expect(item!.objectUrl).toBeUndefined();
  });
});
