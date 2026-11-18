/** @vitest-environment jsdom */
/**
 * THE INVITATIONS' PANEL in the frame, over a mirror: three groups, an answer pressed through the port once and said
 * only after our server's verdict, the next invitation opened after it, a cancel drawn at once while its row is open,
 * a calendar that can only be looked at offering no press, and the all-clear once nothing waits.
 */
import type { CalendarAct } from "@ohmail/wire";
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
import { InvitationsPanel } from "../../src/invitations/index.js";
import { TextProvider, type Messages } from "../../src/text/index.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, type FakeAddress } from "../support/fake-window.js";
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
    store: { entries },
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

function mount(m: ReturnType<typeof mirror>, at: string, mailboxes: readonly unknown[] = []): FakeAddress {
  const address = fakeAddress(at);
  const made = fakeHost({
    engine: m.engine,
    service: "managed",
    scope: "acct-1",
    calendar: withPanel,
    products: "both",
    wires: { calendar: m.port },
    address,
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
    expect(said()).toContain("Answer saved");
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
    expect(said()).not.toContain("Answer saved");
    expect(within(rowOf("Tech check")).getByText(/Not sent yet from this device/)).toBeTruthy();
    expect(address.read()).toContain("/e/a");
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
    expect(said()).toContain("This change could not be read as written.");
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
    expect(within(panel()).getByText(/2 answered/)).toBeTruthy();
  });
});
