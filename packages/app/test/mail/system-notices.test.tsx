/** @vitest-environment jsdom */
/**
 * THE ONE CALLER OF A SURFACE'S SYSTEM NOTICES (`MailSystemNotices` on the mail ground): at each settle of the copy
 * the lists show, the gate is asked and the host's emitter draws what it answers. The first sample of an account
 * draws nothing (an app opened over unread mail has not just received it); the person's stored choices are the
 * host's and are read at each settle; a host that hands no choices, no emitter or no notifications has nothing drawn.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OhmailEngine, AheadSet, Notice, NoticeChoices } from "@ohmail/client-engine";
import { calendarPortOf } from "@ohmail/app-logic/calendar";
import { fixtureMailEngine } from "../../../../test/support/engine-fixtures.js";
import type { CalendarPort } from "@ohmail/app-logic/calendar/port";
import type { CalendarEventRecord, CalendarRecord } from "@ohmail/wire";
import { EngineContext } from "@ohmail/app-logic/engine";
import {
  showDevicesListed,
  toldDevicesIn,
  type HostNoticeEmitter,
} from "@ohmail/app-logic/notices/use-notices";
import { SYNC_BOOTSTRAPPING, SYNC_SETTLED, type SyncStatus } from "@ohmail/app-logic/session/sync-scheduler";
import type { FrameHost } from "../../src/frame/contract.js";
import { Frame } from "../../src/frame/Frame.js";
import { NONE, type DeviceNotifications, type None } from "../../src/host/index.js";
import { MailGround } from "../../src/mail/index.js";
import { ohboxPlace } from "../../src/ohbox/index.js";
import { TextProvider } from "../../src/text/index.js";
import { fakeMail, letter, WORDS } from "../reader/support/mail.js";
import { fakeHost } from "../support/fake-host.js";
import { fakeAddress, movable } from "../support/fake-window.js";

/** The letters' sender, admitted by a rule: the partition presents a decided sender's mail in the Ohbox. */
const ADMITTED = {
  "rule:r1": {
    id: "r1",
    kind: "sender",
    match: "ben@kiln.example",
    destination: "INBOX",
    priority: 0,
    provenance: "manual",
    enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};

/** What the surface drew, in order, and how often it was asked to take everything back. */
let drawn: Notice[] = [];
let takenBack = 0;
const emitter: HostNoticeEmitter = {
  carries: ["ohbox", "screener", "scheduled", "pairing"],
  acts: [],
  post: (notice) => void drawn.push(notice),
  ahead: "none",
  takeBack: () => void (takenBack += 1),
};

/** The switches as this device stores them: every kind on, or new mail off. */
const stored = (ohbox: boolean): NoticeChoices => ({
  master: true,
  showTitles: true,
  ohbox,
  screener: true,
  scheduled: true,
  pairing: true,
  cal_alert: false,
  cal_invitation: false,
  cal_change: false,
  cal_answer: false,
  cal_found: false,
  cal_summary: false,
});

/** The frame over the ground at History, over a host with these notifications. */
function hostOf(
  engine: OhmailEngine,
  notifications: DeviceNotifications | None,
  at = "#/history",
): FrameHost {
  const { host } = fakeHost({
    engine,
    service: "self",
    scope: "acct-1",
    address: fakeAddress(at),
    places: {
      ohbox: ohboxPlace,
      settings: {
        id: "settings",
        body: "settings",
        rail: null,
        panes: { kind: "wide", Wide: () => <p>Settings</p> },
      },
      history: {
        id: "history",
        body: "history",
        rail: null,
        panes: { kind: "wide", Wide: () => <p>History</p> },
      },
    },
    above: MailGround,
  });
  return { ...host, device: { ...host.device, notifications } };
}
const over = (engine: OhmailEngine, host: FrameHost, sync: SyncStatus) => (
  <EngineContext.Provider value={{ engine, demo: false, serverDemo: false, sync }}>
    <TextProvider locale="en" messages={WORDS.en} timeZone="Europe/Zurich">
      <Frame host={host} />
    </TextProvider>
  </EngineContext.Provider>
);
const granted = { permission: () => "granted" as const, request: async () => "granted" as const };

beforeEach(() => {
  drawn = [];
  takenBack = 0;
  localStorage.clear();
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
});
afterEach(cleanup);

describe("the system notices, called once from the mail ground", () => {
  it("draw nothing for the mail an account opens over, then a letter that arrives once the copy settled", () => {
    const mail = fakeMail([letter("m0"), letter("m1")], [], {}, ADMITTED);
    const choices = vi.fn(() => stored(true));
    const host = hostOf(mail.engine, { ...granted, emitter, choices });
    const page = render(over(mail.engine, host, SYNC_BOOTSTRAPPING));
    expect(choices, "the gate was asked while the copy was still catching up").not.toHaveBeenCalled();
    page.rerender(over(mail.engine, host, SYNC_SETTLED));
    expect(drawn, "the unread mail the app opened over was drawn as news").toEqual([]);
    act(() => mail.add(letter("m2")));
    expect(drawn.map((notice) => notice.kind)).toEqual(["ohbox"]);
  });

  it("read the person's choices at each settle: new mail switched off a moment ago is not drawn", () => {
    const mail = fakeMail([letter("m0")], [], {}, ADMITTED);
    let newMail = true;
    const host = hostOf(mail.engine, { ...granted, emitter, choices: () => stored(newMail) });
    render(over(mail.engine, host, SYNC_SETTLED));
    newMail = false;
    act(() => mail.add(letter("m1")));
    expect(drawn, "a switch that was off when the letter arrived").toEqual([]);
    newMail = true;
    act(() => mail.add(letter("m2")));
    expect(drawn.map((notice) => notice.kind)).toEqual(["ohbox"]);
  });

  it("draw nothing where the platform refuses notices", () => {
    const mail = fakeMail([letter("m0")], [], {}, ADMITTED);
    const refused = { permission: () => "denied" as const, request: async () => "denied" as const };
    render(
      over(
        mail.engine,
        hostOf(mail.engine, { ...refused, emitter, choices: () => stored(true) }),
        SYNC_SETTLED,
      ),
    );
    act(() => mail.add(letter("m1")));
    expect(drawn).toEqual([]);
  });

  it("hand the emitter nothing over a host that stores no choices, and stand over one with no notifications", () => {
    const mail = fakeMail([letter("m0")], [], {}, ADMITTED);
    const page = render(over(mail.engine, hostOf(mail.engine, { ...granted, emitter }), SYNC_SETTLED));
    act(() => mail.add(letter("m1")));
    expect(drawn, "a notice was drawn on a guess of what the person chose").toEqual([]);
    page.unmount();
    render(over(mail.engine, hostOf(mail.engine, NONE), SYNC_SETTLED));
    act(() => mail.add(letter("m2")));
    expect(screen.getByText("History")).toBeTruthy();
    expect(drawn).toEqual([]);
  });

  it("draws a newly paired device once, including after the account is reopened", () => {
    const settings = { devices: 1, devicesMade: 1, devicesRevoked: 0 };
    const mail = fakeMail([], [], {}, { ...ADMITTED, "settings:account": settings });
    const platform = {
      ...emitter,
      post: (notice: Notice) => {
        drawn.push(notice);
        return true;
      },
    };
    const host = hostOf(mail.engine, { ...granted, emitter: platform, choices: () => stored(false) });
    const page = render(over(mail.engine, host, SYNC_SETTLED));
    expect(drawn).toEqual([]);
    settings.devices = 2;
    settings.devicesMade = 2;
    act(() => mail.add(letter("wake")));
    expect(drawn).toEqual([{ kind: "pairing", change: "paired", device: null }]);
    page.unmount();
    render(over(mail.engine, host, SYNC_SETTLED));
    expect(drawn).toHaveLength(1);
    expect(toldDevicesIn().read("acct-1")).toEqual({ made: 2, revoked: 0 });
    expect(toldDevicesIn().read("another-account")).toBeNull();
  });

  it.each([
    ["#/settings/devices", true, 2, 2],
    ["#/settings/devices", false, 2, 1],
    ["#/settings/devices", true, 1, 1],
    ["#/history", true, 2, 1],
  ] as const)("at %s, focused %s and showing %i devices, remembers %i", (at, focused, listed, expected) => {
    const settings = { devices: 1, devicesMade: 1, devicesRevoked: 0 };
    const mail = fakeMail([], [], {}, { ...ADMITTED, "settings:account": settings });
    const host = hostOf(
      mail.engine,
      { ...granted, emitter, choices: () => ({ ...stored(false), pairing: false }) },
      at,
    );
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(focused);
    const leave = showDevicesListed(mail.engine, { made: listed, revoked: 0 });
    try {
      render(over(mail.engine, host, SYNC_SETTLED));
      settings.devices = 2;
      settings.devicesMade = 2;
      act(() => mail.add(letter("wake")));
      expect(drawn).toEqual([]);
      expect(toldDevicesIn().read("acct-1")).toEqual({ made: expected, revoked: 0 });
    } finally {
      leave();
      focus.mockRestore();
    }
  });

  it("take back what was drawn when the frame goes", () => {
    const mail = fakeMail([letter("m0")], [], {}, ADMITTED);
    const page = render(
      over(
        mail.engine,
        hostOf(mail.engine, { ...granted, emitter, choices: () => stored(true) }),
        SYNC_SETTLED,
      ),
    );
    page.unmount();
    expect(takenBack).toBeGreaterThan(0);
  });
});

const calendar: CalendarRecord = {
  id: "fixture-calendar",
  connectionId: "fixture-connection",
  name: "Calendar",
  color: null,
  access: "owner",
  shown: true,
  timeZone: "UTC",
  window: null,
  defaultAlarms: [],
  lastSyncedAt: null,
  errorCode: null,
  updatedAt: "2026-11-19T09:00:00Z",
};
const appointment: CalendarEventRecord = {
  id: "fixture-event",
  calendarId: calendar.id,
  uid: "fixture-event",
  recurrenceId: "",
  thisAndFuture: false,
  sequence: 0,
  status: "confirmed",
  title: "Planning",
  notes: null,
  place: null,
  callLink: null,
  start: { kind: "instant", value: "20261119T110000Z" },
  end: { kind: "instant", value: "20261119T113000Z" },
  duration: null,
  startsAt: "2026-11-19T11:00:00Z",
  endsAt: "2026-11-19T11:30:00Z",
  occurrenceAt: null,
  repeat: null,
  busy: true,
  private: false,
  organizer: null,
  myAnswer: null,
  heldBack: false,
  invitees: [],
  alarms: [{ minutesBefore: 10, method: "notice" }],
  cut: false,
  writes: [],
  updatedAt: calendar.updatedAt,
};

it("withdraws calendar reminders from the shared mail frame when this device's choices change", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 10, 19, 10));
  const unexpected = (): never => {
    throw new Error("the reminder caller used a calendar writer");
  };
  const port: CalendarPort = {
    newId: unexpected,
    press: unexpected,
    flush: unexpected,
    verdict: unexpected,
    settings: unexpected,
    held: unexpected,
    load: NONE,
    version: () => 0,
    subscribe: () => () => {},
    events: () => [{ record: appointment, waiting: null, refusal: null, refusedWriteId: null }],
  };
  const mail = fakeMail([], [], {}, { "calendar:fixture-calendar": calendar });
  Object.assign(mail.engine, { store: mail.engine.read() });
  const choicesVersion = movable(0);
  const sets: AheadSet[] = [];
  let allowed = true;
  let showTitles = true;
  let liveScope = "acct-1";
  const notifications = {
    ...granted,
    choicesVersion,
    choices: () => ({ ...stored(true), cal_alert: allowed, showTitles }),
    liveNoticeScope: () => liveScope,
    emitter: {
      ...emitter,
      carries: ["cal_alert"] as const,
      ahead: (set: AheadSet) => {
        sets.push(set);
      },
    },
  };
  const commonHost = hostOf(mail.engine, notifications);
  const host = { ...commonHost, wires: { ...commonHost.wires, calendar: port } };
  const page = render(over(mail.engine, host, SYNC_SETTLED));
  try {
    expect(sets.at(-1)).toMatchObject({
      scope: "acct-1",
      alerts: [{ eventId: "fixture-event", label: { as: "title", text: "Planning" } }],
    });
    showTitles = false;
    act(() => choicesVersion.set(1));
    expect(sets.at(-1)).toMatchObject({
      scope: "acct-1",
      alerts: [{ eventId: "fixture-event", label: { as: "event" } }],
    });
    allowed = false;
    act(() => choicesVersion.set(2));
    expect(sets.at(-1)).toEqual({ scope: "acct-1", alerts: [] });
    allowed = true;
    liveScope = "acct-2";
    act(() => choicesVersion.set(3));
    expect(sets.at(-1)).toEqual({ scope: "acct-1", alerts: [] });
    expect(sets).toHaveLength(4);
  } finally {
    page.unmount();
    now.mockRestore();
  }
});

