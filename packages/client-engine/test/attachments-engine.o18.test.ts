import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpAdapter } from "../src/adapters/http-adapter.js";
import { OhmailEngine } from "../src/engine.js";
import { MutationRejectedError } from "../src/types.js";
import type { AttachmentWire, EngineAdapter } from "../src/adapters/adapter.js";

/**
 * Gap the engine's attachment state machine.
 *
 * The failure this slice exists to avoid is "built, tested, unreachable": the routes were shipped
 * and contract-tested with no client caller at all. So these assert on the seam a surface actually
 * touches — what `attachmentsOf` returns, which adapter calls that produces, and what happens to
 * the object URLs — rather than on the adapter in isolation.
 */

const NOOP_SYNC = { changes: [], cursor: "1", hasMore: false };

function makeAdapter(over: Partial<EngineAdapter> = {}): EngineAdapter {
  return {
    sync: async () => NOOP_SYNC as never,
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    ...over,
  };
}

function wire(o: Partial<AttachmentWire> = {}): AttachmentWire {
  return {
    id: o.id ?? "a1",
    // `??` would swallow an EXPLICIT null, which is the nameless-part case under test.
    filename: "filename" in o ? (o.filename ?? null) : "invoice.pdf",
    contentType: o.contentType ?? "application/pdf",
    sizeBytes: o.sizeBytes ?? 1234,
    inline: o.inline ?? false,
    messageId: o.messageId ?? "m1",
  };
}

/** A minimal object-URL registry so the revoke lifecycle is observable. */
let minted: string[];
let revoked: string[];
beforeEach(() => {
  minted = []; revoked = [];
  (globalThis as { URL: unknown }).URL = {
    createObjectURL: (b: Blob) => { const u = `blob:${minted.length}:${b.type}`; minted.push(u); return u; },
    revokeObjectURL: (u: string) => { revoked.push(u); },
  };
});
afterEach(() => { delete (globalThis as { URL?: unknown }).URL; });

describe("capability reporting", () => {
  it("an adapter WITHOUT the methods reports unavailable and never invents an empty list", async () => {
    const engine = new OhmailEngine({ adapter: makeAdapter() });
    expect(engine.attachmentsAvailable()).toBe(false);
    // `unavailable` and `ready: []` are different claims — the demo has no server to ask, it did
    // not ask and find nothing. Conflating them is how a UI ends up asserting a message has no
    // attachments when it simply could not look.
    expect(engine.attachmentsOf("m1")).toEqual({ state: "unavailable" });
    expect(await engine.loadAttachments("m1")).toEqual({ state: "unavailable" });
  });
});

describe("metadata", () => {
  it("maps the wire to the surface shape and FILTERS OUT inline parts", async () => {
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [
          wire({ id: "a1", filename: "invoice.pdf" }),
          wire({ id: "a2", filename: "logo.png", contentType: "image/png", inline: true }),
        ],
        fetchAttachment: async () => new Blob(["x"]),
      }),
    });

    const out = await engine.loadAttachments("m1");

    expect(out.state).toBe("ready");
    const items = (out as { items: unknown[] }).items as { id: string; mimeType: string; state: string }[];
    // The inline `cid:` logo is not a file a person means by "attachment", and the server's own
    // /files and download-all both exclude it — the strip has to agree with the zip.
    expect(items.map((i) => i.id)).toEqual(["a1"]);
    expect(items[0]!.mimeType).toBe("application/pdf");   // renamed from contentType exactly once
    expect(items[0]!.state).toBe("idle");
  });

  it("falls back to the SERVER'S OWN filename stem for a nameless part", async () => {
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [wire({ id: "zz", filename: null })],
        fetchAttachment: async () => new Blob(["x"]),
      }),
    });
    const out = await engine.loadAttachments("m1");
    // Same stem `AttachmentsService.uniqueName` uses, so the strip name equals the zip entry name.
    expect((out as { items: { filename: string }[] }).items[0]!.filename).toBe("attachment-zz.bin");
  });

  it("a message whose parts are ALL inline is `ready` with zero items, not a failure", async () => {
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [wire({ id: "a1", inline: true })],
        fetchAttachment: async () => new Blob(["x"]),
      }),
    });
    // Many flagged messages in production are exactly this. The
    // paperclip is still painted (it reads `hasAttachments`), so the surface must have a state that
    // says so honestly rather than an empty list that reads as "no attachments".
    expect(await engine.loadAttachments("m1")).toEqual({ state: "ready", items: [] });
  });

  it("single-flights concurrent metadata reads", async () => {
    const listAttachments = vi.fn(async () => [wire()]);
    const engine = new OhmailEngine({
      adapter: makeAdapter({ listAttachments, fetchAttachment: async () => new Blob(["x"]) }),
    });
    await Promise.all([engine.loadAttachments("m1"), engine.loadAttachments("m1"), engine.loadAttachments("m1")]);
    expect(listAttachments).toHaveBeenCalledTimes(1);
  });

  it("does NOT re-ask after a failure unless a human passes retry", async () => {
    const listAttachments = vi.fn(async () => { throw new Error("boom"); });
    const engine = new OhmailEngine({
      adapter: makeAdapter({ listAttachments, fetchAttachment: async () => new Blob(["x"]) }),
    });

    expect((await engine.loadAttachments("m1")).state).toBe("failed");
    await engine.loadAttachments("m1");
    await engine.loadAttachments("m1");
    // A React effect whose identity changes per render would otherwise loop against a server that
    // is already refusing, billed per attempt, for as long as the view stays open (the "No API cost without revenue behind it" invariant).
    expect(listAttachments).toHaveBeenCalledTimes(1);

    await engine.loadAttachments("m1", { retry: true });
    expect(listAttachments).toHaveBeenCalledTimes(2);
  });
});

