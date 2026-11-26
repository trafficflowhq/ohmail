/** @vitest-environment jsdom */
/**
 * THE INVITATIONS' PANEL in the frame, over a mirror: three groups, an answer pressed through the port once and said
 * only after our server's verdict, the next invitation opened after it, a cancel drawn at once while its row is open,
 * a calendar that can only be looked at offering no press, and the all-clear once nothing waits.
 */
import type { CalendarAct, EngineMessage, MessageInvitationDTO } from "@ohmail/wire";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import type {
  CalendarConnectionRecord,
  CalendarEventRecord,
  CalendarPort,
  CalendarRecord,
  CalendarVerdict,
} from "@ohmail/app-logic/calendar";
import calendarEn from "../../messages/calendar.en.json" with { type: "json" };
import eventEn from "../../messages/event.en.json" with { type: "json" };
import weekEn from "../../messages/week.en.json" with { type: "json" };
import invitationsEn from "../../messages/invitations.en.json" with { type: "json" };
import { calendar } from "../../src/calendar/entry.js";
import { Frame } from "../../src/frame/Frame.js";
import type { CalendarEntry } from "../../src/frame/contract.js";
import { readerEntry } from "../../src/reader/index.js";
import { InvitationsPanel } from "../../src/invitations/index.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, fakeWindow, type FakeAddress } from "../support/fake-window.js";
import {
  bodyDouble,
  fakeMail,
  letter,
  mountReader,
  READER_PLACE,
  WRITE_PLACE,
  WORDS as readerWords,
} from "../reader/support/mail.js";
import { FRAME_WORDS } from "../support/frame-words.js";

const ZURICH = "Europe/Zurich";
const UPDATED = "2026-11-01T08:00:00.000Z";
const WORDS = {
  ...FRAME_WORDS.en,
  ...calendarEn,
  ...eventEn,
  ...weekEn,
  ...invitationsEn,
} as unknown as Messages;
const withPanel: CalendarEntry = {
  ...calendar,
  panels: { ...calendar.panels, invitations: InvitationsPanel },
};

const connection: CalendarConnectionRecord = {
  id: "conn-1",
  provider: "google",
  label: "Studio",
  status: "active",
  errorCode: null,
  grantMailboxId: null,
  serverHost: null,
  consentedAt: UPDATED,
  lastSyncedAt: UPDATED,
  createdAt: UPDATED,
  updatedAt: UPDATED,
};
const studio: CalendarRecord = {
  id: "cal-1",
  connectionId: "conn-1",
  name: "Studio",
  color: "#3366cc",
  access: "owner",
  shown: true,
  timeZone: ZURICH,
  window: null,
  defaultAlarms: [],
  lastSyncedAt: null,
  errorCode: null,
  updatedAt: UPDATED,
};
function invitation(
  id: string,
  title: string,
  day: string,
  over: Partial<CalendarEventRecord> = {},
): CalendarEventRecord {
  return {
    id,
    calendarId: "cal-1",
    uid: `${id}@studio.test`,
    recurrenceId: "",
    thisAndFuture: false,
    sequence: 0,
    status: "confirmed",
    title,
    notes: null,
    place: null,
    callLink: null,
    start: { kind: "zoned", value: `${day}T100000`, zone: ZURICH },
    end: { kind: "zoned", value: `${day}T110000`, zone: ZURICH },
    duration: null,
    startsAt: UPDATED,
    endsAt: UPDATED,
    occurrenceAt: null,
    repeat: null,
    busy: true,
    private: false,
    organizer: { address: "marco@elsewhere.test", name: "Marco" },
    myAnswer: "none",
    heldBack: false,
    invitees: [],
    alarms: [],
    cut: false,
    writes: [],
    updatedAt: UPDATED,
    ...over,
  };
}

/**
 * A mirror as far as the panel reads one, and a port that keeps every press and answers it with the verdict the case
 * sets. An owed press is laid over its event as waiting on this device, as the queue's overlay does.
 */
