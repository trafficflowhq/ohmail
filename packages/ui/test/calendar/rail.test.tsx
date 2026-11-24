/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CalendarRail, type CalendarRailProps } from "@ohmail/ui/calendar";

afterEach(cleanup);

const rail = (
  over: Partial<CalendarRailProps> = {},
  calendars: Partial<CalendarRailProps["calendars"]> = {},
) => (
  <CalendarRail
    label="Places"
    newEvent={{ label: "New event", keyHint: "c" }}
    mini={
      <div role="group" aria-label="November">
        the month
      </div>
    }
    places={<button type="button">Invitations</button>}
    calendars={{
      label: "Calendars",
      note: "2 of 3",
      open: false,
      accounts: [
        {
          name: "Google",
          calendars: [
            { id: "mila", name: "Mila", tone: 243, shown: true, switchLabel: "Show Mila" },
            { id: "home", name: "Home", tone: 198, shown: false, switchLabel: "Show Home" },
          ],
        },
        {
          name: "Mail",
          calendars: [
            {
              id: "later",
              name: "Send later",
              tone: "neutral",
              shown: true,
              switchLabel: "Show Send later",
              layerIcon: "later",
            },
          ],
        },
      ],
      ...calendars,
    }}
    {...over}
  />
);

describe("the calendar's rail", () => {
  it("is the landmark of the places, with New event before the month and the places", () => {
    const onPress = vi.fn();
    render(rail({ newEvent: { label: "New event", onPress } }));
    const nav = screen.getByRole("navigation", { name: "Places" });
    fireEvent.click(within(nav).getByRole("button", { name: "New event" }));
    expect(onPress).toHaveBeenCalledTimes(1);
    const order = [
      screen.getByRole("button", { name: "New event" }),
      screen.getByRole("group", { name: "November" }),
      screen.getByRole("button", { name: "Invitations" }),
    ];
    expect(order[0]!.compareDocumentPosition(order[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1]!.compareDocumentPosition(order[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps New event at its head: the month and the places scroll under it, and it does not", () => {
    render(rail());
    const nav = screen.getByRole("navigation", { name: "Places" });
    const places = screen.getByRole("button", { name: "Invitations" });
    /* What scrolls is the nearest box that holds both the month and the places. */
    let scrolls = screen.getByRole("group", { name: "November" }).parentElement;
    while (scrolls && !scrolls.contains(places)) scrolls = scrolls.parentElement;
    expect(scrolls).not.toBe(nav);
    expect(scrolls!.contains(screen.getByRole("button", { name: /New event/ }))).toBe(false);
  });

  it("stays calm while the calendars are shut: one line that says how many show, and no row", () => {
    const onToggle = vi.fn();
    render(rail({}, { onToggle }));
    const line = screen.getByRole("button", { name: /Calendars/ });
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(line.textContent).toContain("2 of 3");
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(line);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("opened, every account is a named group of its calendars, each shown or hidden by its own switch", () => {
    const onToggle = vi.fn();
    render(
      rail(
        {},
        {
          open: true,
          accounts: [
            {
              name: "Google",
              calendars: [
                { id: "mila", name: "Mila", tone: 243, shown: true, switchLabel: "Show Mila", onToggle },
                { id: "home", name: "Home", tone: 198, shown: false, switchLabel: "Show Home" },
              ],
            },
            {
              name: "Mail",
              calendars: [
                {
                  id: "later",
                  name: "Send later",
                  tone: "neutral",
                  shown: true,
                  switchLabel: "Show Send later",
                  layerIcon: "later",
                },
              ],
            },
          ],
        },
      ),
    );
    expect(screen.getByRole("button", { name: /Calendars/ }).getAttribute("aria-expanded")).toBe("true");
    const google = screen.getByRole("group", { name: "Google" });
    expect(
      within(google)
        .getAllByRole("switch")
        .map((s) => s.getAttribute("aria-label")),
    ).toEqual(["Show Mila", "Show Home"]);
    expect(
      within(screen.getByRole("group", { name: "Mail" })).getByRole("switch", { name: "Show Send later" }),
    ).toBeTruthy();
    fireEvent.click(within(google).getByRole("switch", { name: "Show Mila" }));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("keeps what follows the calendars, and the foot, in the rail", () => {
    render(
      rail({
        below: <button type="button">Settings</button>,
        foot: <button type="button">Check now</button>,
      }),
    );
    const nav = screen.getByRole("navigation", { name: "Places" });
    expect(within(nav).getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(within(nav).getByRole("button", { name: "Check now" })).toBeTruthy();
  });
});