describe("bytes", () => {
  async function ready(over: Partial<EngineAdapter> = {}, w: AttachmentWire[] = [wire()]) {
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => w,
        fetchAttachment: async () => new Blob(["bytes"], { type: "application/pdf" }),
        ...over,
      }),
    });
    await engine.loadAttachments("m1");
    return engine;
  }

  it("fetches on demand and mints an object URL", async () => {
    const engine = await ready();
    await engine.openAttachment("m1", "a1");
    const items = (engine.attachmentsOf("m1") as { items: { state: string; objectUrl?: string }[] }).items;
    expect(items[0]!.state).toBe("ready");
    expect(items[0]!.objectUrl).toBe(minted[0]);
  });

  it("a 413 becomes `too_large`, is NOT retried, and keeps the server's sentence", async () => {
    const fetchAttachment = vi.fn(async () => {
      throw Object.assign(new Error("this attachment is 90 MiB, over the 32 MiB limit"), {
        code: "payload_too_large",
      });
    });
    const engine = await ready({ fetchAttachment });

    await engine.openAttachment("m1", "a1");
    let items = (engine.attachmentsOf("m1") as { items: { state: string; error?: string }[] }).items;
    expect(items[0]!.state).toBe("too_large");
    expect(items[0]!.error).toContain("32 MiB limit");

    // Permanent: asking again cannot change the answer, so even an explicit retry must not spend
    // another IMAP connection on it.
    await engine.openAttachment("m1", "a1", { retry: true });
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
  });

  it("any other failure is `failed` and retries only on an explicit human act", async () => {
    const fetchAttachment = vi.fn(async () => { throw new Error("mail server unavailable"); });
    const engine = await ready({ fetchAttachment });

    await engine.openAttachment("m1", "a1");
    await engine.openAttachment("m1", "a1");
    expect(fetchAttachment).toHaveBeenCalledTimes(1);

    await engine.openAttachment("m1", "a1", { retry: true });
    expect(fetchAttachment).toHaveBeenCalledTimes(2);
    const items = (engine.attachmentsOf("m1") as { items: { state: string; error?: string }[] }).items;
    expect(items[0]!.state).toBe("failed");
    expect(items[0]!.error).toContain("mail server unavailable");
  });

  it("single-flights a double click into ONE IMAP connection", async () => {
    const fetchAttachment = vi.fn(async () => new Blob(["b"], { type: "application/pdf" }));
    const engine = await ready({ fetchAttachment });
    await Promise.all([engine.openAttachment("m1", "a1"), engine.openAttachment("m1", "a1")]);
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
  });

  it("does not re-fetch bytes already in the tab", async () => {
    const fetchAttachment = vi.fn(async () => new Blob(["b"], { type: "application/pdf" }));
    const engine = await ready({ fetchAttachment });
    await engine.openAttachment("m1", "a1");
    await engine.openAttachment("m1", "a1");
    expect(fetchAttachment).toHaveBeenCalledTimes(1);
  });
});

