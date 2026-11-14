/** @vitest-environment jsdom */
/*
 * A month to find a day in, by the keys: one stop of Tab on the day that holds the keys, the arrows a
 * day and a week, Home and End the week's ends, PageUp and PageDown a month, over the days that can be
 * pressed only; Enter and Space press the day under the keys. A picker in a menu puts the keys on that
 * day as it opens. The switch's point 65: the day picker of Resurface took no arrow keys.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MiniMonth, type MiniMonthDay, type MiniMonthHead } from "@ohmail/ui/calendar";

afterEach(cleanup);

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

/** A month of 30 days whose first falls on a Wednesday; the days before `floor` cannot be pressed. */
function month(
  name: string,
  opts: { floor?: number; offWord?: "disabled" | "outside" } = {},
): MiniMonthDay[] {
  return Array.from({ length: 42 }, (_, i) => {
    const n = i - 1;
    const inMonth = n >= 1 && n <= 30;
    /* Before the floor: the month's early days and the days of the month before it. */
    const early = opts.floor !== undefined && (n < 1 || (inMonth && n < opts.floor));
    return {
      id: inMonth ? `${name}-${n}` : `${name}-x${i}`,
      number: String(inMonth ? n : i),
      label: inMonth ? `${name} ${n}` : `${name} beside ${i}`,
      outside: !inMonth || (early && opts.offWord === "outside"),
      disabled: early && opts.offWord !== "outside" ? true : undefined,
    };
  });
}

const keys = () => document.activeElement?.getAttribute("aria-label");
/** The days Tab stops on: the grid's buttons that are a stop. */
const stopping = () =>
  within(screen.getByRole("grid"))
    .getAllByRole("button")
    .filter((b) => b.tabIndex === 0);
const stops = () => stopping().map((b) => b.getAttribute("aria-label"));
/** Tab reaches the month: the keys go to its one stop. */
const tabIn = () => act(() => stopping()[0]!.focus());
/** Keys pressed where the keys are. */
const press = (...names: string[]) =>
  names.forEach((key) => fireEvent.keyDown(document.activeElement!, { key }));

describe("a month to find a day in, by the keys", () => {
  it("is one stop of Tab: on the picked day, else today, else the first day of the month that can be pressed", () => {
    const days = month("Nov").map((d) => (d.id === "Nov-10" ? { ...d, today: true } : d));
    const { rerender } = render(<MiniMonth weekdays={WEEKDAYS} days={days} onDayPress={() => {}} />);
    expect(stops()).toEqual(["Nov 10"]);
    rerender(
      <MiniMonth
        weekdays={WEEKDAYS}
        days={days.map((d) => (d.id === "Nov-17" ? { ...d, picked: true } : d))}
        onDayPress={() => {}}
      />,
    );
    expect(stops()).toEqual(["Nov 17"]);
    rerender(<MiniMonth weekdays={WEEKDAYS} days={month("Nov", { floor: 12 })} onDayPress={() => {}} />);
    expect(stops()).toEqual(["Nov 12"]);
    expect(screen.getByRole("grid")).toBeTruthy();
    expect(screen.getAllByRole("row")).toHaveLength(6);
  });

  it("moves a day by the side arrows and a week by the others, over the days that can be pressed", () => {
    render(<MiniMonth weekdays={WEEKDAYS} days={month("Nov", { floor: 12 })} onDayPress={() => {}} />);
    tabIn();
    expect(keys()).toBe("Nov 12");
    press("ArrowRight");
    expect(keys()).toBe("Nov 13");
    press("ArrowDown");
    expect(keys()).toBe("Nov 20");
    press("ArrowUp", "ArrowUp");
    /* The 6th cannot be pressed: the keys stay where they are rather than land on it. */
    expect(keys()).toBe("Nov 13");
    press("ArrowLeft");
    expect(keys()).toBe("Nov 12");
    press("ArrowLeft");
    expect(keys()).toBe("Nov 12");
    press("Home");
    /* The 12th is a Sunday, and the days of its week before it cannot be pressed: Home stays on it. */
    expect(keys()).toBe("Nov 12");
    press("ArrowRight", "End");
    expect(keys()).toBe("Nov 19");
    press("Home");
    expect(keys()).toBe("Nov 13");
    expect(stops()).toEqual(["Nov 13"]);
  });

  it("Enter and Space press the day under the keys", () => {
    const onDayPress = vi.fn();
    render(<MiniMonth weekdays={WEEKDAYS} days={month("Nov", { floor: 12 })} onDayPress={onDayPress} />);
    tabIn();
    press("ArrowRight", "Enter");
    expect(onDayPress).toHaveBeenLastCalledWith("Nov-13");
    press("ArrowRight", " ");
    expect(onDayPress).toHaveBeenLastCalledWith("Nov-14");
    expect(onDayPress).toHaveBeenCalledTimes(2);
  });

  it("past the month's last day the arrows go on into the next, by its own way on, and a page goes a month", () => {
    function Picker() {
      const [at, setAt] = useState(0);
      const names = ["Nov", "Dec"];
      const head: MiniMonthHead = {
        title: names[at]!,
        hot: false,
        before: { label: "The month before", onPress: () => setAt((a) => Math.max(0, a - 1)) },
        after: { label: "The month after", onPress: () => setAt((a) => Math.min(1, a + 1)) },
      };
      return (
        <MiniMonth
          size="widget"
          head={head}
          weekdays={WEEKDAYS}
          days={month(names[at]!)}
          onDayPress={() => {}}
        />
      );
    }
    render(<Picker />);
    tabIn();
    expect(keys()).toBe("Nov 1");
    press("ArrowUp");
    /* Nothing comes before the first month the picker shows: the keys stay. */
    expect(keys()).toBe("Nov 1");
    press("ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown");
    expect(keys()).toBe("Nov 29");
    press("ArrowRight", "ArrowRight");
    expect(keys()).toBe("Dec 1");
    press("PageUp");
    expect(keys()).toBe("Nov 1");
    press("PageDown");
    expect(keys()).toBe("Dec 1");
    /* Back by a week: the same weekday's last in the month before; on by a page, the same date. */
    press("ArrowUp");
    expect(keys()).toBe("Nov 29");
    press("PageDown");
    expect(keys()).toBe("Dec 29");
  });

  it("a small month keeps the keys off the days of the months beside it, which it does not show", () => {
    render(<MiniMonth size="widget" weekdays={WEEKDAYS} days={month("Nov")} onDayPress={() => {}} />);
    tabIn();
    expect(keys()).toBe("Nov 1");
    press("ArrowLeft");
    expect(keys()).toBe("Nov 1");
    press("End", "ArrowDown", "ArrowDown", "ArrowDown", "ArrowDown");
    expect(keys()).toBe("Nov 26");
  });

  it("a picker that takes the keys puts them on its day as it is drawn", () => {
    render(
      <MiniMonth
        takesKeys
        size="widget"
        weekdays={WEEKDAYS}
        days={month("Nov", { floor: 11, offWord: "outside" })}
        onDayPress={() => {}}
      />,
    );
    expect(keys()).toBe("Nov 11");
  });

  it("keys it takes go no further than the month, and the others reach what holds it", () => {
    const below = vi.fn();
    render(
      <div onKeyDown={(e) => below(e.key)}>
        <MiniMonth weekdays={WEEKDAYS} days={month("Nov")} onDayPress={() => {}} />
      </div>,
    );
    tabIn();
    press("ArrowRight", "ArrowDown", "Home", "End", "Escape");
    expect(below.mock.calls.map((c) => c[0])).toEqual(["Escape"]);
  });
});
