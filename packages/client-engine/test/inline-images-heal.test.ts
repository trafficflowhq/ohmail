import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OhmailEngine, INLINE_IMAGE_MAX_BYTES } from "../src/engine.js";
import { REASK_MAX } from "../src/session-reask.js";
import { MutationRejectedError } from "../src/types.js";
import type { AttachmentWire, EngineAdapter } from "../src/adapters/adapter.js";

/**
 * a short drop while a letter opened left its inline picture missing until the
 * letter was reopened, while the file card beside it healed. A transient failure never becomes a
 * permanent missing picture: the part retries on the card's terms (the wire classifier, a drain
 * completing, at most REASK_MAX per episode), and a list or part that answers later — a re-ask or
 * a press — puts the picture in place without the document asking again.
 */

beforeEach(() => {
  let n = 0;
  (globalThis as { URL: unknown }).URL = {
    createObjectURL: () => `blob:${++n}`,
    revokeObjectURL: () => {},
  };
});
afterEach(() => {
  delete (globalThis as { URL?: unknown }).URL;
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const offline = () => new MutationRejectedError("network failure: TypeError: Failed to fetch", { code: "network", retryable: true });
const fault = () => new MutationRejectedError("boom", { status: 500, code: "internal", retryable: true });

function wire(o: Partial<AttachmentWire> = {}): AttachmentWire {
  return {
    id: o.id ?? "a1",
    filename: o.filename ?? "logo.png",
    contentType: o.contentType ?? "image/png",
    sizeBytes: o.sizeBytes ?? PNG.length,
    inline: o.inline ?? true,
    contentId: o.contentId === undefined ? "logo@corp" : o.contentId,
    messageId: "m1",
  };
}

/** An engine whose list and part fetches fail while `down` answers true for them. */
function rig(parts: AttachmentWire[], down: { list?: () => Error | null; part?: (id: string) => Error | null } = {}) {
  const calls = { list: 0, part: [] as string[] };
  const adapter: EngineAdapter = {
    sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date().toISOString() }) as never,
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    listAttachments: async () => {
      calls.list += 1;
      const err = down.list?.() ?? null;
      if (err) throw err;
      return parts;
    },
    fetchAttachment: async (id: string) => {
      calls.part.push(id);
      const err = down.part?.(id) ?? null;
      if (err) throw err;
      return new Blob([PNG], { type: "image/png" });
    },
  };
  return { engine: new OhmailEngine({ adapter }), calls };
}

const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const drain = async (engine: OhmailEngine) => { await engine.syncOnce(); await settle(); };