describe("the SVG blob-URL hole", () => {
  it("DOWNGRADES image/svg+xml to octet-stream so a blob URL cannot execute script", async () => {
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [wire({ id: "s1", filename: "chart.svg", contentType: "image/svg+xml" })],
        fetchAttachment: async () => new Blob(["<svg onload='alert(1)'/>"], { type: "image/svg+xml" }),
      }),
    });
    await engine.loadAttachments("m1");
    await engine.openAttachment("m1", "s1");

    // A `blob:` URL inherits the app origin. Navigating to an SVG one runs the SENDER'S script as
    // ohmail with the session cookie in scope — and the route's Content-Disposition and nosniff
    // describe the RESPONSE, so neither survives into a Blob built from its body. Re-typing at
    // construction is the only place that covers every consumer.
    expect(minted[0]).toBe("blob:0:application/octet-stream");
  });

  it("preserves the type of formats a strip legitimately renders inline", async () => {
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [wire({ id: "p1", filename: "photo.png", contentType: "image/png" })],
        fetchAttachment: async () => new Blob(["\x89PNG"], { type: "image/png" }),
      }),
    });
    await engine.loadAttachments("m1");
    await engine.openAttachment("m1", "p1");
    expect(minted[0]).toBe("blob:0:image/png");
  });
});

describe("download all", () => {
  it("returns the zip Blob for the caller to save", async () => {
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [wire()],
        fetchAttachment: async () => new Blob(["b"]),
        fetchAllAttachments: async () => new Blob(["PK\x03\x04"], { type: "application/zip" }),
      }),
    });
    const zip = await engine.downloadAllAttachments("m1");
    expect(await zip!.text()).toBe("PK\x03\x04");
  });

  it("a failed archive returns null and LEAVES THE LIST STANDING", async () => {
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [wire()],
        fetchAttachment: async () => new Blob(["b"], { type: "application/pdf" }),
        fetchAllAttachments: async () => { throw new Error("download-all failed"); },
      }),
    });
    await engine.loadAttachments("m1");
    await engine.openAttachment("m1", "a1");

    expect(await engine.downloadAllAttachments("m1")).toBeNull();

    // The metadata is still good and the fetched bytes are still in the tab — only the archive
    // request failed. Blanking the strip (and dropping a live object URL) because a download button
    // did not work would destroy state the user can see for a reason they did not cause.
    const after = engine.attachmentsOf("m1") as { state: string; items: { state: string; objectUrl?: string }[] };
    expect(after.state).toBe("ready");
    expect(after.items[0]!.state).toBe("ready");
    expect(after.items[0]!.objectUrl).toBe(minted[0]);
    expect(revoked).toEqual([]);
  });

  it("returns null without asking when this client has no download-all at all", async () => {
    const engine = new OhmailEngine({
      adapter: makeAdapter({ listAttachments: async () => [wire()], fetchAttachment: async () => new Blob(["b"]) }),
    });
    expect(await engine.downloadAllAttachments("m1")).toBeNull();
  });
});

