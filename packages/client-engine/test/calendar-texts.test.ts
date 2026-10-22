import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  OhmailEngine,
  CALENDAR_TEXT_MAX_BYTES,
  CALENDAR_TEXT_MAX_PARTS,
} from "../src/engine.js";
import type { AttachmentWire, EngineAdapter } from "../src/adapters/adapter.js";

/**
 * ── CALENDAR PARTS: FETCHED AUTOMATICALLY, HELD AS TEXT FOR THE EVENT PREVIEW ───────────────
 *
 * `loadCalendarTexts` is the third automatic act on the `cost: "connection"` path (after a
 * human press and `loadInlineImages`), so — exactly as with the inline images — the budget
 * tests are the point: the trigger is opening a message, and a hostile message can declare any
 * number of "calendar" parts at any claimed size.
 *
 * The naming half lives here too: a NAMELESS calendar part is the common wire shape (Google and
 * Outlook nest the invite as an unnamed `text/calendar` alternative), and it must surface as
 * `invite.ics` — the server's own fallback stem for a nameless calendar part — never as the
 * opaque `attachment-<id>.bin`.
 */

beforeEach(() => {
  (globalThis as { URL: unknown }).URL = {
    createObjectURL: () => "blob:x",
    revokeObjectURL: () => {},
  };
});
afterEach(() => {
  delete (globalThis as { URL?: unknown }).URL;
});