describe("an inline picture heals after a transient failure", () => {
  it("a part the wire failed is fetched again when a drain completes, and drawn in place", async () => {
    let up = false;
    const { engine, calls } = rig([wire()], { part: () => (up ? null : offline()) });
    await engine.loadInlineImages("m1", ["logo@corp"]);
    expect(engine.inlineImagesOf("m1").size).toBe(0);
    up = true;
    await drain(engine);
    expect(calls.part).toEqual(["a1", "a1"]);
    expect(engine.inlineImagesOf("m1").has("logo@corp")).toBe(true);
  });

  it("a list the wire failed, re-asked by the surface, draws the picture without a second ask from the document", async () => {
    let up = false;
    const { engine, calls } = rig([wire()], { list: () => (up ? null : offline()) });
    await engine.loadInlineImages("m1", ["logo@corp"]);
    expect(engine.inlineImagesOf("m1").size).toBe(0);
    up = true;
    await engine.reaskAttachments("m1");
    await settle();
    expect(calls.list).toBe(2);
    expect(engine.inlineImagesOf("m1").has("logo@corp")).toBe(true);
  });

  it("a press on the failed card that fetches the bytes draws the picture in the text too", async () => {
    // A fault the server answered: no automatic re-ask, so only the person's press heals it.
    let up = false;
    const { engine, calls } = rig([wire()], { part: () => (up ? null : fault()) });
    await engine.loadInlineImages("m1", ["logo@corp"]);
    await drain(engine);
    expect(calls.part, "an answered fault is not asked again automatically").toEqual(["a1"]);
    up = true;
    await engine.openAttachment("m1", "a1", { retry: true });
    await settle();
    expect(engine.inlineImagesOf("m1").has("logo@corp")).toBe(true);
  });

  it("a press that lands while a pass is still walking the letter's other pictures draws too", async () => {
    let releaseB: () => void = () => {};
    const slowB = new Promise<void>((r) => { releaseB = r; });
    let upA = false;
    const calls: string[] = [];
    const engine = new OhmailEngine({
      adapter: {
        sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date().toISOString() }) as never,
        mutate: async () => ({ changes: [], seq: null }),
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async () => null,
        listAttachments: async () => [wire({ id: "a", contentId: "a@corp" }), wire({ id: "b", contentId: "b@corp" })],
        fetchAttachment: async (id: string) => {
          calls.push(id);
          if (id === "a" && !upA) throw fault();
          if (id === "b") await slowB;
          return new Blob([PNG], { type: "image/png" });
        },
      },
    });
    const pass = engine.loadInlineImages("m1", ["a@corp", "b@corp"]);
    await settle();
    expect(calls, "the pass is waiting on b, a already failed").toEqual(["a", "b"]);
    upA = true;
    await engine.openAttachment("m1", "a", { retry: true });
    releaseB();
    await pass;
    await settle();
    expect([...engine.inlineImagesOf("m1").keys()].sort()).toEqual(["a@corp", "b@corp"]);
  });

  it("a drain while a pass is still walking spends no re-ask: the part is asked once the pass ends", async () => {
    let releaseB: () => void = () => {};
    const slowB = new Promise<void>((r) => { releaseB = r; });
    let upA = false;
    const calls: string[] = [];
    const engine = new OhmailEngine({
      adapter: {
        sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date().toISOString() }) as never,
        mutate: async () => ({ changes: [], seq: null }),
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async () => null,
        listAttachments: async () => [wire({ id: "a", contentId: "a@corp" }), wire({ id: "b", contentId: "b@corp" })],
        fetchAttachment: async (id: string) => {
          calls.push(id);
          if (id === "a" && !upA) throw offline();
          if (id === "b") await slowB;
          return new Blob([PNG], { type: "image/png" });
        },
      },
    });
    const pass = engine.loadInlineImages("m1", ["a@corp", "b@corp"]);
    await settle();
    for (let i = 0; i < REASK_MAX; i++) await drain(engine);
    upA = true;
    releaseB();
    await pass;
    await drain(engine);
    expect(calls).toEqual(["a", "b", "a"]);
    expect([...engine.inlineImagesOf("m1").keys()].sort()).toEqual(["a@corp", "b@corp"]);
  });

  it(`asks at most ${REASK_MAX} times while the wire keeps failing`, async () => {
    const { engine, calls } = rig([wire()], { part: () => offline() });
    await engine.loadInlineImages("m1", ["logo@corp"]);
    for (let i = 0; i < REASK_MAX + 2; i++) await drain(engine);
    expect(calls.part.length).toBe(1 + REASK_MAX);
  });

  it("control: a cid no part carries asks nothing on any drain, and stays absent", async () => {
    const { engine, calls } = rig([wire({ contentId: "other@corp" })], { part: () => offline() });
    await engine.loadInlineImages("m1", ["missing@corp"]);
    await drain(engine);
    await drain(engine);
    expect(calls.part).toEqual([]);
    expect(engine.inlineImagesOf("m1").size).toBe(0);
  });

  it("control: a picture over the ceiling is never fetched, on the first ask or a heal", async () => {
    let up = false;
    const { engine, calls } = rig(
      [wire({ id: "big", contentId: "big@corp", sizeBytes: INLINE_IMAGE_MAX_BYTES + 1 })],
      { list: () => (up ? null : offline()) },
    );
    await engine.loadInlineImages("m1", ["big@corp"]);
    up = true;
    await engine.reaskAttachments("m1");
    await settle();
    await drain(engine);
    expect(calls.part).toEqual([]);
  });

  it("control: a reader that left lets the picture go — no re-ask after the release", async () => {
    let up = false;
    const { engine, calls } = rig([wire()], { part: () => (up ? null : offline()) });
    await engine.loadInlineImages("m1", ["logo@corp"]);
    engine.releaseAttachments("m1");
    up = true;
    await drain(engine);
    await engine.loadAttachments("m1");
    await settle();
    expect(calls.part).toEqual(["a1"]);
    expect(engine.inlineImagesOf("m1").size).toBe(0);
  });

  it("control: a reader that left over an answered refusal lets the picture go — a later Retry fetches no picture", async () => {
    let up = false;
    const { engine, calls } = rig([wire()], { list: () => (up ? null : fault()) });
    await engine.loadInlineImages("m1", ["logo@corp"]);
    engine.releaseAttachments("m1", { keepFailure: true });
    up = true;
    await engine.loadAttachments("m1", { retry: true });
    await settle();
    expect(engine.attachmentsOf("m1").state).toBe("ready");
    expect(calls.part).toEqual([]);
  });

  it("control: a picture that arrived first time is fetched once, however many drains follow", async () => {
    const { engine, calls } = rig([wire()]);
    await engine.loadInlineImages("m1", ["logo@corp"]);
    await drain(engine);
    await drain(engine);
    expect(calls.part).toEqual(["a1"]);
    expect(engine.inlineImagesOf("m1").has("logo@corp")).toBe(true);
  });
});