it.each(["add an alarm", "make an event private"] as const)(
  "updates a reminder after a queued local calendar change: %s",
  async (change) => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 19, 10, 49, 59));
    const makePrivate = change === "make an event private";
    const engine = fixtureMailEngine();
    await engine.store.load();
    await engine.store.applyChanges([
      {
        type: "calendar",
        op: "create",
        id: calendar.id,
        entity: calendar,
        seq: 1,
        updatedAt: calendar.updatedAt,
      },
      {
        type: "calendar_event",
        op: "create",
        id: appointment.id,
        entity: { ...appointment, alarms: makePrivate ? appointment.alarms : [] },
        seq: 2,
        updatedAt: appointment.updatedAt,
      },
    ]);
    const unexpected = (): never => {
      throw new Error("a reminder handed in a calendar write");
    };
    const port = calendarPortOf({
      engine,
      transport: {
        writeCalendar: unexpected,
        retryCalendarWrite: unexpected,
        dismissCalendarWrite: unexpected,
      },
      clock: { now: Date.now, uuid: () => "fixture-queued-edit" },
      settings: unexpected,
      held: unexpected,
      load: NONE,
    });
    const sets: AheadSet[] = [];
    const posts: Notice[] = [];
    const sink: HostNoticeEmitter = {
      ...emitter,
      carries: ["cal_alert"],
      ahead: makePrivate
        ? (set) => {
            sets.push(set);
          }
        : NONE,
      post: (notice) => {
        posts.push(notice);
      },
    };
    const commonHost = hostOf(engine, {
      ...granted,
      choices: () => ({ ...stored(false), cal_alert: true }),
      liveNoticeScope: () => "acct-1",
      emitter: sink,
    });
    const host = { ...commonHost, wires: { ...commonHost.wires, calendar: port } };
    const page = render(over(engine, host, SYNC_SETTLED));
    try {
      if (makePrivate)
        expect(sets.at(-1)).toMatchObject({
          scope: "acct-1",
          alerts: [{ eventId: appointment.id, label: { as: "title", text: appointment.title } }],
        });
      const before = port.version();
      await act(async () => {
        await port.press({
          kind: "calendar_event_update",
          eventId: appointment.id,
          base: appointment.updatedAt,
          scope: { kind: "record" },
          change: makePrivate ? { private: true } : { alarms: [10] },
        });
      });
      expect(port.version()).toBeGreaterThan(before);
      expect(port.events()[0]?.waiting).toBe("device");
      expect(engine.read().get<CalendarEventRecord>("calendar_event", appointment.id)?.private).toBe(false);
      if (makePrivate) {
        expect(port.events()[0]?.record.private).toBe(true);
        expect(sets.at(-1)).toMatchObject({
          scope: "acct-1",
          alerts: [{ eventId: appointment.id, label: { as: "busy" } }],
        });
      } else {
        expect(port.events()[0]?.record.alarms).toEqual(appointment.alarms);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_100);
        });
        expect(posts).toMatchObject([{ kind: "cal_alert", eventId: appointment.id }]);
      }
    } finally {
      page.unmount();
      vi.useRealTimers();
    }
  },
);
