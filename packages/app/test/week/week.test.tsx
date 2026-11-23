/** @vitest-environment jsdom */
/**
 * THE WEEK, mounted alone over invented events: each event on its day at the minutes the reader's clock shows, the
 * whole days in the lane, now on today, a press opening the event through the named command, and nothing kept: the
 * week draws what it is handed on every render.
 */
import { cleanup, fireEvent, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { WeekView } from "../../src/week/index.js";
import { TextProvider } from "../../src/text/index.js";
import {
  at,
  date,
  event,
  mountView,
  PLANS,
  SETTINGS,
  TIME_WORDS,
  ZURICH,
  zones,
} from "../support/time-views.js";

afterEach(cleanup);

const block = (name: RegExp): HTMLElement => screen.getByRole("button", { name });
const style = (el: HTMLElement) => ({ top: el.style.top, height: el.style.height });

describe("the week", () => {
  it("draws the seven days of the anchor's week, Monday first, with today marked", () => {
    mountView(WeekView, { anchor: date(2026, 11, 18) });
    const heads = screen.getAllByRole("button", { name: /November \d+, 2026$/ });
    expect(heads.map((h) => h.getAttribute("aria-label"))).toEqual([
      "Monday, November 16, 2026",
      "Tuesday, November 17, 2026",
      "Wednesday, November 18, 2026",
      "Thursday, November 19, 2026",
      "Friday, November 20, 2026",
      "Saturday, November 21, 2026",
      "Sunday, November 22, 2026",
    ]);
    expect(heads.map((h) => h.getAttribute("aria-current"))).toEqual([
      null,
      null,
      "date",
      null,
      null,
      null,
      null,
    ]);
  });

  it("leaves Saturday and Sunday out of the week grid when weekends are hidden", () => {
    mountView(WeekView, {
      anchor: date(2026, 11, 18),
      settings: { ...SETTINGS, weekStart: 5, weekends: false },
    });
    expect(
      screen
        .getAllByRole("button", { name: /November \d+, 2026$/ })
        .map((head) => head.getAttribute("aria-label")),
    ).toEqual([
      "Monday, November 16, 2026",
      "Tuesday, November 17, 2026",
      "Wednesday, November 18, 2026",
      "Thursday, November 19, 2026",
      "Friday, November 20, 2026",
    ]);
  });

  it("an event across the change of hour sits on its wall-clock hours on the 25-hour day", () => {
    mountView(WeekView, {
      anchor: date(2026, 10, 25),
      events: [event("Night shift", at(2026, 10, 25, 1), at(2026, 10, 25, 4))],
    });
    // 60 px an hour: 01:00 stands at 60 px and the block reaches 04:00 (the kit leaves 2 px to the next).
    expect(style(block(/Night shift, 01:00 to 04:00/))).toEqual({ top: "60px", height: "178px" });
  });

  it("and on the 23-hour day", () => {
    mountView(WeekView, {
      anchor: date(2026, 3, 29),
      events: [event("Early train", at(2026, 3, 29, 1), at(2026, 3, 29, 4))],
    });
    expect(style(block(/Early train, 01:00 to 04:00/))).toEqual({ top: "60px", height: "178px" });
  });

  it("a press on an event opens it through the named command, with its reference", () => {
    const m = mountView(WeekView, {
      anchor: date(2026, 11, 18),
      events: [
        event("Poster review", at(2026, 11, 18, 14), at(2026, 11, 18, 15), {
          ref: { event: "ev-poster", occurrence: null, day: "2026-11-18" },
        }),
      ],
    });
    fireEvent.click(block(/Poster review/));
    expect(m.opened).toEqual([{ event: "ev-poster", occurrence: null, day: "2026-11-18" }]);
  });

  it("a press on a day's head goes to that day", () => {
    const m = mountView(WeekView, { anchor: date(2026, 11, 18) });
    fireEvent.click(screen.getByRole("button", { name: "Friday, November 20, 2026" }));
    expect(m.days).toEqual([date(2026, 11, 20)]);
  });

  it("a run of whole days stands in the lane across its days, its last day the one before its end", () => {
    mountView(WeekView, {
      anchor: date(2026, 11, 18),
      events: [event("Makersfest", date(2026, 11, 19), date(2026, 11, 22))],
    });
    const pill = block(/Makersfest, all day/);
    expect(pill.style.gridColumn).toBe("5 / 8");
    expect(screen.queryByText("all day")).toBeNull();
    expect(screen.getByRole("group", { name: "all day" }).contains(pill)).toBe(true);
  });

  it("the open event is drawn open, and an event of a view-only calendar has no handles", () => {
    mountView(WeekView, {
      anchor: date(2026, 11, 18),
      openId: "Layout review",
      events: [event("Layout review", at(2026, 11, 18, 10), at(2026, 11, 18, 11), { viewOnly: true })],
    });
    const chip = block(/Layout review/);
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(chip.querySelector(".oh-ev-hd")).toBeNull();
  });

  it("now stands on today, written as the hours write it", () => {
    const { container } = mountView(WeekView, { anchor: date(2026, 11, 18) });
    // 13:00 UTC is 14:00 in Zurich.
    expect(container.querySelector("[data-now]")?.textContent).toBe("14:00");
    expect(container.querySelector(".oh-now")).not.toBeNull();
  });

  it("follows what it is handed: an event that leaves the list leaves the week", () => {
    const m = mountView(WeekView, {
      anchor: date(2026, 11, 18),
      events: [event("Dentist", at(2026, 11, 19, 9), at(2026, 11, 19, 10))],
    });
    expect(screen.queryByRole("button", { name: /Dentist/ })).not.toBeNull();
    m.rerender({ events: [event("Lunch", at(2026, 11, 19, 12), at(2026, 11, 19, 13))] });
    expect(screen.queryByRole("button", { name: /Dentist/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Lunch/ })).not.toBeNull();
  });

  it("says what it cannot place, and that the expansion stopped, never drawing either as whole", () => {
    mountView(WeekView, {
      anchor: date(2026, 11, 18),
      capped: true,
      events: [
        event(
          "Atlantis call",
          {
            kind: "zoned",
            wall: { year: 2026, month: 11, day: 18, hour: 9, minute: 0, second: 0 },
            tzid: "Nowhere/Atlantis",
          },
          at(2026, 11, 18, 10),
        ),
      ],
    });
    expect(screen.getByText("1 event is not shown: its time zone is not known on this device.")).toBeTruthy();
    expect(screen.getByText(/more than can be worked out at once/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Atlantis call/ })).toBeNull();
  });

  it("on a phone's narrow width the week is the picked day's hours, with no day head of its own", () => {
    const { container } = mountView(WeekView, {
      anchor: date(2026, 11, 19),
      plan: PLANS.phone,
      events: [
        event("Wed", at(2026, 11, 18, 9), at(2026, 11, 18, 10)),
        event("Thu", at(2026, 11, 19, 9), at(2026, 11, 19, 10)),
      ],
    });
    expect(container.querySelector(".oh-tg-heads")).toBeNull();
    expect(container.querySelector(".oh-tg-in")?.getAttribute("aria-label")).toBe(
      "Thursday, November 19, 2026",
    );
    expect(screen.queryByRole("button", { name: /^Wed,/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Thu,/ })).not.toBeNull();
  });

  it("on the unfolded phone the hinge falls in the gap after the third day", () => {
    const { container } = mountView(WeekView, { anchor: date(2026, 11, 18), plan: PLANS.fold });
    expect(container.querySelector(".oh-tg")?.getAttribute("data-crease")).toBe("3");
  });

  it("speaks German where the reader does", () => {
    mountView(
      WeekView,
      {
        anchor: date(2026, 11, 18),
        events: [
          event("Messe", date(2026, 11, 19), date(2026, 11, 20)),
          event("Zahnarzt", at(2026, 11, 19, 9), at(2026, 11, 19, 10)),
        ],
      },
      "de",
    );
    expect(screen.queryByText("ganztags")).toBeNull();
    expect(screen.getByRole("group", { name: "ganztags" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Zahnarzt, 09:00 bis 10:00" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Donnerstag, 19. November 2026" })).toBeTruthy();
  });

  it("before its script runs, the server's markup holds no form that can send a typed value", () => {
    const html = renderToString(
      <TextProvider locale="en" messages={TIME_WORDS.en} timeZone={ZURICH}>
        <WeekView
          anchor={date(2026, 11, 18)}
          events={[event("Poster review", at(2026, 11, 18, 14), at(2026, 11, 18, 15))]}
          capped={false}
          edge={{ earlier: null, later: null, load: "none" }}
          openId={null}
          clock={{ zone: ZURICH, zones, nowMs: Date.UTC(2026, 10, 18, 13) }}
          settings={SETTINGS}
          plan={PLANS.desktop}
          panel={false}
          onOpen={() => {}}
          onDay={() => {}}
        />
      </TextProvider>,
    );
    expect(html).toContain("Poster review");
    expect(html).not.toMatch(/<form|<input|<textarea|<select/);
    expect(html.match(/<button[^>]*>/g)!.every((b) => b.includes('type="button"'))).toBe(true);
  });

  it("leaves held-window notices to Month and Agenda", () => {
    const m = mountView(WeekView, {
      anchor: date(2026, 11, 18),
      edge: { earlier: "2026-11-18", later: "2026-11-20", load: "none" },
    });
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Load earlier" })).toBeNull();
    m.rerender({ edge: { earlier: "2026-11-16", later: "2026-11-22", load: "none" } });
    expect(screen.queryByRole("status")).toBeNull();
  });
});
