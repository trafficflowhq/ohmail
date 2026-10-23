/** @vitest-environment jsdom */
/**
 * A MEETING INVITATION SHOWS ITS EVENT ONCE ON THE PHONE, AT THE TOP OF THE MESSAGE (owner report
 * 2026-10-22). The phone drew no card at all: nothing asked for the calendar parts, and nothing
 * drew them. Opening a message now asks its calendar parts inside the engine's budget, the row and
 * each conversation member carry their events once each, and the reader redraws when the texts
 * land, which is an engine notification that moves no stamp the world derives from.
 */
import { createElement as h, type ReactNode } from "react";
import { act } from "react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryMirrorStore, MutationRejectedError, OhmailEngine, type EngineAdapter, type EngineMessage, type SyncChange } from "@ohmail/client-engine";
import { mount } from "./_rendered-dom";
import { APPLE, EXCHANGE_ICAL, GOOGLE, HOSTILE_DURATION, TWO_EVENTS, type InviteShape } from "../../../packages/core/test/fixtures/invite-shapes";

vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  AppState: { addEventListener: () => ({ remove: () => {} }), currentState: "active" },
}));
const conn = vi.hoisted(() => ({ engine: null as unknown }));
vi.mock("../src/net/connection", () => ({
  useConnection: () => ({ state: { k: "live", session: { engine: conn.engine } } }),
}));
vi.mock("../src/ui/base", async () => {
  const { rnDom } = await import("./_rendered-dom");
  return { Txt: rnDom.Text };
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

const { liveActions, liveEvents, liveMessage } = await import("../src/state/live");
const { useFilesStamp } = await import("../src/state/files-stamp");
const { EventCards } = await import("../src/ui/EventCard");
const { ErrorBoundary } = await import("../src/ui/error-boundary");
const { setActiveLocale, resetLocaleRegisterForTests } = await import("../src/i18n/locale");
const { EN } = await import("../src/copy.en");
const { DE } = await import("../src/copy.de");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-10-22T09:00:00.000Z");
const view = { now: NOW, zone: "UTC" };

const idOf = (shape: InviteShape) => `m-${shape.name}`;
const row = (shape: InviteShape, hour: number): EngineMessage => ({
  id: idOf(shape), accountId: "acct-1", mailboxId: "mb-1", threadId: "th-invite", messageIdHeader: null,
  subject: shape.name, from: { name: "Ada Organizer", address: "ada@example.test" },
  to: [], cc: [], date: `2026-10-22T0${hour}:00:00.000Z`, folder: "INBOX", snippet: shape.text,
  unread: false, hasAttachments: true, attachmentCount: shape.parts.length, sensitivity: {}, triage: null,
  labels: [], remoteContent: "none", updatedAt: "2026-10-22T08:00:00.000Z",
} as unknown as EngineMessage);

async function world(shapes: InviteShape[], opts: { holdBytes?: boolean; down?: () => boolean } = {}) {
  const fetched: string[] = [];
  let release: () => void = () => {};
  const gate = opts.holdBytes ? new Promise<void>((r) => { release = r; }) : Promise.resolve();
  const store = new MemoryMirrorStore();
  await store.load();
  let seq = 0;
  await store.applyChanges([
    ...shapes.map((s, i): SyncChange => ({ type: "message", op: "create", id: idOf(s), seq: ++seq, updatedAt: NOW.toISOString(), entity: row(s, i + 5) })),
    { type: "rule", op: "create", id: "r-ada", seq: ++seq, updatedAt: NOW.toISOString(), entity: {
      id: "r-ada", kind: "sender", match: "ada@example.test", destination: "INBOX", enabled: true, createdAt: NOW.toISOString() } },
  ] as SyncChange[]);
  const adapter: EngineAdapter = {
    sync: async () => ({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString() }),
    mutate: async () => ({ changes: [], seq: null }),
    fetchBody: async (id: string) => ({ text: shapes.find((s) => idOf(s) === id)?.text ?? "", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null }),
    listAttachments: async (id: string) => {
      if (opts.down?.()) throw new MutationRejectedError("network failure: TypeError: Failed to fetch", { code: "network", retryable: true });
      return (shapes.find((s) => idOf(s) === id)?.parts ?? []).map((p) => ({
        id: p.id, filename: p.filename, contentType: p.contentType, sizeBytes: p.bytes.length, inline: p.inline, contentId: p.contentId, messageId: id,
      }));
    },
    fetchAttachment: async (id: string) => {
      fetched.push(id);
      await gate;
      // Untyped, so the engine keeps the runtime's own Blob (jsdom's has no `text()`).
      return new Response(shapes.flatMap((s) => s.parts).find((p) => p.id === id)!.bytes, {
        headers: { "content-type": "application/octet-stream" },
      }).blob();
    },
  } as never;
  const engine = new OhmailEngine({ store, now: () => NOW, adapter });
  return { engine, fetched, release: () => release() };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};
const actionsOver = (engine: OhmailEngine) =>
  liveActions({ engine, toast: () => undefined, uuid: () => "00000000-0000-4000-8000-000000000001", zone: "UTC" } as never);

let open: { unmount(): void } | null = null;
afterEach(() => {
  open?.unmount();
  open = null;
  resetLocaleRegisterForTests();
});

describe("opening an invitation on the phone asks its calendar parts and carries its events once", () => {
  it("Google's alternative and invite.ics: fetched, one event on the opened row", async () => {
    const { engine, fetched } = await world([GOOGLE]);
    await actionsOver(engine).openMessage(idOf(GOOGLE));
    await settle();
    expect([...fetched].sort(), "the open did not ask the calendar parts").toEqual(["google-alt", "google-file"]);
    const m = liveMessage(engine, idOf(GOOGLE), view as never)!;
    expect(m.events?.length, "one meeting, one event").toBe(1);
    expect(m.events?.[0]?.event.summary).toBe("Quarterly planning");
    expect(m.attachments?.map((a) => a.id), "the file is one chip; the alternative is the card's").toEqual(["google-file"]);
  });

  it("each conversation member carries its own events, and a held row's are read the same way", async () => {
    const { engine } = await world([APPLE, TWO_EVENTS]);
    await actionsOver(engine).openMessage(idOf(TWO_EVENTS));
    await settle();
    const m = liveMessage(engine, idOf(TWO_EVENTS), view as never)!;
    expect(m.events?.map((e) => e.event.summary)).toEqual(["Workshop day one", "Workshop day two"]);
    const member = m.earlier.find((x) => x.id === idOf(APPLE));
    expect(member?.events?.map((e) => e.event.summary), "an earlier member lost its event").toEqual(["Dinner with the team"]);
    expect(liveEvents(engine, idOf(APPLE))?.length).toBe(1);
  });
});

describe("a list that recovers after a drop asks its calendar parts (the web's heal)", () => {
  it("the reader: the list fails, a sync completes, the event arrives", async () => {
    let down = true;
    const { engine, fetched } = await world([EXCHANGE_ICAL], { down: () => down });
    const acts = actionsOver(engine);
    const stop = acts.watchLists();
    await acts.openMessage(idOf(EXCHANGE_ICAL));
    await settle();
    expect(engine.attachmentsOf(idOf(EXCHANGE_ICAL)).state, "the premise: the list failed").toBe("failed");
    down = false;
    await engine.syncOnce();
    await settle();
    stop();
    expect(fetched, "the calendar part was never asked").toEqual(["exchange-alt"]);
    expect(liveMessage(engine, idOf(EXCHANGE_ICAL), view as never)!.events?.length).toBe(1);
  });

  it("a held row (a News card, the sender screen): the same", async () => {
    let down = true;
    const { engine } = await world([GOOGLE], { down: () => down });
    const acts = actionsOver(engine);
    const stop = acts.watchLists();
    acts.holdFiles([idOf(GOOGLE)]);
    await settle();
    down = false;
    await engine.syncOnce();
    await settle();
    stop();
    expect(liveEvents(engine, idOf(GOOGLE))?.length).toBe(1);
  });

  it("control: a list let go before the drain heals is released, and nothing is fetched", async () => {
    let down = true;
    const { engine, fetched } = await world([GOOGLE], { down: () => down });
    const acts = actionsOver(engine);
    const stop = acts.watchLists();
    acts.holdFiles([idOf(GOOGLE)]);
    await settle();
    acts.releaseFiles([idOf(GOOGLE)]);
    down = false;
    await engine.syncOnce();
    await settle();
    stop();
    expect(fetched).toEqual([]);
  });
});

describe("a crafted calendar part never takes the reader down", () => {
  const guarded = (events: unknown) => h(ErrorBoundary, {
    surface: "reader", sink: () => {},
    renderFallback: () => h("div", { "data-testid": "fallback" }),
    children: h(EventCards, { events: events as never }),
  });

  it("DURATION past the range of a Date: one card, no fallback", async () => {
    const { engine } = await world([HOSTILE_DURATION]);
    await actionsOver(engine).openMessage(idOf(HOSTILE_DURATION));
    await settle();
    const events = liveMessage(engine, idOf(HOSTILE_DURATION), view as never)!.events;
    expect(events?.length).toBe(1);
    open = mount(guarded(events));
    expect(document.querySelectorAll('[data-testid="event-card"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="fallback"]'), "the reader fell back").toBeNull();
  });

  it("a card whose render throws draws nothing; the other card and the reader stay", async () => {
    const { engine } = await world([GOOGLE]);
    await actionsOver(engine).openMessage(idOf(GOOGLE));
    await settle();
    const good = liveMessage(engine, idOf(GOOGLE), view as never)!.events![0]!;
    const throwing = new Proxy({}, { get: () => { throw new Error("hostile"); } });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    open = mount(guarded([{ partId: "bad", event: throwing }, good]));
    quiet.mockRestore();
    expect(document.querySelectorAll('[data-testid="event-card"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="fallback"]'), "the reader fell back").toBeNull();
  });
});

describe("the phone's event card", () => {
  it("draws one card per event, text only, in the reader's language", async () => {
    const { engine } = await world([GOOGLE]);
    await actionsOver(engine).openMessage(idOf(GOOGLE));
    await settle();
    const events = liveMessage(engine, idOf(GOOGLE), view as never)!.events;
    open = mount(h(EventCards, { events }));
    const el = (open as unknown as { el: HTMLElement }).el ?? document.body;
    expect(document.querySelectorAll('[data-testid="event-card"]')).toHaveLength(1);
    expect(document.querySelector('[data-testid="event-card-summary"]')?.textContent).toBe("Quarterly planning");
    expect(document.querySelector('[data-testid="event-card-kicker"]')?.textContent).toBe("Invitation");
    expect(document.querySelector('[data-testid="event-card-when"]')?.textContent).toMatch(/2026/);
    expect(document.body.textContent).toContain("Room Aare");
    expect(document.querySelectorAll('[data-rn="Pressable"]'), "the card grew a control").toHaveLength(0);
    expect(el).toBeTruthy();
    open.unmount();
    setActiveLocale("de");
    open = mount(h(EventCards, { events }));
    expect(document.querySelector('[data-testid="event-card-kicker"]')?.textContent).toBe("Einladung");
  });

  it("nothing before the texts land", () => {
    open = mount(h(EventCards, { events: undefined }));
    expect(document.querySelectorAll('[data-testid="event-card"]')).toHaveLength(0);
  });
});

describe("texts that land after the body redraw the card", () => {
  function Reader({ id, subscribe }: { id: string; subscribe: boolean }): ReactNode {
    if (subscribe) useFilesStamp([id]);
    return h(EventCards, { events: liveEvents(conn.engine as OhmailEngine, id) });
  }

  it("an engine notification alone draws the card (`useFilesStamp`)", async () => {
    const { engine, release } = await world([GOOGLE], { holdBytes: true });
    conn.engine = engine;
    void actionsOver(engine).openMessage(idOf(GOOGLE));
    await settle();
    open = mount(h(Reader, { id: idOf(GOOGLE), subscribe: true }));
    expect(document.querySelectorAll('[data-testid="event-card"]'), "the premise: no texts yet").toHaveLength(0);
    await act(async () => { release(); await settle(); });
    expect(document.querySelectorAll('[data-testid="event-card"]'), "the arrival did not redraw").toHaveLength(1);
  });

  it("control: without the subscription the arrival draws nothing", async () => {
    const { engine, release } = await world([GOOGLE], { holdBytes: true });
    conn.engine = engine;
    void actionsOver(engine).openMessage(idOf(GOOGLE));
    await settle();
    open = mount(h(Reader, { id: idOf(GOOGLE), subscribe: false }));
    await act(async () => { release(); await settle(); });
    expect(document.querySelectorAll('[data-testid="event-card"]')).toHaveLength(0);
  });
});

describe("the card's words are the web's", () => {
  const web = (locale: string): Record<string, string> => (JSON.parse(fs.readFileSync(
    path.join(HERE, "../../webapp/messages", `${locale}.json`), "utf8",
  )) as { icsEvent: Record<string, string> }).icsEvent;
  const icu = (template: string, values: Record<string, string | number>): string =>
    template
      .replace(/\{count, plural, one \{([^}]*)\} other \{([^}]*)\}\}/, (_m, one: string, other: string) =>
        (values.count === 1 ? one : other).replace("#", String(values.count)))
      .replace(/\{(\w+)\}/g, (_m, k: string) => String(values[k]));

  for (const [deck, locale] of [[EN, "en"], [DE, "de"]] as const) {
    it(`${locale}: every counted and templated line says what the web says`, () => {
      const w = web(locale);
      expect(deck.icsInvited(1)).toBe(icu(w.invited!, { count: 1 }));
      expect(deck.icsInvited(4)).toBe(icu(w.invited!, { count: 4 }));
      expect(deck.icsEveryNDays(3)).toBe(icu(w.everyNDays!, { n: 3 }));
      expect(deck.icsWeeklyOn("Tuesday")).toBe(icu(w.weeklyOn!, { days: "Tuesday" }));
      expect(deck.icsEveryNWeeks(2)).toBe(icu(w.everyNWeeks!, { n: 2 }));
      expect(deck.icsEveryNWeeksOn(2, "Tuesday")).toBe(icu(w.everyNWeeksOn!, { n: 2, days: "Tuesday" }));
      expect(deck.icsEveryNMonths(2)).toBe(icu(w.everyNMonths!, { n: 2 }));
      expect(deck.icsEveryNYears(2)).toBe(icu(w.everyNYears!, { n: 2 }));
    });
  }
});

