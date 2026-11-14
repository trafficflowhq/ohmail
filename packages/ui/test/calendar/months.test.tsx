/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EventChip, MiniMonth, MonthGrid, type MiniMonthDay, type MonthGridWeek } from "@ohmail/ui/calendar";

afterEach(cleanup);

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function week(first: number, extra: Partial<MonthGridWeek> = {}): MonthGridWeek {
  return {
    id: `w${first}`,
    days: NAMES.map((name, i) => ({
      id: `d${first + i}`,
      number: String(first + i),
      label: `${name} ${first + i} November`,
      today: first + i === 10,
      picked: first + i === 13,
    })),
    ...extra,
  };
}

describe("the month grid", () => {
  it("makes each date a button named in full, and says which is today", () => {
    const onDayPress = vi.fn();
    render(<MonthGrid weekdays={WEEKDAYS} weeks={[week(2), week(9)]} onDayPress={onDayPress} />);
    expect(screen.getByRole("button", { name: "Tuesday 10 November" }).getAttribute("aria-current")).toBe(
      "date",
    );
    fireEvent.click(screen.getByRole("button", { name: "Friday 13 November" }));
    expect(onDayPress).toHaveBeenCalledWith("d13");
  });

  it("keeps the keys in the days' order: a day's lines, then its more, then the next day's lines", () => {
    const w = week(9);
    w.days[0] = {
      ...w.days[0]!,
      lines: (
        <EventChip
          size="line"
          tone={243}
          title="Studio Monday"
          time="09:00"
          style={{ gridColumn: 1, gridRow: 2 }}
        />
      ),
      more: { text: "+2", label: "2 more on Monday 9 November" },
    };
    w.days[1] = {
      ...w.days[1]!,
      lines: (
        <EventChip
          size="line"
          tone={243}
          title="Invoices"
          time="09:00"
          style={{ gridColumn: 2, gridRow: 2 }}
        />
      ),
    };
    render(
      <MonthGrid
        weekdays={WEEKDAYS}
        weeks={[
          {
            ...w,
            children: (
              <EventChip
                size="line"
                tone={153}
                title="Makersfest"
                run
                style={{ gridColumn: "1 / 3", gridRow: 2 }}
              />
            ),
          },
        ]}
      />,
    );
    const order = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
    const at = (name: string) => order.findIndex((o) => o?.includes(name));
    expect(at("Makersfest")).toBeLessThan(at("Studio Monday"));
    expect(at("Studio Monday")).toBeLessThan(at("2 more on Monday"));
    expect(at("2 more on Monday")).toBeLessThan(at("Invoices"));
  });

  it("leads to the rest of a day that holds more than it shows", () => {
    const onMorePress = vi.fn();
    const w = week(9);
    w.days[3] = { ...w.days[3]!, more: { text: "+4", label: "4 more on Thursday 12 November" } };
    render(<MonthGrid weekdays={WEEKDAYS} weeks={[w]} onMorePress={onMorePress} />);
    const more = screen.getByRole("button", { name: "4 more on Thursday 12 November" });
    expect(more.textContent).toBe("+4");
    fireEvent.click(more);
    expect(onMorePress).toHaveBeenCalledWith("d12");
  });

  it("holds a week's events and carries the week's number only where it is handed one", () => {
    const onWeekPress = vi.fn();
    const { rerender } = render(
      <MonthGrid
        weekdays={WEEKDAYS}
        weeks={[
          week(9, {
            children: (
              <EventChip
                size="line"
                tone={243}
                title="Dentist"
                time="09:30"
                style={{ gridColumn: 2, gridRow: 2 }}
              />
            ),
          }),
        ]}
      />,
    );
    expect(screen.getByRole("button", { name: /Dentist/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Week 46" })).toBeNull();
    rerender(
      <MonthGrid
        weekdays={WEEKDAYS}
        weeks={[week(9, { weekNumber: { number: 46, label: "Week 46" } })]}
        onWeekPress={onWeekPress}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Week 46" }));
    expect(onWeekPress).toHaveBeenCalledWith("w9");
  });
});

const days: MiniMonthDay[] = Array.from({ length: 42 }, (_, i) => {
  const n = i - 5;
  return {
    id: `m${n}`,
    number: String(n < 1 ? 26 + i : n > 30 ? n - 30 : n),
    label: `Day ${n}`,
    outside: n < 1 || n > 30,
    today: n === 10,
    picked: n === 17,
    busy: n === 12,
  };
});

describe("the mini month", () => {
  it("names every day in full, marks today, and tells the app which day was pressed", () => {
    const onDayPress = vi.fn();
    render(<MiniMonth weekdays={["M", "T", "W", "T", "F", "S", "S"]} days={days} onDayPress={onDayPress} />);
    expect(screen.getByRole("button", { name: "Day 10" }).getAttribute("aria-current")).toBe("date");
    expect(screen.getByRole("button", { name: "Day 17" }).getAttribute("aria-current")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Day 12" }));
    expect(onDayPress).toHaveBeenCalledWith("m12");
  });

  it("says a day that cannot be picked is unavailable, and takes no press on it", () => {
    const onDayPress = vi.fn();
    const floor = days.map((d, i) => (i < 12 ? { ...d, disabled: true } : d));
    render(<MiniMonth weekdays={["M", "T", "W", "T", "F", "S", "S"]} days={floor} onDayPress={onDayPress} />);
    const early = screen.getByRole("button", { name: "Day 3" }) as HTMLButtonElement;
    expect(early.disabled).toBe(true);
    fireEvent.click(early);
    expect(onDayPress).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Day 12" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("has a head with the month's name and the two ways on only where it is given one", () => {
    const before = vi.fn(),
      after = vi.fn();
    const { rerender } = render(<MiniMonth weekdays={["M", "T", "W", "T", "F", "S", "S"]} days={days} />);
    expect(screen.queryByRole("button", { name: "The month before" })).toBeNull();
    rerender(
      <MiniMonth
        weekdays={["M", "T", "W", "T", "F", "S", "S"]}
        days={days}
        head={{
          title: "November",
          hot: true,
          before: { label: "The month before", onPress: before },
          after: { label: "The month after", onPress: after },
        }}
      />,
    );
    expect(screen.queryByText("November")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "The month before" }));
    fireEvent.click(screen.getByRole("button", { name: "The month after" }));
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("carries a week's number in the room left of its row", () => {
    const onWeekPress = vi.fn();
    render(
      <MiniMonth
        weekdays={["M", "T", "W", "T", "F", "S", "S"]}
        days={days}
        weekNumbers={[
          { number: 44, label: "Week 44" },
          { number: 45, label: "Week 45" },
          null,
          null,
          null,
          null,
        ]}
        onWeekPress={onWeekPress}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Week 45" }));
    expect(onWeekPress).toHaveBeenCalledWith(1);
    expect(screen.queryByRole("button", { name: "Week 46" })).toBeNull();
  });
});
