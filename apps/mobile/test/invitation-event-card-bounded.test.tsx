/** @vitest-environment jsdom */
/**
 * A CRAFTED INVITATION CANNOT STALL THE PHONE'S READER. Opening a message fetches its calendar
 * parts with no press, inside the engine's 256 KiB budget, and the card stands above the body. A
 * 250,000-character SUMMARY, LOCATION, organizer name or TZID was drawn whole in one Text there,
 * where a 65,536-character Text took ~450 ms of the JS thread. Core now cuts what every card
 * draws (SUMMARY and LOCATION at 1,000, each CN at 200, an unknown zone's label at 64), and each
 * of the card's lines carries a numberOfLines so the text layout stops early.
 */
import { createElement as h, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryMirrorStore, OhmailEngine, type EngineAdapter, type EngineMessage, type SyncChange } from "@ohmail/client-engine";
import { mount } from "./_rendered-dom";
import { icsOversized, type InviteShape, type OversizedSpec } from "../../../packages/core/test/fixtures/invite-shapes";

vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  AppState: { addEventListener: () => ({ remove: () => {} }), currentState: "active" },
}));
const conn = vi.hoisted(() => ({ engine: null as unknown }));
vi.mock("../src/net/connection", () => ({
  useConnection: () => ({ state: { k: "live", session: { engine: conn.engine } } }),
}));
/* The phone's Txt, drawn with the line clamp it was given. */
vi.mock("../src/ui/base", async () => {
  const { createElement } = await import("react");
  return {
    Txt: ({ children, testID, numberOfLines }: { children?: ReactNode; testID?: string; numberOfLines?: number }) =>
      createElement("div", { "data-rn": "Text", "data-testid": testID, "data-lines": numberOfLines }, children),
  };
});
vi.mock("../src/theme", () => ({
  useTheme: () => ({
    c: new Proxy({}, { get: () => "#000" }),
    radius: { rowDense: 14, item: 10 },
    type: new Proxy({}, { get: () => ({}) }),
    lift: () => ({}),
    textCap: 2,
    textKey: 1,
  }),
}));

const { liveActions, liveMessage } = await import("../src/state/live");
const { EventCards } = await import("../src/ui/EventCard");

const NOW = new Date("2026-10-22T09:00:00.000Z");
const BUDGET = 256 * 1024;
const ELLIPSIS = "…";

function oversized(name: string, spec: Omit<OversizedSpec, "uid">): InviteShape {
  const bytes = icsOversized({ uid: `${name}@example.test`, ...spec });
  return {
    name, eml: "", text: "Ada Organizer has invited you.", html: null, calendarHeader: false,
    parts: [{ id: `${name}-alt`, filename: null, contentType: "text/calendar; method=REQUEST", inline: false, contentId: null, bytes }],
  };
}

const idOf = (shape: InviteShape) => `m-${shape.name}`;

