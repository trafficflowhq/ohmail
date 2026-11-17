/** @vitest-environment jsdom */
/**
 * ONE ZONE SOURCE FOR EVERY VIEW: the body hands every view the same zone rules, and an event stands on the same day
 * in the Week, the Day, the Month, the Year, the Agenda and Search.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { intlZones, type EventTime, type ZoneSource } from "@ohmail/app-logic/calendar";
import { AgendaView } from "../../src/agenda/index.js";
import { SearchView } from "../../src/calsearch/index.js";
import { DayView } from "../../src/day/index.js";
import { MonthView } from "../../src/month/index.js";
import { WeekView } from "../../src/week/index.js";
import { YearView } from "../../src/year/index.js";
import { actLog, ev, FIRST_REACH, NO_EDGE, rangeInput, Words } from "../support/range-world.js";
import { date, event, mountView, ZURICH } from "../support/time-views.js";

afterEach(cleanup);

/* A zone this source knows and the platform's rules do not. */
const LAB = "Studio/Lab";
const platform = intlZones();
const labZones: ZoneSource = {
  offsetAt: (tzid, ms, left) => (tzid === LAB ? 3_600_000 : platform.offsetAt(tzid, ms, left)),
};
const start: EventTime = {
  kind: "zoned",
  wall: { year: 2026, month: 11, day: 18, hour: 10, minute: 0, second: 0 },
  tzid: LAB,
};
const end: EventTime = {
  kind: "zoned",
  wall: { year: 2026, month: 11, day: 18, hour: 11, minute: 0, second: 0 },
  tzid: LAB,
};
const UNPLACED = "1 event in a time zone this device does not know";

describe("one zone source for every view", () => {
  it("the Month, the Year, the Agenda and Search place an event by the zone source they are handed, as the Week and the Day do", () => {
    const clock = { zone: ZURICH, zones: labZones, nowMs: Date.UTC(2026, 10, 18, 13, 0) };
    for (const View of [WeekView, DayView]) {
      mountView(View, { anchor: date(2026, 11, 18), events: [event("Lab sync", start, end)], clock });
      expect(screen.getByRole("button", { name: /Lab sync/ })).toBeTruthy();
      cleanup();
    }

    const input = rangeInput({
      events: [ev("lab", "Lab sync", start, end)],
      anchor: "2026-11-18",
      zones: labZones,
    });
    const acts = actLog().acts;

    render(
      <Words>
        <MonthView input={input} acts={acts} edge={NO_EDGE} />
      </Words>,
    );
    expect(screen.getAllByText(/Lab sync/).length).toBeGreaterThan(0);
    expect(screen.queryByText(UNPLACED)).toBeNull();
    cleanup();

    const { container } = render(
      <Words>
        <YearView input={input} acts={acts} edge={NO_EDGE} />
      </Words>,
    );
    const nov = container.querySelector("[data-month='2026-11']")!;
    expect(
      [...nov.querySelectorAll(".oh-mini-day[data-busy]")].map((b) => b.getAttribute("aria-label")),
    ).toEqual(["Wednesday 18 November"]);
    expect(screen.queryByText(UNPLACED)).toBeNull();
    cleanup();

    render(
      <Words>
        <AgendaView input={input} acts={acts} edge={NO_EDGE} {...FIRST_REACH} />
      </Words>,
    );
    expect(screen.getAllByText(/Lab sync/).length).toBeGreaterThan(0);
    expect(screen.queryByText(UNPLACED)).toBeNull();
    cleanup();

    render(
      <Words>
        <SearchView input={input} acts={acts} query="lab" onQuery={() => undefined} held={null} />
      </Words>,
    );
    expect(screen.getAllByText(/Lab sync/).length).toBeGreaterThan(0);
    expect(screen.queryByText(UNPLACED)).toBeNull();
  });
});
