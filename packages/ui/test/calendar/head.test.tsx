/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CalendarHead } from "@ohmail/ui/calendar";

afterEach(cleanup);

const ways = {
  before: { label: "Before" },
  after: { label: "After" },
  today: { label: "Today" },
  search: { label: "Search" },
  more: { label: "More" },
};

describe("the calendar's head", () => {
  it("is a banner whose heading names the span, and the span is the way to a date", () => {
    const onPress = vi.fn();
    render(
      <CalendarHead
        title="9 – 15 November"
        shortTitle="9 – 15 Nov"
        hot
        goTo={{ label: "9 – 15 November, Go to a date", onPress }}
        {...ways}
      />,
    );
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toContain("9 – 15 November");
    fireEvent.click(screen.getByRole("button", { name: "9 – 15 November, Go to a date" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("draws one full stop after a date even when the month is abbreviated", () => {
    render(<CalendarHead title="1. – 7. Dez." hot todayNumber="7" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("1. – 7. Dez");
  });

  it("carries the two arrows, Today, Search and More, each a named button that reaches the app", () => {
    const calls: string[] = [];
    const press = (name: string) => () => calls.push(name);
    render(
      <CalendarHead
        title="9 – 15 November"
        hot
        before={{ label: "Before", onPress: press("before") }}
        after={{ label: "After", onPress: press("after") }}
        today={{ label: "Today", onPress: press("today") }}
        search={{ label: "Search", onPress: press("search") }}
        more={{ label: "More", onPress: press("more") }}
      />,
    );
    for (const name of ["Before", "After", "Today", "Search", "More"])
      fireEvent.click(screen.getByRole("button", { name }));
    expect(calls).toEqual(["before", "after", "today", "search", "more"]);
  });

  it("has no arrows and no Today in a place that is no span of days", () => {
    render(<CalendarHead title="Invitations" hot more={{ label: "More" }} />);
    expect(screen.queryByRole("button", { name: "Before" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Today" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Invitations");
  });

  it("says whether the Agenda's panel stands, on its own control", () => {
    const onPress = vi.fn();
    const { rerender } = render(
      <CalendarHead title="November" hot agenda={{ label: "Agenda", on: false, onPress }} />,
    );
    const agenda = screen.getByRole("button", { name: "Agenda" });
    expect(agenda.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(agenda);
    expect(onPress).toHaveBeenCalledTimes(1);
    rerender(<CalendarHead title="November" hot agenda={{ label: "Agenda", on: true, onPress }} />);
    expect(agenda.getAttribute("aria-pressed")).toBe("true");
  });

  it("carries the week's number: the way to its week, or where you are", () => {
    const onPress = vi.fn();
    const { rerender } = render(
      <CalendarHead
        title="Tuesday 17 November"
        hot={false}
        week={{ word: "Week", short: "W", number: 47, label: "Week 47", onPress }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Week 47" }));
    expect(onPress).toHaveBeenCalledTimes(1);
    rerender(
      <CalendarHead
        title="16 – 22 November"
        hot={false}
        week={{ word: "Week", short: "W", number: 47, label: "Week 47" }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Week 47" })).toBeNull();
    expect(screen.getByLabelText("Week 47")).toBeTruthy();
  });

  it("puts off what cannot be done here", () => {
    render(<CalendarHead title="November" hot search={{ label: "Search", disabled: true }} />);
    expect((screen.getByRole("button", { name: "Search" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
