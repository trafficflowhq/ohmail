/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import settingsEn from "../../messages/settings.en.json" with { type: "json" };
import { calendarRecord, connectionRecord, mirror, mountFrame, setupPort } from "../calsetup/world.js";

const NOW = Date.parse("2026-11-24T12:00:00Z");
const MINUTE = 60_000;
const stamp = (offset: number) => new Date(NOW + offset * MINUTE).toISOString();

beforeEach(() => {
  Element.prototype.animate ??= () => ({ cancel() {} }) as unknown as Animation;
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function openCalendar(nextPollAt: string, lastSyncedAt = stamp(-23 * 60)) {
  const w = mirror();
  w.put("calendar_connection", "other", connectionRecord({ id: "other", label: "Other account" }));
  w.put("calendar_connection", "conn-1", { ...connectionRecord({ lastSyncedAt }), nextPollAt });
  w.put("calendar", "cal-1", calendarRecord());
  return {
    w,
    ...mountFrame(
      "#/cal/week",
      w,
      setupPort(async () => []),
      { words: settingsEn },
    ),
  };
}

describe("calendar connection notices", () => {
  it.each([
    ["23 hours after a successful check on a 24-hour schedule", stamp(60), stamp(-23 * 60)],
    ["at exactly 30 minutes overdue", stamp(-30), stamp(-60)],
    ["when a successful check followed the scheduled time", stamp(-31), stamp(-10)],
  ])("stays quiet %s", async (_label, due, checked) => {
    openCalendar(due, checked);
    await act(async () => undefined);
    expect(screen.queryByRole("button", { name: "Open Calendars" })).toBeNull();
  });

  it("names the account and opens its check details when the next check is 31 minutes overdue", async () => {
    const { address } = openCalendar(stamp(-31));
    await act(async () => undefined);
    const action = screen.getByRole("button", { name: "Open Calendars" });
    expect(action.closest('[role="status"]')?.textContent).toContain(
      "Studio account: Calendar check overdue",
    );
    expect(screen.getByRole("button", { name: "Hide" })).toBeTruthy();
    fireEvent.click(action);
    await act(async () => undefined);
    expect(address.read()).toContain("account=conn-1");
    expect(screen.getByText("The scheduled calendar check is overdue")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Studio account.*Overdue/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Calendar accounts" }).textContent).toContain("Overdue");
  });
});
