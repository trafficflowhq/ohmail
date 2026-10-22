import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OhmailEngine, CALENDAR_TEXT_MAX_PARTS } from "../src/engine.js";
import { calendarEventsOf } from "../src/index.js";
import type { AttachmentWire, EngineAdapter } from "../src/adapters/adapter.js";
import {
  EMBEDDED_CALENDAR, GOOGLE, OUTLOOK_RELATED, TWO_EVENTS, type InviteShape,
} from "../../core/test/fixtures/invite-shapes.js";

/**
 * The events a message's calendar parts carry, once each, from whichever part carries them: an
 * embedded calendar part (a Content-ID under multipart/related, stored inline) is fetched like any
 * other, the iTIP part first within the per-message budget, and Google's two copies are one event.
 */

beforeEach(() => {
  (globalThis as { URL: unknown }).URL = { createObjectURL: () => "blob:x", revokeObjectURL: () => {} };
});
afterEach(() => {
  delete (globalThis as { URL?: unknown }).URL;
});

const wireOf = (shape: InviteShape): AttachmentWire[] =>
  shape.parts.map((p) => ({
    id: p.id, filename: p.filename, contentType: p.contentType, sizeBytes: p.bytes.length,
    inline: p.inline, contentId: p.contentId, messageId: "m1",
  }));

function engineOver(parts: AttachmentWire[], bytesOf: (id: string) => string) {
  const fetched: string[] = [];
  const adapter: EngineAdapter = {
    sync: async () => ({ changes: [], cursor: "1", hasMore: false }) as never,
    mutate: async () => ({ changes: [], seq: null }),
    withdrawSend: async () => ({ outcome: "unsupported" as const }),
    fetchBody: async () => null,
    listAttachments: async () => parts,
    fetchAttachment: async (id: string) => {
      fetched.push(id);
      return new Blob([bytesOf(id)], { type: "text/calendar" });
    },
  };
  return { engine: new OhmailEngine({ adapter }), fetched };
}

const shapeEngine = (shape: InviteShape) =>
  engineOver(wireOf(shape), (id) => shape.parts.find((p) => p.id === id)!.bytes);

describe("the calendar pass reaches every calendar part", () => {
  it("an embedded calendar part (inline, with a Content-ID) is fetched", async () => {
    const { engine, fetched } = shapeEngine(EMBEDDED_CALENDAR);
    await engine.loadCalendarTexts("m1");
    expect(fetched).toEqual(["embedded-cal"]);
    expect(calendarEventsOf(engine, "m1").map((e) => e.event.summary)).toEqual(["Site visit"]);
  });

  it("an inline picture is still never fetched by the calendar pass", async () => {
    const { engine, fetched } = shapeEngine(OUTLOOK_RELATED);
    await engine.loadCalendarTexts("m1");
    expect(fetched).toEqual(["outlook-alt"]);
  });

  it("the iTIP part is fetched first, inside the budget", async () => {
    const file = (i: number): AttachmentWire => ({
      id: `f${i}`, filename: `file${i}.ics`, contentType: "application/ics", sizeBytes: 300, inline: false, contentId: null, messageId: "m1",
    });
    const files = Array.from({ length: CALENDAR_TEXT_MAX_PARTS }, (_, i) => file(i));
    const itip: AttachmentWire = { ...file(9), id: "itip", filename: null, contentType: "text/calendar; method=REQUEST" };
    const { engine, fetched } = engineOver([...files, itip], () => GOOGLE.parts[0]!.bytes);
    await engine.loadCalendarTexts("m1");
    expect(fetched[0]).toBe("itip");
    expect(fetched).toHaveLength(CALENDAR_TEXT_MAX_PARTS);
  });
});

describe("calendarEventsOf: one entry per event", () => {
  it("Google's alternative and invite.ics are one event", async () => {
    const { engine } = shapeEngine(GOOGLE);
    await engine.loadCalendarTexts("m1");
    expect(engine.calendarTextsOf("m1").size, "the premise: both parts were fetched").toBe(2);
    expect(calendarEventsOf(engine, "m1").map((e) => e.partId)).toEqual(["google-alt"]);
  });

  it("two events are two, and nothing is drawn before the texts land", async () => {
    const { engine } = shapeEngine(TWO_EVENTS);
    expect(calendarEventsOf(engine, "m1")).toEqual([]);
    await engine.loadCalendarTexts("m1");
    expect(calendarEventsOf(engine, "m1")).toHaveLength(2);
  });

  it("is identity-stable while the texts are, and released with the message", async () => {
    const { engine } = shapeEngine(GOOGLE);
    await engine.loadCalendarTexts("m1");
    expect(calendarEventsOf(engine, "m1")).toBe(calendarEventsOf(engine, "m1"));
    engine.releaseAttachments("m1");
    expect(calendarEventsOf(engine, "m1")).toEqual([]);
  });
});