describe("every phone body surface draws the events above the mail and subscribes to them", () => {
  /* @reads: apps/mobile/src/ui/MessageReader.tsx apps/mobile/src/ui/SenderDetail.tsx apps/mobile/app/(tabs)/reads.tsx */
  const src = (rel: string) => fs.readFileSync(path.join(HERE, "..", rel), "utf8");
  const before = (text: string, first: string, second: string, from = 0) => {
    const a = text.indexOf(first, from);
    const b = text.indexOf(second, a);
    expect(a, `${first} is missing`).toBeGreaterThanOrEqual(0);
    expect(b, `${first} is not above ${second}`).toBeGreaterThan(a);
  };

  it("the reader: the opened message and each earlier member", () => {
    const reader = src("src/ui/MessageReader.tsx");
    before(reader, "invitation ? (", "<EventCards events={m.events} />");
    before(reader, "<EventCards events={m.events} />", "<MailBodyFrame");
    before(reader, "<EventCards events={h.events}", '<BodyPages variant="streamBody"', reader.indexOf("m.earlier.map("));
    expect(reader).toMatch(/useFilesStamp\(m \? \[m\.id, \.\.\.m\.earlier\.map\(\(h\) => h\.id\)\] : \[id\]\)/);
  });

  it("the sender sheet's held mail and an open News card", () => {
    const sender = src("src/ui/SenderDetail.tsx");
    before(sender, "<EventCards events={w.eventsOf(h.id)}", '<BodyPages variant="streamBody"');
    expect(sender).toContain("useFilesStamp(");
    const reads = src("app/(tabs)/reads.tsx");
    before(reads, "{open ? <EventCards events={w.eventsOf(m.id)} /> : null}", '<BodyPages variant="streamBody"');
    expect(reads).toContain("useFilesStamp(open ? [m.id] : [])");
  });
});