function mirror(verdictOf: (act: CalendarAct) => CalendarVerdict | null) {
  const kinds = new Map<string, Map<string, unknown>>();
  const heard = new Set<() => void>();
  const pressed: CalendarAct[] = [];
  const verdicts = new Map<string, CalendarVerdict | null>();
  const owed = new Map<string, CalendarEventRecord>();
  let version = 0;
  const moved = () => {
    version += 1;
    for (const listener of [...heard]) listener();
  };
  const entries = (type: string) => [...(kinds.get(type)?.values() ?? [])].map((entity) => ({ entity }));
  const subscribe = (listener: () => void) => {
    heard.add(listener);
    return () => void heard.delete(listener);
  };
  const engine = {
    store: { entries, get: (kind: string, id: string) => kinds.get(kind)?.get(id) },
    subscribe,
    read: () => ({ version: () => version }),
  } as unknown as OhmailEngine;
  const port: CalendarPort = {
    newId: () => "new",
    async press(a) {
      pressed.push(a);
      const key = `key-${pressed.length}`;
      const verdict = verdictOf(a);
      verdicts.set(key, verdict);
      if (verdict === null && a.kind === "calendar_event_answer") {
        const record = kinds.get("calendar_event")?.get(a.eventId) as CalendarEventRecord;
        owed.set(a.eventId, { ...record, myAnswer: a.answer });
      }
      moved();
      return { key };
    },
    flush: async () => undefined,
    verdict: (key) => verdicts.get(key) ?? null,
    events: () =>
      entries("calendar_event").map(({ entity }) => {
        const record = entity as CalendarEventRecord;
        const laid = owed.get(record.id);
        return {
          record: laid ?? record,
          waiting: laid ? "device" : null,
          refusal: null,
          refusedWriteId: null,
        };
      }),
    settings: () => new Promise(() => undefined),
    held: () => ({ window: { daysBack: 30, daysAhead: 365, maxRows: 5000 }, loaded: [] }),
    load: "none",
    version: () => version,
    subscribe,
  };
  const put = (type: string, id: string, entity: unknown) => {
    const kind = kinds.get(type) ?? new Map<string, unknown>();
    kinds.set(type, kind);
    kind.set(id, entity);
    moved();
  };
  put("calendar_connection", connection.id, connection);
  return { engine, port, put, pressed };
}

function mount(
  m: ReturnType<typeof mirror>,
  at: string,
  mailboxes: readonly unknown[] = [],
  phone = false,
  writeGuests?: CalendarEntry["writeGuests"],
): FakeAddress {
  const address = fakeAddress(at);
  const made = fakeHost({
    engine: m.engine,
    service: "managed",
    scope: "acct-1",
    calendar: writeGuests ? { ...withPanel, writeGuests } : withPanel,
    products: writeGuests ? "calendar" : "both",
    wires: { calendar: m.port },
    address,
    ...(phone ? { window: fakeWindow("phone") } : {}),
  });
  /* The account's mailboxes, as the host reads them. */
  const host = { ...made.host, reads: { ...made.host.reads, mailboxes: async () => [...mailboxes] } };
  render(
    <TextProvider locale="en" messages={WORDS} timeZone={ZURICH}>
      <Frame host={host} />
    </TextProvider>,
  );
  return address;
}

const panel = () => screen.getByRole("complementary", { name: "Invitations" });
/* The row, not the open row's card under it, which says its title too. */
const rowOf = (title: string) =>
  within(panel())
    .getAllByText(title)
    .map((el) => el.closest(".oh-erow"))
    .find((el): el is HTMLElement => el !== null)!;
/* What the report slot says: its words stand in more than one element. */
const said = () =>
  screen
    .queryAllByRole("status")
    .map((s) => s.textContent ?? "")
    .join(" | ");
