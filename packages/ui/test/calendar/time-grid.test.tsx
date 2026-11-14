/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  AllDayRow,
  EventChip,
  OutOfSightCapsule,
  TimeGrid,
  WeekNumber,
  type TimeGridDay,
} from "@ohmail/ui/calendar";

afterEach(cleanup);

const days: TimeGridDay[] = [
  { id: "mon", weekday: "Mon", date: "9", label: "Monday 9 November" },
  { id: "tue", weekday: "Tue", date: "10", label: "Tuesday 10 November", today: true },
  { id: "wed", weekday: "Wed", date: "11", label: "Wednesday 11 November", picked: true },
];
const hours = ["07:00", "08:00", "09:00", "10:00", "11:00"];

describe("the time grid", () => {
  it("heads each day with a button named in full, and says which is today", () => {
    const onDayPress = vi.fn();
    render(<TimeGrid days={days} firstHour={7} hourHeight={60} hourLabels={hours} onDayPress={onDayPress} />);
    const today = screen.getByRole("button", { name: "Tuesday 10 November" });
    expect(today.getAttribute("aria-current")).toBe("date");
    expect(screen.getByRole("button", { name: "Monday 9 November" }).getAttribute("aria-current")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Wednesday 11 November" }));
    expect(onDayPress).toHaveBeenCalledWith("wed");
  });

  it("leaves the heads out where the view names the day itself", () => {
    render(
      <TimeGrid days={days.slice(1, 2)} heads={false} firstHour={7} hourHeight={60} hourLabels={hours} />,
    );
    expect(screen.queryByRole("button", { name: "Tuesday 10 November" })).toBeNull();
  });

  it("writes the time of now in place of the hour it is nearest to", () => {
    render(
      <TimeGrid
        days={days}
        firstHour={7}
        hourHeight={60}
        hourLabels={hours}
        now={{ minutes: 9 * 60 + 8, label: "09:08" }}
      />,
    );
    expect(screen.queryByText("09:08")).not.toBeNull();
    expect(screen.queryByText("09:00")).toBeNull();
    expect(screen.queryByText("10:00")).not.toBeNull();
  });

  it("draws no line of now on a span without today, or outside the hours drawn", () => {
    const { rerender } = render(
      <TimeGrid
        days={[days[0]!, days[2]!]}
        firstHour={7}
        hourHeight={60}
        hourLabels={hours}
        now={{ minutes: 9 * 60 + 8, label: "09:08" }}
      />,
    );
    expect(screen.queryByText("09:08")).toBeNull();
    expect(screen.queryByText("09:00")).not.toBeNull();
    rerender(
      <TimeGrid
        days={days}
        firstHour={7}
        hourHeight={60}
        hourLabels={hours}
        now={{ minutes: 5 * 60, label: "05:00" }}
      />,
    );
    expect(screen.queryByText("05:00")).toBeNull();
  });

  it("holds each day's events, and names mail's marks at their hour", () => {
    const onPress = vi.fn();
    const withThings: TimeGridDay[] = [
      {
        ...days[0]!,
        children: <EventChip size="block" tone={243} title="Dentist" place={{ top: 60, height: 45 }} />,
        marks: [{ id: "m1", minutes: 8 * 60, icon: "resurface", label: "Resurface · Glaze order", onPress }],
        free: [{ minutes: 10 * 60, text: "2 h" }],
      },
    ];
    render(<TimeGrid days={withThings} firstHour={7} hourHeight={60} hourLabels={hours} />);
    expect(screen.getByRole("button", { name: /Dentist/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Resurface · Glaze order" }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("2 h")).not.toBeNull();
  });

  it("tells the app where empty time was pressed", () => {
    const onDayPointerDown = vi.fn();
    render(
      <TimeGrid
        days={days}
        firstHour={7}
        hourHeight={60}
        hourLabels={hours}
        onDayPointerDown={onDayPointerDown}
      />,
    );
    fireEvent.pointerDown(screen.getByRole("group", { name: "Wednesday 11 November" }));
    expect(onDayPointerDown).toHaveBeenCalledTimes(1);
    expect(onDayPointerDown.mock.calls[0]![0]).toBe("wed");
  });
});

describe("the all-day row", () => {
  it("says its name only while it holds something", () => {
    const { rerender } = render(<AllDayRow label="all day" days={3} />);
    expect(screen.queryByText("all day")).toBeNull();
    rerender(
      <AllDayRow label="all day" days={3}>
        <EventChip size="pill" tone={150} title="Makersfest" />
      </AllDayRow>,
    );
    expect(screen.queryByText("all day")).not.toBeNull();
  });
});

describe("the out-of-sight capsule", () => {
  it("is one button that leads to the nearest of what it stands for, and shows four at most", () => {
    const onPress = vi.fn();
    const items = ["08:00 Dentist", "09:00 Lunch", "10:00 Call", "11:00 Review", "12:00 Shoot"].map(
      (text) => ({ kind: "calendar" as const, tone: 243, text }),
    );
    render(
      <OutOfSightCapsule
        side="below"
        items={items}
        label="5 later, the nearest at 08:00"
        onPress={onPress}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "5 later, the nearest at 08:00" }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("11:00 Review")).not.toBeNull();
    expect(screen.queryByText("12:00 Shoot")).toBeNull();
  });

  it("is not there with nothing out of sight", () => {
    render(<OutOfSightCapsule side="above" items={[]} label="Earlier" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("the week number", () => {
  it("is the way to its week", () => {
    const onPress = vi.fn();
    render(<WeekNumber number={46} label="Week 46" onPress={onPress} />);
    const button = screen.getByRole("button", { name: "Week 46" });
    expect(button.textContent).toBe("46");
    fireEvent.click(button);
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});