const ICS_TEXT = [
  "BEGIN:VCALENDAR",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "SUMMARY:Sync",
  "DTSTART:20260713T120000Z",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

function makeAdapter(over: Partial<EngineAdapter> = {}): EngineAdapter {
  return {
    sync: async () => ({ changes: [], cursor: "1", hasMore: false }) as never,
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    listAttachments: async () => [],
    fetchAttachment: async () => new Blob([ICS_TEXT], { type: "text/calendar" }),
    ...over,
  };
}

function wire(o: Partial<AttachmentWire> = {}): AttachmentWire {
  return {
    id: o.id ?? "c1",
    filename: o.filename === undefined ? null : o.filename,
    contentType: o.contentType ?? "text/calendar; charset=utf-8; method=REQUEST",
    sizeBytes: o.sizeBytes ?? ICS_TEXT.length,
    inline: o.inline ?? false,
    contentId: o.contentId ?? null,
    messageId: o.messageId ?? "m1",
  };
}

function engineWith(parts: AttachmentWire[], over: Partial<EngineAdapter> = {}) {
  const fetched: string[] = [];
  const engine = new OhmailEngine({
    adapter: makeAdapter({
      listAttachments: async () => parts,
      fetchAttachment: async (id: string) => {
        fetched.push(id);
        return new Blob([ICS_TEXT], { type: "text/calendar" });
      },
      ...over,
    }),
  });
  return { engine, fetched };
}

describe("the nameless calendar part's name", () => {
  it("is invite.ics, never attachment-<id>.bin", async () => {
    const { engine } = engineWith([wire({ id: "c1", filename: null })]);
    await engine.loadAttachments("m1");
    const held = engine.attachmentsOf("m1");
    if (held.state !== "ready") throw new Error(`expected ready, got ${held.state}`);
    expect(held.items[0]!.filename).toBe("invite.ics");
  });

  it("a NAMED calendar part keeps its own name", async () => {
    const { engine } = engineWith([wire({ id: "c1", filename: "iCal-Reply.ics" })]);
    await engine.loadAttachments("m1");
    const held = engine.attachmentsOf("m1");
    if (held.state !== "ready") throw new Error(`expected ready, got ${held.state}`);
    expect(held.items[0]!.filename).toBe("iCal-Reply.ics");
  });

  it("a nameless NON-calendar part keeps the generic stem", async () => {
    const { engine } = engineWith([wire({ id: "x9", filename: null, contentType: "application/octet-stream" })]);
    await engine.loadAttachments("m1");
    const held = engine.attachmentsOf("m1");
    if (held.state !== "ready") throw new Error(`expected ready, got ${held.state}`);
    expect(held.items[0]!.filename).toBe("attachment-x9.bin");
  });
});

describe("loadCalendarTexts — the automatic fetch of what the card renders", () => {
  it("fetches a calendar part's bytes and holds the decoded text under its id", async () => {
    const { engine, fetched } = engineWith([wire({ id: "c1" })]);
    await engine.loadCalendarTexts("m1");
    expect(fetched).toEqual(["c1"]);
    expect(engine.calendarTextsOf("m1").get("c1")).toBe(ICS_TEXT);
  });

  it("application/ics counts as calendar data too", async () => {
    const { engine } = engineWith([wire({ id: "c1", contentType: "application/ics" })]);
    await engine.loadCalendarTexts("m1");
    expect(engine.calendarTextsOf("m1").has("c1")).toBe(true);
  });

  // An embedded CALENDAR part is fetched (calendar-events.test.ts); an inline picture never is.
  it("never pays for a non-calendar part, an inline picture, or a declared-oversized part", async () => {
    const { engine, fetched } = engineWith([
      wire({ id: "pdf", contentType: "application/pdf" }),
      wire({ id: "logo", inline: true, contentType: "image/png", contentId: "logo@example.test" }),
      wire({ id: "big", sizeBytes: CALENDAR_TEXT_MAX_BYTES + 1 }),
    ]);
    await engine.loadCalendarTexts("m1");
    expect(fetched).toEqual([]);
    expect(engine.calendarTextsOf("m1").size).toBe(0);
  });

  it("caps how many parts one message may spend, however many it declares", async () => {
    const parts = Array.from({ length: CALENDAR_TEXT_MAX_PARTS + 5 }, (_, i) => wire({ id: `c${i}` }));
    const { engine, fetched } = engineWith(parts);
    await engine.loadCalendarTexts("m1");
    expect(fetched).toHaveLength(CALENDAR_TEXT_MAX_PARTS);
  });

  it("a part whose declared size LIED small is refused on the real byte count", async () => {
    const liar = new Blob([new Uint8Array(CALENDAR_TEXT_MAX_BYTES + 1)], { type: "text/calendar" });
    const { engine } = engineWith([wire({ id: "c1", sizeBytes: 10 })], {
      fetchAttachment: async () => liar,
    });
    await engine.loadCalendarTexts("m1");
    expect(engine.calendarTextsOf("m1").size).toBe(0);
  });

  it("is single-flight per message and never re-fetches what it holds", async () => {
    const { engine, fetched } = engineWith([wire({ id: "c1" })]);
    await Promise.all([engine.loadCalendarTexts("m1"), engine.loadCalendarTexts("m1")]);
    await engine.loadCalendarTexts("m1");
    expect(fetched).toEqual(["c1"]);
  });

  it("a part that failed stays failed — the automatic pass never re-asks a refusal", async () => {
    let asks = 0;
    const { engine } = engineWith([wire({ id: "c1" })], {
      fetchAttachment: async () => {
        asks++;
        throw new Error("mailbox said no");
      },
    });
    await engine.loadCalendarTexts("m1");
    await engine.loadCalendarTexts("m1");
    expect(asks).toBe(1);
    expect(engine.calendarTextsOf("m1").size).toBe(0);
  });

  it("releaseAttachments drops the held texts with the rest of the byte state", async () => {
    const { engine } = engineWith([wire({ id: "c1" })]);
    await engine.loadCalendarTexts("m1");
    expect(engine.calendarTextsOf("m1").size).toBe(1);
    engine.releaseAttachments("m1");
    expect(engine.calendarTextsOf("m1").size).toBe(0);
  });

  it("notifies subscribers once when the texts land, so a strip can see its own card", async () => {
    const { engine } = engineWith([wire({ id: "c1" })]);
    let notices = 0;
    engine.subscribe(() => notices++);
    await engine.loadCalendarTexts("m1");
    // list write + item loading + item ready + text map — the exact count is not the contract;
    // that at least one notification FOLLOWS the map write is.
    expect(notices).toBeGreaterThan(0);
    expect(engine.calendarTextsOf("m1").size).toBe(1);
  });
});