describe("the wire", () => {
  /**
   * The URLs, encoding, and the two-content-type branch.
   *
   * The twin of this is `packages/api/test/attachments-adapter-seam.o18.test.ts`, which runs these
   * same paths through the REAL route table. Both halves exist because the defect being fixed is a
   * route with no caller: a path off by one segment 404s while every suite on either side stays
   * green.
   */
  function adapterWith(handler: (url: string, init?: { method?: string }) => Response) {
    const calls: [string, string | undefined][] = [];
    const adapter = new HttpAdapter({
      baseUrl: "/api",
      getCookie: () => "csrf-token",
      fetch: async (url, init) => { calls.push([url, init?.method]); return handler(url, init as { method?: string }); },
    });
    return { adapter, calls };
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("builds the metadata URL and percent-encodes the id", async () => {
    const { adapter, calls } = adapterWith(() => json({ items: [] }));
    await adapter.listAttachments("a/../../auth/session");
    expect(calls[0]![0]).toBe("/api/messages/a%2F..%2F..%2Fauth%2Fsession/attachments");
  });

  it("builds the byte URL and returns a Blob", async () => {
    const { adapter, calls } = adapterWith(() => new Response(new Blob(["PDFBYTES"]), {
      status: 200, headers: { "content-type": "application/pdf" },
    }));
    const blob = await adapter.fetchAttachment("a1");
    expect(calls[0]).toEqual(["/api/attachments/a1", "GET"]);
    expect(await blob.text()).toBe("PDFBYTES");
  });

  it("POSTs download-all with the CSRF header the route requires", async () => {
    const { adapter, calls } = adapterWith(() => new Response(new Blob(["PK\x03\x04"]), {
      status: 200, headers: { "content-type": "application/zip" },
    }));
    await adapter.fetchAllAttachments("m1");
    expect(calls[0]).toEqual(["/api/messages/m1/attachments/download-all", "POST"]);
  });

  it("reads the JSON ERROR ENVELOPE on a 413 rather than handing back a 'file'", async () => {
    const { adapter } = adapterWith(() => json(
      { error: { code: "payload_too_large", message: "this attachment is 90 MiB, over the 32 MiB limit" } },
      413,
    ));
    const err = await adapter.fetchAttachment("a1").catch((e: unknown) => e);
    // Calling `.blob()` before checking `res.ok` would turn this explanation into a download named
    // after the user's PDF — the worst possible failure of a download button.
    expect((err as { code?: string }).code).toBe("payload_too_large");
    expect((err as Error).message).toContain("32 MiB limit");
  });
});

describe("nothing is stored", () => {
  it("writes NO mirror record for an attachment", async () => {
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [wire()],
        fetchAttachment: async () => new Blob(["b"], { type: "application/pdf" }),
      }),
    });
    const putLocal = vi.spyOn(engine.store, "putLocal");
    await engine.loadAttachments("m1");
    await engine.openAttachment("m1", "a1");
    // A persisted record would survive a reload still holding a `blob:` string pointing at nothing,
    // and the surface would render a `ready` attachment whose image is permanently broken. It would
    // also be ohmail storing attachment state, which the product says it does not do.
    expect(putLocal).not.toHaveBeenCalled();
  });

  it("revokes every object URL on release", async () => {
    const engine = new OhmailEngine({
      adapter: makeAdapter({
        listAttachments: async () => [wire({ id: "a1" }), wire({ id: "a2", filename: "b.pdf" })],
        fetchAttachment: async () => new Blob(["b"], { type: "application/pdf" }),
      }),
    });
    await engine.loadAttachments("m1");
    await engine.openAttachment("m1", "a1");
    await engine.openAttachment("m1", "a2");
    expect(minted).toHaveLength(2);

    engine.releaseAttachments("m1");

    // A blob URL pins its bytes until revoked or the document dies. Without this, a session spent
    // opening PDFs accumulates every one of them in the tab.
    expect(revoked.sort()).toEqual(minted.sort());
    expect(engine.attachmentsOf("m1")).toEqual({ state: "loading" });
  });
});

describe("a press finds a connection while pictures draw", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("a file pressed while two letters draw their pictures lands ready, not busy", async () => {
    vi.useFakeTimers();
    // The API's door: two slots per mailbox, the overflow refused busy.
    let held = 0;
    const fetchAttachment = async (): Promise<Blob> => {
      if (held >= 2) throw new MutationRejectedError("busy", { status: 429, code: "mailbox_busy", retryable: true, retryAfterMs: 1000 });
      held += 1;
      try { await new Promise((r) => setTimeout(r, 2_000)); return new Blob(["x"], { type: "image/png" }); } finally { held -= 1; }
    };
    const pic = (m: string) => ({ ...wire({ id: `${m}-p`, contentType: "image/png", sizeBytes: 10, inline: true, messageId: m }), contentId: `${m}-c` });
    const lists: Record<string, AttachmentWire[]> = { m1: [pic("m1")], m2: [pic("m2")], m3: [wire({ id: "f", messageId: "m3" })] };
    const engine = new OhmailEngine({ adapter: makeAdapter({ listAttachments: async (id) => lists[id] ?? [], fetchAttachment }) });
    void engine.loadInlineImages("m1", ["m1-c"]);
    void engine.loadInlineImages("m2", ["m2-c"]);
    await vi.advanceTimersByTimeAsync(10);
    await engine.loadAttachments("m3");
    const press = engine.openAttachment("m3", "f");
    await vi.advanceTimersByTimeAsync(5_000);
    await press;
    const held3 = engine.attachmentsOf("m3");
    expect(held3.state === "ready" ? held3.items[0]?.state : undefined).toBe("ready");
  });
});
