/** @vitest-environment jsdom */
/**
 * THE DAY, mounted alone over invented events: no day head (the calendar's head says the day), the free stretch
 * between two events, what lies out of sight above and below with its time and title, and a press on it bringing
 * the event into view.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgendaView } from "../../src/agenda/index.js";
import { actLog, FIRST_REACH, rangeInput, Words } from "../support/range-world.js";
import { DayView } from "../../src/day/index.js";
import { at, date, event, mountView } from "../support/time-views.js";

afterEach(cleanup);

const DAY = date(2026, 11, 12);
const events = [
  event("Kiln check", at(2026, 11, 12, 6), at(2026, 11, 12, 6, 30)),
  event("Glaze review", at(2026, 11, 12, 10), at(2026, 11, 12, 12)),
  event("Supplier call", at(2026, 11, 12, 11), at(2026, 11, 12, 12)),
  event("Dinner", at(2026, 11, 12, 19), at(2026, 11, 12, 21), {
    ref: { event: "ev-dinner", occurrence: "20261112T190000", day: "2026-11-12" },
  }),
];

/** The hours' scroller, shown `height` px tall and scrolled to `top`. */
function scrollHours(container: HTMLElement, top: number, height: number): HTMLElement {
  const el = container.querySelector<HTMLElement>(".oh-tg-scroll")!;
  Object.defineProperty(el, "clientHeight", { configurable: true, value: height });
  el.scrollTop = top;
  fireEvent.scroll(el);
  return el;
}

describe("the day", () => {
  it("has no day head and draws each event at its hours; two that overlap lap", () => {
    const { container } = mountView(DayView, { anchor: DAY, events });
    expect(container.querySelector(".oh-tg-heads")).toBeNull();
    const review = screen.getByRole("button", { name: "Glaze review, 10:00 to 12:00" });
    const call = screen.getByRole("button", { name: "Supplier call, 11:00 to 12:00" });
    expect([review.style.top, call.style.top]).toEqual(["600px", "660px"]);
    expect(call.hasAttribute("data-lap")).toBe(true);
  });

  it("prints the free stretch of an hour or more between two events", () => {
    mountView(DayView, { anchor: DAY, events });
    expect(screen.getByText("3 h 30 min")).toBeTruthy();
    expect(screen.getByText("7 h")).toBeTruthy();
  });

  it("says in German how long a free stretch is", () => {
    mountView(DayView, { anchor: DAY, events }, "de");
    expect(screen.getByText("3 Std. 30 Min.")).toBeTruthy();
  });

  it("what lies above the hours in view says its time and title, and a press brings it into view", () => {
    const { container } = mountView(DayView, { anchor: DAY, events });
    // 60 px an hour; the view shows 10:00 to 15:00.
    const el = scrollHours(container, 600, 300);
    const above = screen.getByRole("button", { name: "An event above the hours in view: show it" });
    expect(above.textContent).toContain("06:00 Kiln check");
    const below = screen.getByRole("button", { name: "An event below the hours in view: show it" });
    expect(below.textContent).toContain("19:00 Dinner");
    act(() => {
      fireEvent.click(above);
    });
    expect(el.scrollTop).toBe(360 - 30);
  });

  it("opens on the hours in view, and on an open event that lies outside them", () => {
    const first = mountView(DayView, { anchor: DAY, events });
    expect(first.container.querySelector<HTMLElement>(".oh-tg-scroll")!.scrollTop).toBe(7 * 60);
    cleanup();
    const second = mountView(DayView, { anchor: DAY, events, openId: "Dinner" });
    // jsdom lays nothing out: the view is 0 px tall, so 19:00 lies outside the hours from 07:00; it stands an hour below the top.
    expect(second.container.querySelector<HTMLElement>(".oh-tg-scroll")!.scrollTop).toBe(18 * 60);
  });

  it("a press on one day of a series opens that day through the named command", () => {
    const m = mountView(DayView, { anchor: DAY, events });
    fireEvent.click(screen.getByRole("button", { name: /Dinner/ }));
    expect(m.opened).toEqual([{ event: "ev-dinner", occurrence: "20261112T190000", day: "2026-11-12" }]);
  });

  it("says where it lies before what this device holds, and Load earlier reads from four weeks back", async () => {
    const asked: { from: string; to: string }[] = [];
    const { acts } = actLog();
    render(
      <Words>
        <AgendaView
          input={rangeInput({ anchor: "2026-11-12" })}
          acts={acts}
          edge={{
            provider: "microsoft",
            earlier: "2026-11-20",
            later: null,
            load: async (span) => {
              asked.push(span);
              return true;
            },
          }}
          {...FIRST_REACH}
        />
      </Words>,
    );
    expect(screen.getByRole("status").textContent).toContain("From Fri 20 Nov");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    });
    expect(asked).toEqual([{ from: "2026-10-23", to: "2026-11-19" }]);
  });

  it("leaves the canvas clear outside and inside the held days", () => {
    const after = mountView(DayView, {
      anchor: DAY,
      edge: { earlier: null, later: "2026-11-11", load: "none" },
    });
    expect(screen.queryByRole("status")).toBeNull();
    after.rerender({ edge: { earlier: "2026-11-01", later: "2026-11-30", load: "none" } });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
