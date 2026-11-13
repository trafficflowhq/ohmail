/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { AGENDA_DAYS, AGENDA_MORE, AgendaView } from "../../src/agenda/index.js";
import { actLog, at, ev, FIRST_REACH, NO_EDGE, rangeInput, Words } from "../support/range-world.js";

afterEach(cleanup);

const headings = (c: HTMLElement) => [...c.querySelectorAll("h2")].map((h) => h.textContent);

describe("the Agenda", () => {
  it("days as groups from its first day: today always, days with nothing left out", () => {
    const { container } = render(
      <Words>
        <AgendaView
          input={rangeInput({ events: [] })}
          acts={actLog().acts}
          edge={NO_EDGE}
          from="2026-11-16"
          {...FIRST_REACH}
        />
      </Words>,
    );
    expect(headings(container)).toEqual(["Today"]);
    expect(screen.getByText("Nothing today")).toBeTruthy();
  });
  it("whole days first, then by the hour; a run stands on each of its days", () => {
    const { container } = render(
      <Words>
        <AgendaView
          input={rangeInput()}
          acts={actLog().acts}
          edge={NO_EDGE}
          from="2026-11-16"
          {...FIRST_REACH}
        />
      </Words>,
    );
    expect(headings(container).slice(0, 6)).toEqual([
      "Today1",
      "Wed 18 Nov1",
      "Fri 20 Nov2",
      "Sat 21 Nov1",
      "Sun 22 Nov1",
      "Sun 29 Nov1",
    ]);
    const fri = screen.getByRole("region", { name: "Friday 20 November" });
    expect([...fri.querySelectorAll(".oh-erow-title")].map((n) => n.textContent)).toEqual([
      "Makersfest",
      "Tech check, main hall",
    ]);
    expect([...fri.querySelectorAll(".oh-erow-time")].map((n) => n.textContent)).toEqual([
      "all day",
      "16:00–16:15",
    ]);
  });
  it("what is on now says until when, in the hot ink", () => {
    const { container } = render(
      <Words>
        <AgendaView
          input={rangeInput()}
          acts={actLog().acts}
          edge={NO_EDGE}
          from="2026-11-16"
          {...FIRST_REACH}
        />
      </Words>,
    );
    const now = container.querySelector(".oh-erow[data-now]")!;
    expect(now.querySelector(".oh-erow-time")!.textContent).toBe("until 09:45");
  });
  it("a row opens its event; the open one closes it", () => {
    const { acts, said } = actLog();
    render(
      <Words>
        <AgendaView
          input={rangeInput({ open: "tech" })}
          acts={acts}
          edge={NO_EDGE}
          from="2026-11-16"
          {...FIRST_REACH}
        />
      </Words>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Poster review/ }));
    fireEvent.click(screen.getByRole("button", { name: /Tech check, main hall/ }));
    expect(said).toEqual(["event poster", "event none"]);
  });
  it("asks for later days at its foot as it is scrolled, and lists the days it is handed", () => {
    const far = ev("far", "Far away", at(2027, 2, 1, 9), at(2027, 2, 1, 10));
    let asked = 0;
    const view = (days: number) => (
      <Words>
        <AgendaView
          input={rangeInput({ events: [far] })}
          acts={actLog().acts}
          edge={NO_EDGE}
          from="2026-11-16"
          days={days}
          onMore={() => asked++}
        />
      </Words>
    );
    const { container, rerender } = render(view(AGENDA_DAYS));
    expect(screen.queryByText("Far away")).toBeNull();
    const list = container.querySelector("[data-scroll='calagenda']") as HTMLElement;
    Object.defineProperty(list, "scrollHeight", { value: 1000 });
    Object.defineProperty(list, "clientHeight", { value: 800 });
    fireEvent.scroll(list, { target: { scrollTop: 0 } });
    expect(asked).toBe(1);
    rerender(view(AGENDA_DAYS + AGENDA_MORE));
    expect(screen.getByText("Far away")).toBeTruthy();
  });
  it("on a phone: the month over the list; a day pressed is picked", () => {
    const { acts, said } = actLog();
    const { container } = render(
      <Words lang="de">
        <AgendaView input={rangeInput({ device: "phone" })} acts={acts} edge={NO_EDGE} {...FIRST_REACH} />
      </Words>,
    );
    expect(container.querySelector(".cal-ag-month .oh-mini")).toBeTruthy();
    expect(headings(container)[0]).toBe("Heute1");
    fireEvent.click(screen.getByRole("button", { name: "Freitag, 20. November" }));
    expect(said).toEqual(["pick 2026-11-20"]);
  });
  it("its server markup holds no form", () => {
    expect(
      renderToString(
        <Words>
          <AgendaView input={rangeInput()} acts={actLog().acts} edge={NO_EDGE} {...FIRST_REACH} />
        </Words>,
      ),
    ).not.toContain("<form");
  });
});
