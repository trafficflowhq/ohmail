/** @vitest-environment jsdom */
import { act, createElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import type { FoundRow } from "@ohmail/app-logic/calendar/found";
import { mount } from "./_rendered-dom";

vi.mock("react-native", async () => (await import("./_rendered-dom")).rnDom);
vi.mock("../src/ui/Icon", () => ({ Icon: () => null }));
vi.mock("../src/state/world", () => ({ useLiveSession: () => null }));
vi.mock("../src/theme", () => ({
  useTheme: () => ({ scheme: "light", radius: { row: 12, focus: 6 }, c: { panel: "#fff" } }),
}));
vi.mock("../src/ui/base", () => ({
  Tap: ({ accessibilityLabel, onPress, disabled, children }: {
    accessibilityLabel: string; onPress: () => void; disabled?: boolean; children: ReactNode;
  }) => createElement("button", { "aria-label": accessibilityLabel, onClick: onPress, disabled }, children),
  Txt: ({ children }: { children: ReactNode }) => createElement("span", null, children),
}));

const { MailFoundEvents } = await import("../src/ui/MailFoundEvents");
const { Copy } = await import("../src/copy");

const start = { kind: "date", value: "20261112" } as const;
const fields: FoundRow["fields"] = {
  title: "Studio delivery", start, end: { kind: "date", value: "20261113" },
  notes: null, place: "Studio", callLink: null, busy: false, private: false,
  repeat: null, invitees: [], alarms: [],
};
const row = {
  id: "delivery", title: "Studio delivery", day: "2026-11-12", place: "Studio",
  alreadyOn: null, fields,
} as FoundRow;

function setup(target = "studio") {
  const press = vi.fn(async (_act: unknown) => ({ key: "calendar-write" }));
  const flush = vi.fn(async () => undefined);
  const dismiss = vi.fn(async (_id: string, _dismissed: boolean) => undefined);
  const port = {
    newId: () => "delivery-event",
    press, flush, verdict: () => ({ kind: "taken" }), setSuggestionDismissed: dismiss,
  };
  const view = mount(createElement(MailFoundEvents, {
    found: { rows: [row], target: { id: target }, port, version: 0 },
  } as never));
  const button = (label: string) => view.el.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
  return { ...view, press, flush, dismiss, button };
}

it("adds the matched date through the calendar write once, even on a double press", async () => {
  const view = setup();
  try {
    const add = view.button(Copy.mailEventAdd);
    expect(add).not.toBeNull();
    await act(async () => { add.click(); add.click(); });
    expect(view.press.mock.calls).toEqual([[{ kind: "calendar_event_create", eventId: "delivery-event", calendarId: "studio", event: fields }]]);
    expect(view.flush).toHaveBeenCalledOnce();
    expect(view.dismiss).not.toHaveBeenCalled();
  } finally { view.unmount(); }
});

it("dismisses the suggestion without creating a calendar event", async () => {
  const view = setup();
  try {
    await act(async () => { view.button(Copy.mailEventDismiss).click(); });
    expect(view.dismiss.mock.calls).toEqual([["delivery", true]]);
    expect(view.press).not.toHaveBeenCalled();
    expect(view.button(Copy.mailEventAdd)).toBeNull();
  } finally { view.unmount(); }
});
