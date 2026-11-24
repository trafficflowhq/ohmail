/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { YearView } from "../../src/year/index.js";
import { actLog, NO_EDGE, rangeInput, Words } from "../support/range-world.js";

afterEach(cleanup);

describe("the Year", () => {
  it("twelve months; today's month carries the hot dot", () => {
    const { container } = render(
      <Words>
        <YearView input={rangeInput()} acts={actLog().acts} edge={NO_EDGE} />
      </Words>,
    );
    const months = container.querySelectorAll(".cal-yr-month");
    expect(months).toHaveLength(12);
    expect(
      screen
        .getByRole("button", { name: "November 2026, Month" })
        .querySelector("[data-kind='hot'], .oh-dot[data-hot], [class*='hot']"),
    ).toBeTruthy();
  });
  it("a day with something is bold; a day of another month is not marked", () => {
    const { container } = render(
      <Words>
        <YearView input={rangeInput()} acts={actLog().acts} edge={NO_EDGE} />
      </Words>,
    );
    const nov = container.querySelector("[data-month='2026-11']")!;
    const busy = [...nov.querySelectorAll(".oh-mini-day[data-busy]")].map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(busy).toEqual([
      "Monday 16 November",
      "Wednesday 18 November",
      "Friday 20 November",
      "Saturday 21 November",
      "Sunday 22 November",
      "Sunday 29 November",
    ]);
    const oct = container.querySelector("[data-month='2026-10']")!;
    expect(oct.querySelectorAll(".oh-mini-day[data-busy]")).toHaveLength(1);
  });
  it("a run of days is marked on its days", () => {
    const { container } = render(
      <Words>
        <YearView input={rangeInput()} acts={actLog().acts} edge={NO_EDGE} />
      </Words>,
    );
    const nov = container.querySelector("[data-month='2026-11']")!;
    expect(
      [...nov.querySelectorAll(".oh-mini-day[data-band]")].map((b) => b.getAttribute("data-band")),
    ).toEqual(["start", "in", "end"]);
  });
  it("a day opens its Day, a month's name its Month, a week's number its Week", () => {
    const { acts, said } = actLog();
    render(
      <Words lang="de">
        <YearView input={rangeInput({ weekNumbers: true })} acts={acts} edge={NO_EDGE} />
      </Words>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Freitag, 20. November" }));
    fireEvent.click(screen.getByRole("button", { name: "März 2026, Monat" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Woche 1, Woche" })[0]!);
    expect(said).toEqual(["view day 2026-11-20", "view month 2026-03-01", "view week 2025-12-29"]);
  });
  it("the year of the picked day, not today's", () => {
    render(
      <Words>
        <YearView input={rangeInput({ anchor: "2027-01-01" })} acts={actLog().acts} edge={NO_EDGE} />
      </Words>,
    );
    expect(screen.getByRole("button", { name: "January 2027, Month" })).toBeTruthy();
  });
  it("its server markup holds no form", () => {
    expect(
      renderToString(
        <Words>
          <YearView input={rangeInput()} acts={actLog().acts} edge={NO_EDGE} />
        </Words>,
      ),
    ).not.toContain("<form");
  });
});
