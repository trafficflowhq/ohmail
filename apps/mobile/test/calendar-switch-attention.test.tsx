/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { EventWithWrites } from "@ohmail/client-engine/calendar-acts";
import { calendarOf, connection, invitation, OWN, ZURICH } from "../../../packages/app-logic/test/calendar/invitations/fixtures";
import { mount, styleOf } from "./_rendered-dom";

const mirror = vi.hoisted(() => ({
  available: true, known: true, owner: "fixture", version: 0,
  events: [] as EventWithWrites[],
  listeners: new Set<() => void>(),
  read: vi.fn(),
  open: vi.fn(async () => "opened"),
}));

vi.mock("react-native", async () => (await import("./_rendered-dom")).rnDom);
vi.mock("../src/theme", () => ({
  useTheme: () => ({ c: { ink: "black", panel: "white" }, radius: { pill: 40 } }),
}));
vi.mock("../src/state/live", () => ({ readerZone: () => "Europe/Zurich" }));
vi.mock("../src/state/world", () => {
  const session = { ownerKey: "fixture", engine: { read: mirror.read } };
  return {
    useLiveSession: () => session,
    useWorld: () => ({ worldKey: mirror.owner, mailboxes: { known: mirror.known, ownAddresses: [OWN] } }),
  };
});
vi.mock("../src/state/mail-event-port", () => {
  const port = {
    version: () => mirror.version,
    subscribe: (listener: () => void) => {
      mirror.listeners.add(listener);
      return () => { mirror.listeners.delete(listener); };
    },
    held: () => ({ window: { daysAhead: 30 } }),
    events: () => mirror.events,
  };
  return { mailEventPort: () => mirror.available ? port : null };
});
vi.mock("../src/switch/mail-calendar-port", () => ({
  mailCalendarPort: () => ({ native: { otherState: () => "unknown" }, sender: { open: mirror.open } }),
}));
vi.mock("../src/ui/base", () => ({
  Tap: ({ children, onPress, accessibilityLabel, accessibilityHint }: {
    children: ReactNode; onPress: () => void; accessibilityLabel: string; accessibilityHint?: string;
  }) => <button aria-label={accessibilityLabel} onClick={onPress} data-hint={accessibilityHint}>{children}</button>,
  Txt: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  Rule: () => <hr />,
}));
vi.mock("../src/ui/Icon", () => ({ Icon: () => null, NavigationIcon: () => null }));
vi.mock("../src/ui/posture", () => ({ usePosture: () => ({ sizeClass: "compact", heightClass: "medium" }) }));
vi.mock("../src/ui/Sheet", () => ({ Sheet: () => null, SheetRow: () => null }));

const { MailCalendarSwitch } = await import("../src/ui/MailCalendarSwitch");
const { calendarMark } = await import("../src/theme/mail");

const chrome = {
  shapes(root: Element) {
    return [...root.querySelectorAll("button [data-rn]")].map(styleOf)
      .filter((style) => style.backgroundColor === calendarMark || style.borderColor === calendarMark)
      .map((style) => style.width);
  },
  header(root: Element) { return root.querySelector("button")!; },
  drawer(root: Element) { return root.querySelectorAll("button")[1]!; },
};

const waiting = (over: Parameters<typeof invitation>[2] = {}): EventWithWrites => ({
  record: invitation("Review", "20261128", over),
  waiting: null,
  refusal: null,
  refusedWriteId: null,
});
const controls = () => <><MailCalendarSwitch /><MailCalendarSwitch drawer /></>;

function setup() {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-26T12:00:00+01:00"));
  mirror.read.mockImplementation(() => ({
    list: (kind: string) => kind === "calendar" ? [calendarOf({ timeZone: ZURICH })] : [connection()],
  }));
  return mount(controls());
}

function publish(...events: EventWithWrites[]) {
  act(() => {
    mirror.events = events;
    mirror.version++;
    for (const listener of mirror.listeners) listener();
  });
}

afterEach(() => {
  mirror.available = true;
  mirror.known = true;
  mirror.owner = "fixture";
  mirror.events = [];
  mirror.version = 0;
  vi.restoreAllMocks();
});

it("keeps only the drawer wordmark period when the native calendar cannot say", () => {
  mirror.available = false;
  const view = setup();
  try {
    expect(chrome.shapes(view.el)).toEqual([5]);
    expect(chrome.header(view.el).getAttribute("data-hint")).toBeNull();
    expect(chrome.drawer(view.el).textContent).toBe("ohcal");
  } finally { view.unmount(); }
});

it("shows attention only while an actual invitation awaits this calendar account's answer", () => {
  const view = setup();
  try {
    expect(chrome.shapes(view.el)).toEqual([5]);
    publish(waiting());
    expect(chrome.shapes(view.el)).toEqual([10, 5, 8]);
    expect(chrome.header(view.el).getAttribute("data-hint")).toBe("Invitations are waiting");
    expect(chrome.drawer(view.el).getAttribute("data-hint")).toBe("Invitations are waiting");
    publish(waiting({ myAnswer: "accepted" }));
    expect(chrome.shapes(view.el)).toEqual([5]);
    publish(waiting({ organizer: { address: OWN, name: null } }));
    expect(chrome.shapes(view.el)).toEqual([5]);
  } finally { view.unmount(); }
});

it("does not borrow attention from an unverified mailbox roster or another session", () => {
  mirror.events = [waiting()];
  mirror.known = false;
  const view = setup();
  try {
    expect(chrome.shapes(view.el)).toEqual([5]);
    mirror.known = true;
    mirror.owner = "other";
    view.render(controls());
    expect(chrome.shapes(view.el)).toEqual([5]);
  } finally { view.unmount(); }
});
