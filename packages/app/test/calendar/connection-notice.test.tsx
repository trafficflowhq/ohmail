/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
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
  it("keeps a writable CalDAV calendar available while explaining that its connection failed", async () => {
    const w = mirror();
    w.put(
      "calendar_connection",
      "conn-1",
      connectionRecord({
        status: "failing",
        serverHost: "caldav.icloud.com",
        errorCode: null,
        updatedAt: stamp(-1),
      }),
    );
    w.put("calendar", "cal-1", calendarRecord({ access: "writer" }));
    mountFrame(
      "#/cal/week",
      w,
      setupPort(async () => []),
      { words: settingsEn },
    );
    await act(async () => undefined);
    const action = screen.getByRole("button", { name: "Open Calendars" });
    expect(action.closest('[role="status"]')?.textContent).toContain(
      "Studio account: Calendars can’t connect",
    );
    expect(screen.queryByRole("img", { name: "View only" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New event" }));
    expect(
      within(await screen.findByRole("dialog", { name: "New event" })).getByRole("textbox", {
        name: "New event",
      }),
    ).toBeTruthy();
  });

  it.each(["google", "microsoft"] as const)(
    "retains the notice delay for a failing %s connection",
    async (provider) => {
      const w = mirror();
      const put = (errorCode: "timeout" | null, updatedAt: string) =>
        w.put(
          "calendar_connection",
          "conn-1",
          connectionRecord({ provider, status: "failing", errorCode, updatedAt }),
        );
      put(null, stamp(-31));
      w.put("calendar", "cal-1", calendarRecord({ access: "writer" }));
      mountFrame(
        "#/cal/week",
        w,
        setupPort(async () => []),
        { words: settingsEn },
      );
      await act(async () => undefined);
      expect(screen.queryByRole("button", { name: "Open Calendars" })).toBeNull();
      act(() => put("timeout", stamp(-1)));
      expect(screen.queryByRole("button", { name: "Open Calendars" })).toBeNull();
      act(() => put("timeout", stamp(-31)));
      expect(
        screen.getByRole("button", { name: "Open Calendars" }).closest('[role="status"]')?.textContent,
      ).toContain("Studio account: Calendars can’t connect");
    },
  );

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
