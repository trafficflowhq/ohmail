/** @vitest-environment jsdom */
import { createElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { Copy } from "../src/copy";
import { scheduleLabel } from "../src/state/live";
import { mount } from "./_rendered-dom";

vi.mock("react-native", async () => (await import("./_rendered-dom")).rnDom);
vi.mock("../src/theme", () => ({ useTheme: () => ({ mail: true }) }));
vi.mock("../src/theme/mail", () => ({}));
vi.mock("../src/ui/MailAvatar", () => ({ MailAvatar: () => null }));
vi.mock("../src/state/pull", () => ({}));
vi.mock("../src/state/world", () => ({ useWorld: () => ({}) }));
vi.mock("../src/ui/chrome", () => ({}));
vi.mock("../src/ui/more-move", () => ({}));
vi.mock("../src/ui/Gated", () => ({}));
vi.mock("../src/ui/Skeleton", () => ({}));
vi.mock("../src/ui/ErrorBoundary", () => ({}));
vi.mock("../src/i18n/LocaleProvider", () => ({ useLocale: () => "en" }));
vi.mock("../src/ui/base", () => ({
  Button: () => null,
  Txt: ({ children }: { children: ReactNode }) => createElement("span", null, children),
}));

const { ScheduledRow } = await import("../app/scheduled");

it("shows the scheduled send in the reader's zone when the device is elsewhere", () => {
  const sendAt = "2026-09-02T09:00:00.000Z";
  const now = new Date("2026-09-02T06:00:00.000Z");
  const deviceHour = new Date(sendAt).getHours();
  const readerZone = deviceHour === 18 ? "America/Los_Angeles" : "Asia/Tokyo";
  const readerTime = deviceHour === 18 ? "02:00" : "18:00";
  const when = scheduleLabel(sendAt, now, readerZone);
  expect(when).toContain(readerTime);

  const view = mount(createElement(ScheduledRow, {
    row: { id: "scheduled", subject: "Meeting", to: "Ada", preview: "", failure: null, cancellable: true, sendAt, when },
  }));
  try {
    expect(view.el.textContent).toContain(Copy.scheduledWhen(when));
  } finally {
    view.unmount();
  }
});
