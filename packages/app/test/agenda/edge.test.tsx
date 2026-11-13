/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgendaView } from "../../src/agenda/index.js";
import { MonthView } from "../../src/month/index.js";
import { YearView } from "../../src/year/index.js";
import { actLog, FIRST_REACH, NO_EDGE, rangeInput, Words } from "../support/range-world.js";

afterEach(cleanup);

describe("the window's edge", () => {
  it("offers Load earlier where the list reaches before what the device holds, and a press reads the span", async () => {
    const load = vi.fn(async () => true);
    const { acts } = actLog();
    render(
      <Words>
        <AgendaView
          input={rangeInput({ anchor: "2026-05-04" })}
          acts={acts}
          edge={{ earlier: "2026-05-10", later: null, load }}
          {...FIRST_REACH}
        />
      </Words>,
    );
    expect(screen.getByRole("status").textContent).toContain("Shown from Sun 10 May");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    });
    expect(load).toHaveBeenCalledWith({ from: "2026-04-12", to: "2026-05-09" });
  });
  it("is read from the held window, never from today: a list inside what is held offers nothing", () => {
    const { acts } = actLog();
    render(
      <Words>
        <AgendaView
          input={rangeInput({ anchor: "2026-11-16", today: "2026-05-01" })}
          acts={acts}
          edge={{ earlier: "2026-05-10", later: null, load: async () => true }}
          {...FIRST_REACH}
        />
      </Words>,
    );
    expect(screen.queryByRole("button", { name: "Load earlier" })).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("where the host cannot read a span, says so with no press", () => {
    const { acts } = actLog();
    render(
      <Words>
        <AgendaView
          input={rangeInput({ anchor: "2026-05-04" })}
          acts={acts}
          edge={{ earlier: "2026-05-10", later: null, load: "none" }}
          {...FIRST_REACH}
        />
      </Words>,
    );
    expect(screen.getByText("Earlier days stay with the calendar.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load earlier" })).toBeNull();
  });
  it("says when the read failed, and keeps the press", async () => {
    const { acts } = actLog();
    render(
      <Words>
        <AgendaView
          input={rangeInput({ anchor: "2026-05-04" })}
          acts={acts}
          edge={{ earlier: "2026-05-10", later: null, load: async () => false }}
          {...FIRST_REACH}
        />
      </Words>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));
    });
    expect(screen.getByText("Earlier days could not be read.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Load earlier" })).toBeTruthy();
  });
  it("the Month offers it too, where its first week lies before the edge; in German", () => {
    const { acts } = actLog();
    render(
      <Words lang="de">
        <MonthView
          input={rangeInput({ anchor: "2026-05-04" })}
          acts={acts}
          edge={{ earlier: "2026-05-10", later: null, load: async () => true }}
          {...FIRST_REACH}
        />
      </Words>,
    );
    expect(screen.getByRole("button", { name: "Früher laden" })).toBeTruthy();
  });
  it("with nothing before the held window, says nothing", () => {
    const { acts } = actLog();
    render(
      <Words>
        <MonthView input={rangeInput({ anchor: "2026-05-04" })} acts={acts} edge={NO_EDGE} />
      </Words>,
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("the Month, the Year and the Agenda say where their days reach after what this device holds", () => {
    const { acts } = actLog();
    const later = { earlier: null, later: "2026-11-20", load: "none" } as const;
    render(
      <Words>
        <MonthView input={rangeInput()} acts={acts} edge={later} />
        <YearView input={rangeInput()} acts={acts} edge={later} />
        <AgendaView input={rangeInput()} acts={acts} edge={later} {...FIRST_REACH} />
      </Words>,
    );
    expect(screen.getAllByText("Later days stay with the calendar.")).toHaveLength(3);
  });
  it("the Year offers Load earlier where its first day lies before the edge", () => {
    const { acts } = actLog();
    render(
      <Words>
        <YearView
          input={rangeInput()}
          acts={acts}
          edge={{ earlier: "2026-05-10", later: null, load: async () => true }}
          {...FIRST_REACH}
        />
      </Words>,
    );
    expect(screen.getByRole("button", { name: "Load earlier" })).toBeTruthy();
  });
});