/**
 * ONE OPEN CONVERSATION ASKS A MAILBOX'S DOOR NO MORE THAN IT ADMITS. Every expanded letter drew
 * its pictures at once, so a third letter met the API's two-slot door and its pictures read
 * "ohmail already has this mailbox's connections open". The door is modelled as the API's:
 * `max` slots, a wait of `waitMs` in line, then a 429 `mailbox_busy`.
 */
describe("embedded pictures wait for a connection", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const busy = (retryAfterMs: number | null = 1000) => new MutationRejectedError("busy", { status: 429, code: "mailbox_busy", retryable: true, retryAfterMs });
  const unreachable = () => new MutationRejectedError("no answer", { status: 424, code: "mail_server_unreachable", retryable: true });

  function door(max: number, holdMs: number) {
    let held = 0;
    const stats = { asks: [] as string[], inAsk: 0, peak: 0 };
    const fetchAttachment = async (id: string): Promise<Blob> => {
      stats.asks.push(id);
      stats.inAsk += 1;
      stats.peak = Math.max(stats.peak, stats.inAsk);
      try {
        if (held >= max) throw busy();
        held += 1;
        try { await new Promise((r) => setTimeout(r, holdMs)); return new Blob([PNG], { type: "image/png" }); } finally { held -= 1; }
      } finally { stats.inAsk -= 1; }
    };
    return { fetchAttachment, stats };
  }

  function pictures(messageId: string, n: number): AttachmentWire[] {
    return Array.from({ length: n }, (_, i) => ({ ...wire({ id: `${messageId}-p${i}`, contentId: `${messageId}-c${i}` }), messageId }));
  }

  function conversation(ids: string[], perLetter: number, fetchAttachment: (id: string) => Promise<Blob>) {
    const letters = Object.fromEntries(ids.map((id) => [id, pictures(id, perLetter)]));
    const engine = new OhmailEngine({
      adapter: {
        sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: new Date().toISOString() }) as never,
        mutate: async () => ({ changes: [], seq: null }),
        withdrawSend: async () => ({ outcome: "unsupported" as const }),
        fetchBody: async () => null,
        listAttachments: async (id: string) => letters[id] ?? [],
        fetchAttachment,
      },
    });
    const failedSeen: string[] = [];
    engine.subscribe(() => {
      for (const id of ids) {
        const held = engine.attachmentsOf(id, { includeInlineParts: true });
        if (held.state === "ready") for (const i of held.items) if (i.state === "failed") failedSeen.push(i.id);
      }
    });
    const item = (id: string, part: string) => {
      const held = engine.attachmentsOf(id, { includeInlineParts: true });
      return held.state === "ready" ? held.items.find((i) => i.id === part) : undefined;
    };
    return { engine, failedSeen, item };
  }

  const cids = (id: string, n: number) => Array.from({ length: n }, (_, i) => `${id}-c${i}`);
  /** A surface's cadence: the engine owns no timer, so a due re-ask waits for this call. */
  const cadence = async (engine: OhmailEngine, ms: number, stepMs = 1_000) => {
    for (let t = 0; t < ms; t += stepMs) { await vi.advanceTimersByTimeAsync(stepMs); engine.reaskDueParts(); }
    await vi.advanceTimersByTimeAsync(0);
  };

  it("three expanded letters with two pictures each draw all six, one automatic ask at a time", async () => {
    vi.useFakeTimers();
    const d = door(2, 60);
    const ids = ["m1", "m2", "m3"];
    const { engine, failedSeen } = conversation(ids, 2, d.fetchAttachment);
    const all = Promise.all(ids.map((id) => engine.loadInlineImages(id, cids(id, 2))));
    await vi.advanceTimersByTimeAsync(5_000);
    await all;
    expect(ids.map((id) => engine.inlineImagesOf(id).size)).toEqual([2, 2, 2]);
    expect(d.stats.peak).toBe(1);
    expect(failedSeen).toEqual([]);
  });

  it("a picture answered busy twice waits and is drawn, never shown as failed", async () => {
    vi.useFakeTimers();
    let n = 0;
    const asks = vi.fn(async () => { n += 1; if (n <= 2) throw busy(2000); return new Blob([PNG], { type: "image/png" }); });
    const { engine, failedSeen, item } = conversation(["m1"], 1, asks);
    const pass = engine.loadInlineImages("m1", cids("m1", 1));
    await vi.advanceTimersByTimeAsync(10_000);
    await pass;
    expect(item("m1", "m1-p0")?.state).toBe("ready");
    expect(asks).toHaveBeenCalledTimes(3);
    expect(failedSeen).toEqual([]);
  });

  it("busy past the patience fails plainly, says it tries again, and the timed re-ask draws it", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const t0 = Date.now();
    const asks = vi.fn(async () => { if (Date.now() - t0 < 75_000) throw busy(2000); return new Blob([PNG], { type: "image/png" }); });
    const { engine, item } = conversation(["m1"], 1, asks);
    void engine.loadInlineImages("m1", cids("m1", 1));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(item("m1", "m1-p0")?.state, "still waiting for a connection").toBe("loading");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(item("m1", "m1-p0")).toMatchObject({ state: "failed", code: "mailbox_busy", reasking: true });
    expect(asks.mock.calls.length).toBeLessThanOrEqual(31);
    await cadence(engine, 15_000);
    expect(engine.inlineImagesOf("m1").has("m1-c0")).toBe(true);
  });

  it("an unreachable mail server is re-asked at 15 s, 60 s and 240 s, then left standing", async () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const at: number[] = [];
    const { engine, item } = conversation(["m1"], 1, async () => { at.push(Date.now() - t0); throw unreachable(); });
    void engine.loadInlineImages("m1", cids("m1", 1));
    await cadence(engine, 1_000_000, 5_000);
    expect(at).toEqual([0, 15_000, 75_000, 315_000]);
    expect(item("m1", "m1-p0")?.reasking).toBeUndefined();
  });

  it("the engine asks nothing again on its own: a due re-ask waits for the surface's cadence", async () => {
    vi.useFakeTimers();
    const asks = vi.fn(async () => { throw unreachable(); });
    const { engine, item } = conversation(["m1"], 1, asks);
    void engine.loadInlineImages("m1", cids("m1", 1));
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(asks).toHaveBeenCalledTimes(1);
    expect(item("m1", "m1-p0")?.reasking, "still due, so still said").toBe(true);
    engine.reaskDueParts();
    await vi.advanceTimersByTimeAsync(0);
    expect(asks).toHaveBeenCalledTimes(2);
  });

  it("a disposed engine arms nothing from a pass that ends after it and asks nothing again", async () => {
    vi.useFakeTimers();
    let answer: (() => void) | null = null;
    const asks = vi.fn(() => new Promise<Blob>((_, reject) => { answer = () => reject(unreachable()); }));
    const { engine } = conversation(["m1"], 1, asks);
    void engine.loadInlineImages("m1", cids("m1", 1));
    await vi.advanceTimersByTimeAsync(100);
    engine.dispose();
    answer!();
    await cadence(engine, 400_000, 5_000);
    expect(asks).toHaveBeenCalledTimes(1);
  });

  it("a letter released before its re-ask is not asked again", async () => {
    vi.useFakeTimers();
    const asks = vi.fn(async () => { throw unreachable(); });
    const { engine } = conversation(["m1"], 1, asks);
    void engine.loadInlineImages("m1", cids("m1", 1));
    await vi.advanceTimersByTimeAsync(10_000);
    engine.releaseAttachments("m1");
    await cadence(engine, 1_000_000, 5_000);
    expect(asks).toHaveBeenCalledTimes(1);
  });

  it("a letter released while its pictures wait in line asks for none of them", async () => {
    vi.useFakeTimers();
    const d = door(2, 1_000);
    const { engine } = conversation(["m1", "m2"], 1, d.fetchAttachment);
    void engine.loadInlineImages("m1", cids("m1", 1));
    void engine.loadInlineImages("m2", cids("m2", 1));
    await vi.advanceTimersByTimeAsync(10);
    engine.releaseAttachments("m2");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(d.stats.asks).toEqual(["m1-p0"]);
    expect(engine.inlineImagesOf("m1").has("m1-c0")).toBe(true);
  });
});
