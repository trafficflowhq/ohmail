/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { MonthView } from "../../src/month/index.js";
import { actLog, at, ev, NO_EDGE, rangeInput, Words, WORLD } from "../support/range-world.js";

afterEach(cleanup);

describe("the Month", () => {
  it("draws six weeks from the week of the first, the weekdays in the reader's language", () => {
    const { acts } = actLog();
    const { container } = render(
      <Words lang="de">
        <MonthView input={rangeInput()} acts={acts} edge={NO_EDGE} />
      </Words>,
    );
    expect(container.querySelectorAll(".oh-mo-week")).toHaveLength(6);
    expect([...container.querySelectorAll(".oh-mo-wd-name")].map((n) => n.textContent)).toEqual([
      "Mo",
      "Di",
      "Mi",
      "Do",
      "Fr",
      "Sa",
      "So",
    ]);
    expect(screen.getByRole("button", { name: "Montag, 16. November" }).getAttribute("aria-current")).toBe(
      "date",
    );
  });
  it("a line, named by its time and title, opens its event; so does a run", () => {
    const { acts, said } = actLog();
    render(
      <Words>
        <MonthView input={rangeInput()} acts={acts} edge={NO_EDGE} />
      </Words>,
    );
    fireEvent.click(screen.getByRole("button", { name: "14:30 Poster review" }));
    fireEvent.click(screen.getByRole("button", { name: "Makersfest" }));
    expect(said).toEqual(["event poster", "event fest"]);
  });
  it("a press on a cell picks its day, on the picked one opens it; a date and +N open the Day", () => {
    const { acts, said } = actLog();
    const crowded = [9, 10, 11, 12, 13].map((h) =>
      ev(`e${h}`, `Slot ${h}`, at(2026, 11, 18, h), at(2026, 11, 18, h, 30)),
    );
    const { container } = render(
      <Words>
        <MonthView input={rangeInput({ events: crowded })} acts={acts} edge={NO_EDGE} />
      </Words>,
    );
    const cells = container.querySelectorAll(".oh-mo-week")[3]!.querySelectorAll(".oh-mo-cell");
    fireEvent.click(cells[2]!);
    fireEvent.click(cells[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Friday 20 November" }));
    fireEvent.click(screen.getByRole("button", { name: "2 more on Wednesday 18 November, Day" }));
    expect(said).toEqual([
      "pick 2026-11-18",
      "view day 2026-11-16",
      "view day 2026-11-20",
      "view day 2026-11-18",
    ]);
    expect(screen.getByRole("button", { name: "2 more on Wednesday 18 November, Day" }).textContent).toBe(
      "+2",
    );
  });
  it("the open event is drawn open and stays in sight on a full day", () => {
    const { acts } = actLog();
    const crowded = [9, 10, 11, 12, 13].map((h) =>
      ev(`e${h}`, `Slot ${h}`, at(2026, 11, 18, h), at(2026, 11, 18, h, 30)),
    );
    render(
      <Words>
        <MonthView input={rangeInput({ events: crowded, open: "e13" })} acts={acts} edge={NO_EDGE} />
      </Words>,
    );
    expect(screen.getByRole("button", { name: "13:00 Slot 13" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("button", { name: "12:00 Slot 12" })).toBeNull();
  });
  it("follows what it is handed, keeping nothing of its own", () => {
    const { acts } = actLog();
    const { rerender } = render(
      <Words>
        <MonthView input={rangeInput()} acts={acts} edge={NO_EDGE} />
      </Words>,
    );
    expect(screen.queryByRole("button", { name: "12:00 Lunch" })).toBeNull();
    rerender(
      <Words>
        <MonthView
          input={rangeInput({
            events: [...WORLD, ev("lunch", "Lunch", at(2026, 11, 17, 12), at(2026, 11, 17, 13))],
          })}
          acts={acts}
          edge={NO_EDGE}
        />
      </Words>,
    );
    expect(screen.getByRole("button", { name: "12:00 Lunch" })).toBeTruthy();
    rerender(
      <Words>
        <MonthView
          input={rangeInput({ events: WORLD.filter((e) => e.id !== "poster") })}
          acts={acts}
          edge={NO_EDGE}
        />
      </Words>,
    );
    expect(screen.queryByRole("button", { name: "14:30 Poster review" })).toBeNull();
  });
  it("week numbers where the setting is on: week 53 at the end of 2026", () => {
    const { acts, said } = actLog();
    render(
      <Words>
        <MonthView
          input={rangeInput({ anchor: "2026-12-30", weekNumbers: true })}
          acts={acts}
          edge={NO_EDGE}
        />
      </Words>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Week 53, Week" }));
    expect(said).toEqual(["view week 2026-12-28"]);
  });
  it("on a phone's width: the month small, the picked day's rows below it", () => {
    const { acts, said } = actLog();
    const { container } = render(
      <Words>
        <MonthView input={rangeInput({ device: "phone", anchor: "2026-11-18" })} acts={acts} edge={NO_EDGE} />
      </Words>,
    );
    expect(container.querySelector(".oh-mini")).toBeTruthy();
    const rows = within(container.querySelector(".cal-mo-day") as HTMLElement).getAllByRole("button");
    expect(rows.map((r) => r.textContent)).toEqual([expect.stringContaining("Poster review")]);
    fireEvent.click(screen.getByRole("button", { name: "Friday 20 November" }));
    fireEvent.click(screen.getByRole("button", { name: "Wednesday 18 November" }));
    expect(said).toEqual(["pick 2026-11-20", "view day 2026-11-18"]);
  });
  it("its server markup holds no form that could send a typed value", () => {
    const html = renderToString(
      <Words>
        <MonthView input={rangeInput()} acts={actLog().acts} edge={NO_EDGE} />
      </Words>,
    );
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
  });
});