const settle = () =>
  act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-16T08:00:00Z"));
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the invitations' panel", () => {
  it("shows conflicts on the phone invitation without answering it", async () => {
    const m = mirror(() => ({ kind: "taken", write: null }));
    m.put("calendar", studio.id, studio);
    m.put(
      "calendar_event",
      "set-up",
      invitation("set-up", "Stand set-up", "20261118", { myAnswer: null, organizer: null }),
    );
    m.put("calendar_event", "tech", invitation("tech", "Tech check", "20261118"));
    mount(m, "#/cal/day/2026-11-18?panel=invitations", [], true);
    await settle();
    const compact = within(screen.getByRole("dialog", { name: "Invitations" }));
    expect(compact.getByText(/overlaps Stand set-up/i)).toBeTruthy();
    expect(m.pressed).toEqual([]);
  });

  it("writes to the organizer of a received phone invitation without sending an RSVP", async () => {
    const m = mirror(() => ({ kind: "taken", write: null }));
    const write = vi.fn(async () => {});
    const organizer = ["organizer", "example.invalid"].join("@");
    const own = ["here", "example.invalid"].join("@");
    m.put("calendar", studio.id, studio);
    m.put("calendar_connection", connection.id, connection);
    m.put(
      "calendar_event",
      "tech",
      invitation("tech", "Tech check", "20261118", {
        organizer: { address: organizer, name: "Organizer" },
        invitees: [{ address: own, name: "Here", role: "required", answer: "none" }],
      }),
    );
    mount(m, "#/cal/day/2026-11-18/e/tech?panel=invitations", [{ address: own }], true, write);
    await settle();
    const compact = within(screen.getByRole("dialog", { name: "Invitations" }));
    fireEvent.click(compact.getByRole("button", { name: "Write to invitees" }));
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith([organizer], "Tech check");
    expect(m.pressed).toEqual([]);
  });

  it("shows a single invitation on a phone and moves between invitations without answering", async () => {
    const m = mirror(() => ({ kind: "taken", write: null }));
    m.put("calendar", studio.id, studio);
    m.put("calendar_event", "a", invitation("a", "Tech check", "20261118"));
    m.put("calendar_event", "b", invitation("b", "Planning call", "20261119"));
    const address = mount(m, "#/cal/day/2026-11-18?panel=invitations", [], true);
    await settle();
    const compact = within(screen.getByRole("dialog", { name: "Invitations" }));
    expect(compact.getByRole("heading", { name: "Tech check" })).toBeTruthy();
    expect(compact.queryByRole("heading", { name: "Planning call" })).toBeNull();
    fireEvent.click(compact.getByRole("button", { name: "The next" }));
    expect(compact.getByRole("heading", { name: "Planning call" })).toBeTruthy();
    expect(address.read()).toContain("/2026-11-19/");
    expect(m.pressed).toEqual([]);
    fireEvent.click(compact.getByRole("button", { name: "Yes" }));
    await settle();
    expect(m.pressed).toMatchObject([{ kind: "calendar_event_answer", eventId: "b", answer: "accepted" }]);
  });

  it("lists To answer, Changed and Answered, and answers on the open row once our server has taken it", async () => {
    const m = mirror(() => ({ kind: "taken", write: null }));
    m.put("calendar", studio.id, studio);
    m.put("calendar_event", "a", invitation("a", "Tech check", "20261118"));
    m.put("calendar_event", "b", invitation("b", "Planning call", "20261119"));
    m.put("calendar_event", "c", invitation("c", "Shoot", "20261117", { status: "cancelled" }));
    m.put("calendar_event", "d", invitation("d", "Review", "20261120", { myAnswer: "accepted" }));
    const address = mount(m, "#/cal/week/2026-11-18/e/a?panel=invitations");
    for (const group of ["To answer", "Changed", "Answered"])
      expect(within(panel()).getByRole("heading", { name: new RegExp(group) })).toBeTruthy();
    expect(within(rowOf("Shoot")).queryByRole("button", { name: "Yes" })).toBeNull();
    /* The answers stand on the open row alone. */
    expect(within(rowOf("Planning call")).queryByRole("button", { name: "Yes" })).toBeNull();

    fireEvent.click(within(rowOf("Tech check")).getByRole("button", { name: "Yes" }));
    await settle();
    expect(m.pressed).toEqual([
      {
        kind: "calendar_event_answer",
        eventId: "a",
        base: UPDATED,
        scope: { kind: "record" },
        answer: "accepted",
      },
    ]);
    expect(said()).toContain("Yes");
    /* The next invitation that waits opens, at its day. */
    expect(address.read()).toContain("/2026-11-19/e/b");
  });

  it("draws a cancel that arrives while its row is open, struck under Changed, with nothing to press", async () => {
    const m = mirror(() => ({ kind: "taken", write: null }));
    m.put("calendar", studio.id, studio);
    m.put("calendar_event", "a", invitation("a", "Tech check", "20261118"));
    mount(m, "#/cal/week/2026-11-18/e/a?panel=invitations");
    expect(within(rowOf("Tech check")).getByRole("button", { name: "Yes" })).toBeTruthy();

    act(() =>
      m.put("calendar_event", "a", invitation("a", "Tech check", "20261118", { status: "cancelled" })),
    );
    const row = rowOf("Tech check");
    expect(row.hasAttribute("data-off")).toBe(true);
    expect(within(row).queryByRole("button", { name: "Yes" })).toBeNull();
    expect(within(panel()).getByRole("heading", { name: /Changed/ })).toBeTruthy();
    expect(within(panel()).queryByRole("heading", { name: /To answer/ })).toBeNull();
    expect(m.pressed).toEqual([]);
  });

  it("offers no press on a calendar that can only be looked at, and says why", async () => {
    const m = mirror(() => ({ kind: "taken", write: null }));
    m.put("calendar", studio.id, { ...studio, access: "reader" });
    m.put("calendar_event", "a", invitation("a", "Tech check", "20261118"));
    mount(m, "#/cal/week/2026-11-18/e/a?panel=invitations");
    /* No answer buttons that do nothing: a view-only row draws none. */
    for (const name of ["Yes", "Maybe", "No"])
      expect(within(rowOf("Tech check")).queryByRole("button", { name })).toBeNull();
    expect(m.pressed).toEqual([]);
    expect(within(panel()).getByText(/This calendar can be looked at, not changed/)).toBeTruthy();
  });

  it("says nothing while an answer is owed, and the row says it waits on this device", async () => {
    const m = mirror(() => null);
    m.put("calendar", studio.id, studio);
    m.put("calendar_event", "a", invitation("a", "Tech check", "20261118"));
    m.put("calendar_event", "b", invitation("b", "Planning call", "20261119"));
    const address = mount(m, "#/cal/week/2026-11-18/e/a?panel=invitations");
    fireEvent.click(within(rowOf("Tech check")).getByRole("button", { name: "Maybe" }));
    await settle();
    expect(m.pressed).toHaveLength(1);
    expect(said()).not.toContain("Maybe");
    expect(within(rowOf("Tech check")).getByText(/Waiting/)).toBeTruthy();
    expect(address.read()).toContain("/e/a");
  });

  it.each([false, true])(
    "keeps the Outlook choice and offers only explicit resend after checking (phone: %s)",
    async (phone) => {
      const m = mirror(() => ({ kind: "taken", write: null }));
      m.put("calendar_connection", connection.id, { ...connection, provider: "microsoft" });
      m.put("calendar", studio.id, studio);
      const invite = invitation("a", "Tech check", "20261118", { myAnswer: "tentative" });
      m.put("calendar_event", invite.id, invite);
      const events = m.port.events;
      let waiting = true;
      m.port.events = () =>
        events().map((event) =>
          waiting
            ? { ...event, waiting: "provider", replyUnconfirmed: true }
            : { ...event, refusal: "answer_unconfirmed", refusedWriteId: "reply" },
        );
      mount(m, "#/cal/week/2026-11-18/e/a?panel=invitations", [], phone);
      const content = within(panel());
      expect(content.getByRole("button", { name: "Maybe" }).getAttribute("aria-pressed")).toBe("true");
      const checking = content.queryByText(/Reply unconfirmed/);
      expect(content.queryByText("Your reply may not have reached the organizer")).toBeNull();
      expect(content.queryByRole("button", { name: "Send reply again" })).toBeNull();

      waiting = false;
      act(() => m.put("calendar_event", invite.id, invite));
      expect(content.getByRole("button", { name: "Maybe" }).getAttribute("aria-pressed")).toBe("true");
      const send = content.getByRole("button", { name: "Send reply again" });
      expect(content.getByText("Your reply may not have reached the organizer")).toBeTruthy();
      expect(content.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(content.queryByRole("button", { name: "Let go" })).toBeNull();
      expect(m.pressed).toEqual([]);

      fireEvent.click(send);
      fireEvent.click(send);
      await settle();
      expect(m.pressed).toEqual([{ kind: "calendar_write_retry", writeId: "reply", resendReply: true }]);
      expect(checking).toBeTruthy();
      act(() => m.put("calendar", studio.id, { ...studio, access: "reader" }));
      expect(content.queryByRole("button", { name: "Send reply again" })).toBeNull();
    },
  );

  it("keeps the standard retry for an ordinary refusal in the Invitations panel", async () => {
    const m = mirror(() => ({ kind: "taken", write: null }));
    m.put("calendar", studio.id, studio);
    m.put("calendar_event", "a", invitation("a", "Tech check", "20261118"));
    const events = m.port.events;
    m.port.events = () =>
      events().map((event) => ({ ...event, refusal: "unreachable", refusedWriteId: "retry" }));
    mount(m, "#/cal/week/2026-11-18/e/a?panel=invitations");
    const content = within(panel());
    expect(content.getByRole("button", { name: "Let go" })).toBeTruthy();
    expect(content.queryByRole("button", { name: "Send reply again" })).toBeNull();
    fireEvent.click(content.getByRole("button", { name: "Try again" }));
    await settle();
    expect(m.pressed).toEqual([{ kind: "calendar_write_retry", writeId: "retry" }]);
  });

  it("queues one answer for two presses of Yes on the open invitation while the first is owed", async () => {
    const m = mirror(() => null);
    m.put("calendar", studio.id, studio);
    m.put("calendar_event", "a", invitation("a", "Tech check", "20261118"));
    mount(m, "#/cal/week/2026-11-18/e/a?panel=invitations");
    fireEvent.click(within(rowOf("Tech check")).getByRole("button", { name: "Yes" }));
    await settle();
    fireEvent.click(within(rowOf("Tech check")).getByRole("button", { name: "Yes" }));
    await settle();
    expect(m.pressed).toHaveLength(1);
  });

  it("says the refusal's word and stays on the row", async () => {
    const m = mirror(() => ({ kind: "refused", word: "validation_failed", details: null }));
    m.put("calendar", studio.id, studio);
    m.put("calendar_event", "a", invitation("a", "Tech check", "20261118"));
    mount(m, "#/cal/week/2026-11-18/e/a?panel=invitations");
    fireEvent.click(within(rowOf("Tech check")).getByRole("button", { name: "No" }));
    await settle();
    expect(said()).toContain("This change could not be read as written");
  });

  it("walks the rows with j and k inside the panel, and closes it with Escape", () => {
    const m = mirror(() => null);
    m.put("calendar", studio.id, studio);
    m.put("calendar_event", "a", invitation("a", "Tech check", "20261118"));
    m.put("calendar_event", "b", invitation("b", "Planning call", "20261119"));
    const address = mount(m, "#/cal/week/2026-11-18/e/a?panel=invitations");
    fireEvent.keyDown(rowOf("Tech check"), { key: "j" });
    expect(address.read()).toContain("/2026-11-19/e/b");
    fireEvent.keyDown(rowOf("Planning call"), { key: "k" });
    expect(address.read()).toContain("/2026-11-18/e/a");
    fireEvent.keyDown(rowOf("Tech check"), { key: "Escape" });
    expect(address.read()).not.toContain("panel=invitations");
  });

  it("lists no event one of the account's own addresses organizes", async () => {
    const m = mirror(() => null);
    m.put("calendar", studio.id, studio);
    m.put("calendar_event", "a", invitation("a", "Tech check", "20261118"));
    m.put(
      "calendar_event",
      "b",
      invitation("b", "Studio day", "20261119", {
        organizer: { address: "Ada@Studio.test", name: "Ada" },
      }),
    );
    mount(m, "#/cal/week/2026-11-18?panel=invitations", [
      { address: "ada@studio.test", addressIsOwn: true },
      { address: "shared@studio.test", addressIsOwn: false },
    ]);
    await settle();
    expect(within(panel()).getByText("Tech check")).toBeTruthy();
    expect(within(panel()).queryByText("Studio day")).toBeNull();
  });

  it("says the all-clear with the count once nothing waits", () => {
    const m = mirror(() => null);
    m.put("calendar", studio.id, studio);
    m.put("calendar_event", "a", invitation("a", "Tech check", "20261118", { myAnswer: "accepted" }));
    m.put("calendar_event", "b", invitation("b", "Planning call", "20261119", { myAnswer: "declined" }));
    mount(m, "#/cal/week/2026-11-18?panel=invitations");
    expect(within(panel()).getByText((_text, element) => element?.textContent === "2 answered")).toBeTruthy();
  });
});