async function world(shape: InviteShape) {
  const fetched: string[] = [];
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([{
    type: "message", op: "create", id: idOf(shape), seq: 1, updatedAt: NOW.toISOString(),
    entity: {
      id: idOf(shape), accountId: "acct-1", mailboxId: "mb-1", threadId: `th-${shape.name}`, messageIdHeader: null,
      subject: shape.name, from: { name: "Ada Organizer", address: "ada@example.test" }, to: [], cc: [],
      date: "2026-10-22T08:00:00.000Z", folder: "INBOX", snippet: shape.text, unread: false, hasAttachments: true,
      attachmentCount: shape.parts.length, sensitivity: {}, triage: null, labels: [], remoteContent: "none", updatedAt: NOW.toISOString(),
    } as unknown as EngineMessage,
  }] as SyncChange[]);
  const adapter: EngineAdapter = {
    sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async () => ({ changes: [], seq: null }),
    fetchBody: async () => ({ text: shape.text, html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
    listAttachments: async (id: string) => (id === idOf(shape) ? shape.parts : []).map((p) => ({
      id: p.id, filename: p.filename, contentType: p.contentType, sizeBytes: p.bytes.length, inline: p.inline, contentId: p.contentId, messageId: id,
    })),
    fetchAttachment: async (id: string) => {
      fetched.push(id);
      // Untyped, so the engine keeps the runtime's own Blob (jsdom's has no `text()`).
      return new Response(shape.parts.find((p) => p.id === id)!.bytes, { headers: { "content-type": "application/octet-stream" } }).blob();
    },
  } as never;
  return { engine: new OhmailEngine({ store, now: () => NOW, adapter }), fetched };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Opens the message the way the reader does and draws its cards; the premise checked on the way. */
async function opened(shape: InviteShape) {
  expect(shape.parts[0]!.bytes.length, "the premise: the part fits the engine's automatic budget").toBeLessThanOrEqual(BUDGET);
  const { engine, fetched } = await world(shape);
  await liveActions({ engine, toast: () => undefined, uuid: () => "00000000-0000-4000-8000-000000000001", zone: "UTC" } as never)
    .openMessage(idOf(shape));
  await settle();
  expect(fetched, "the premise: opening the message fetched the part with no press").toEqual([shape.parts[0]!.id]);
  const events = liveMessage(engine, idOf(shape), { now: NOW, zone: "UTC" } as never)!.events;
  expect(events?.length).toBe(1);
  open = mount(h(EventCards, { events }));
  expect(document.querySelectorAll('[data-testid="event-card"]'), "one card").toHaveLength(1);
  const line = (testID: string) => {
    const el = document.querySelector(`[data-testid="${testID}"]`);
    expect(el, `${testID} is not drawn`).not.toBeNull();
    return { text: el!.textContent ?? "", lines: el!.getAttribute("data-lines") };
  };
  return { line };
}

let open: { unmount(): void } | null = null;
afterEach(() => {
  open?.unmount();
  open = null;
});

describe("a crafted invitation draws a bounded card on the phone", () => {
  it("a 250,000-character SUMMARY: one card, the title cut to 1,000 and clamped to three lines", async () => {
    const summary = "Quarterly planning ".repeat(13_158).slice(0, 250_000);
    const { line } = await opened(oversized("huge-summary", { summary }));
    const title = line("event-card-summary");
    expect(title.text.length).toBeLessThanOrEqual(1000);
    expect(title.text.endsWith(ELLIPSIS)).toBe(true);
    expect(title.lines).toBe("3");
    expect(line("event-card-when").lines).toBe("2");
    expect(line("event-card-location")).toEqual({ text: "Room Aare", lines: "2" });
    expect(line("event-card-people")).toEqual({ text: "Ada Organizer · 1 invited", lines: "1" });
  });

  it("a 250,000-character TZID that names no zone: the when-line prints 64 of it, on two lines at most", async () => {
    const { line } = await opened(oversized("long-tzid", { tzid: "Z".repeat(250_000) }));
    const when = line("event-card-when");
    expect(when.text).toContain(`(${"Z".repeat(63)}${ELLIPSIS})`);
    expect(when.text.length).toBeLessThan(64 + 60);
    expect(when.lines).toBe("2");
  });

  it("a 120,000-character LOCATION and organizer name: each cut, each clamped", async () => {
    const { line } = await opened(oversized("long-place-and-name", { location: "Room ".repeat(24_000), organizer: "Ada ".repeat(30_000) }));
    const place = line("event-card-location");
    expect(place.text.length).toBeLessThanOrEqual(1000);
    expect(place.text.endsWith(ELLIPSIS)).toBe(true);
    expect(place.lines).toBe("2");
    const people = line("event-card-people");
    expect(people.text.length).toBeLessThanOrEqual(200 + " · 1 invited".length);
    expect(people.text).toMatch(/… · 1 invited$/);
    expect(people.lines).toBe("1");
  });
});