describe("an invitation opened in the calendar", () => {
  function openCard(
    m: ReturnType<typeof mirror>,
    readMailboxes: () => Promise<unknown[]> = async () => [],
    at = "#/cal/week/2026-11-18/e/a",
    letters: readonly EngineMessage[] = [],
    copy?: (text: string) => Promise<boolean>,
    rows?: Readonly<Record<string, unknown>>,
  ) {
    const address = fakeAddress(at);
    const engine = Object.assign(fakeMail([]).engine, { store: m.engine.store });
    const mounted = mountReader({
      letters,
      rows,
      open: null,
      host: {
        engine,
        calendar: withPanel,
        places: {
          ohbox: READER_PLACE,
          write: WRITE_PLACE,
          news: { ...READER_PLACE, id: "news", rail: null },
          screener: { ...READER_PLACE, id: "screener", rail: null },
          folder: { ...READER_PLACE, id: "folder", rail: null },
        },
        ...(copy && {
          reader: {
            ...readerEntry({
              body: bodyDouble().body,
              look: "none",
              files: "none",
              pictures: "none",
              sentCopy: "none",
              reply: "none",
              invitation: "none",
            }),
            copy,
          },
        }),
        products: "both",
        wires: { calendar: m.port },
        mailboxes: readMailboxes,
        address,
      },
      words: { ...readerWords.en, ...WORDS },
    });
    return { address, unmount: mounted.view.unmount };
  }
  const given = () => within(screen.getByRole("dialog", { name: "Tech check" }));
  const place = (m: ReturnType<typeof mirror>) => {
    m.put("calendar", studio.id, studio);
    m.put("calendar_event", "a", invitation("a", "Tech check", "20261118"));
  };

  it("offers a secure external call link in the event card and panel, and copies it on request", async () => {
    const m = mirror(() => null);
    const link = new URL("/meeting", "https://calls.example.test").href;
    m.put("calendar", studio.id, studio);
    m.put("calendar_event", "a", invitation("a", "Tech check", "20261118", { callLink: link }));
    const copy = vi.fn(async () => true);
    openCard(m, undefined, undefined, [], copy);
    const join = given().getByRole("link", { name: "Join" });
    expect(join.getAttribute("href")).toBe(link);
    expect(join.getAttribute("target")).toBe("_blank");
    expect(join.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getAllByRole("link", { name: "Join" }).length).toBeGreaterThan(1);
    fireEvent.click(given().getByRole("button", { name: "Copy" }));
    await settle();
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledWith(link);
    expect(said()).toContain("Copied");
  });

  it("offers Join on a readable shared event without exposing busy-only details", () => {
    const m = mirror(() => null);
    const link = new URL("/meeting", "https://calls.example.test").href;
    m.put("calendar", studio.id, { ...studio, access: "reader" });
    m.put("calendar_event", "a", invitation("a", "Tech check", "20261118", { callLink: link }));
    openCard(m);
    expect(given().getByRole("link", { name: "Join" }).getAttribute("href")).toBe(link);
    expect(given().queryByRole("button", { name: "Copy" })).toBeNull();
    act(() => m.put("calendar", studio.id, { ...studio, access: "busy" }));
    expect(screen.queryByRole("link", { name: "Join" })).toBeNull();
  });

  it("offers Join in the Week menu only for an HTTPS call link", () => {
    const m = mirror(() => null);
    m.put("calendar", studio.id, studio);
    const link = new URL("/meeting", "https://calls.example.test").href;
    m.put("calendar_event", "a", invitation("a", "Tech check", "20261118", { callLink: link }));
    openCard(m, undefined, "#/cal/week/2026-11-18");
    const chip = screen.getByRole("button", { name: /Tech check/ });
    fireEvent.contextMenu(chip);
    const menu = () => within(screen.getByRole("menu", { name: "Event actions" }));
    const join = menu().getByRole("menuitem", { name: "Join" });
    expect(join.getAttribute("href")).toBe(link);
    expect(join.getAttribute("rel")).toBe("noopener noreferrer");
    for (const callLink of [
      "http:" + link.slice(6),
      "javascript:void(0)",
      link + "\t",
      link.replace("https://", "https:///"),
      link.replace("https://", "https://user@"),
    ]) {
      act(() => m.put("calendar_event", "a", invitation("a", "Tech check", "20261118", { callLink })));
      expect(menu().queryByRole("menuitem", { name: "Join" })).toBeNull();
    }
  });

  it.each([
    ["card", "INBOX", "#/ohbox/m/matched"],
    ["menu", "INBOX", "#/ohbox/m/matched"],
    ["card", "ohmail/News", "#/reads/m/matched"],
    ["menu", "ohmail/Screened", "#/screener/screened"],
    ["card", "ohmail/Quarantine", "#/screener/spam"],
    ["menu", "Archive", "#/folder/chosen/m/matched"],
    ["card", "Projects/Plans", "#/folder/chosen/m/matched"],
  ] as const)(
    "opens the matched invitation letter from the event %s in %s",
    async (source, folder, target) => {
      const m = mirror(() => null);
      place(m);
      const marker: MessageInvitationDTO = {
        method: "REQUEST",
        uid: invitation("a", "Tech check", "20261118").uid,
        recurrenceId: "",
        sequence: 0,
        start: null,
        startsAt: null,
        organizer: null,
        invitedAddress: null,
        answer: null,
        answeredAt: null,
      };
      const matched = letter("matched", { subject: "An invitation for the check", folder });
      const rows =
        folder === "Archive" || folder === "Projects/Plans"
          ? {
              "folder:other": { id: "other", name: folder, mailboxId: "another-mailbox", mailbox: "" },
              "folder:chosen": { id: "chosen", name: folder, mailboxId: matched.mailboxId, mailbox: "" },
            }
          : undefined;
      const letters = [
        { ...matched, invitation: marker },
        {
          ...letter("different", { subject: "A different invitation" }),
          invitation: { ...marker, uid: "another-event" },
        },
      ];
      const { address } = openCard(
        m,
        undefined,
        source === "card" ? undefined : "#/cal/week/2026-11-18",
        letters,
        undefined,
        rows,
      );
      if (source === "card") {
        expect(given().getByText("Letter")).toBeTruthy();
        expect(given().queryByText("A different invitation")).toBeNull();
        fireEvent.click(given().getByRole("button", { name: "An invitation for the check" }));
      } else {
        fireEvent.contextMenu(screen.getByRole("button", { name: /Tech check/ }));
        fireEvent.click(screen.getByRole("menuitem", { name: "Open the letter" }));
      }
      await settle();
      expect(address.read()).toBe(target);
      expect(m.pressed).toEqual([]);
    },
  );

  it("answers from the Week menu and reports the result after the menu closes", async () => {
    const m = mirror(() => ({ kind: "taken", write: null }));
    place(m);
    openCard(m, undefined, "#/cal/week/2026-11-18");
    await settle();
    fireEvent.contextMenu(screen.getByRole("button", { name: /Tech check/ }));
    const menu = within(screen.getByRole("menu", { name: "Event actions" }));
    fireEvent.click(menu.getByRole("menuitemradio", { name: "Yes" }));
    expect(screen.queryByRole("menu", { name: "Event actions" })).toBeNull();
    await settle();
    expect(m.pressed).toMatchObject([{ kind: "calendar_event_answer", eventId: "a", answer: "accepted" }]);
    expect(said()).toContain("Yes");
  });

  it("does not offer answers in the Week menu for a view-only calendar", async () => {
    const m = mirror(() => null);
    place(m);
    m.put("calendar", studio.id, { ...studio, access: "reader" });
    openCard(m, undefined, "#/cal/week/2026-11-18");
    await settle();
    fireEvent.contextMenu(screen.getByRole("button", { name: /Tech check/ }));
    const menu = within(screen.getByRole("menu", { name: "Event actions" }));
    expect(menu.queryByRole("menuitemradio", { name: "Yes" })).toBeNull();
    expect(m.pressed).toEqual([]);
  });

  it("changes the answer on the open event, keeps the card in place and sends each choice once", async () => {
    const m = mirror(() => null);
    place(m);
    const { address } = openCard(m);
    const yes = await given().findByRole("button", { name: "Yes" });
    fireEvent.click(yes);
    fireEvent.click(yes);
    await settle();
    expect(yes.getAttribute("aria-pressed")).toBe("true");
    expect(given().getByText("Waiting")).toBeTruthy();
    const maybe = given().getByRole("button", { name: "Maybe" });
    fireEvent.click(maybe);
    await settle();
    expect(maybe.getAttribute("aria-pressed")).toBe("true");
    expect(m.pressed).toEqual(
      ["accepted", "tentative"].map((answer) => ({
        kind: "calendar_event_answer",
        eventId: "a",
        base: UPDATED,
        scope: { kind: "record" },
        answer,
      })),
    );
    expect(address.read()).toContain("/e/a");
  });

  it("waits for the mailbox identity and withdraws the answers when the event becomes view only", async () => {
    const m = mirror(() => null);
    place(m);
    let resolve!: (rows: unknown[]) => void;
    openCard(
      m,
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    expect(given().queryByRole("group", { name: "Answer" })).toBeNull();
    await act(async () => resolve([]));
    expect(given().getByRole("button", { name: "Yes" })).toBeTruthy();
    act(() => m.put("calendar", studio.id, { ...studio, access: "reader" }));
    expect(given().queryByRole("button", { name: "Yes" })).toBeNull();
    expect(m.pressed).toEqual([]);
  });

  it("offers no answer on one's own event and says when an invited answer was refused", async () => {
    const m = mirror(() => ({ kind: "refused", word: "calendar_read_only", details: null }));
    place(m);
    const organizer = invitation("a", "Tech check", "20261118").organizer!;
    openCard(m, async () => [{ address: organizer.address }]);
    await settle();
    expect(given().queryByRole("button", { name: "Yes" })).toBeNull();
    act(() =>
      m.put(
        "calendar_event",
        "a",
        invitation("a", "Tech check", "20261118", {
          organizer: { name: "Pat", address: "pat@studio.test" },
        }),
      ),
    );
    fireEvent.click(await given().findByRole("button", { name: "No" }));
    await settle();
    expect(said()).toContain("This calendar can be looked at, not changed");
    expect(given().getByRole("button", { name: "No" }).getAttribute("aria-pressed")).toBe("false");
  });
});
