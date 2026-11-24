/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { AnswerSwitch, CalendarRow, ViewSwitch } from "@ohmail/ui/calendar";

afterEach(cleanup);

describe("a calendar's row", () => {
  it("shows and hides its calendar by its square, a switch that says which", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <CalendarRow name="Mila" tone={243} shown switchLabel="Show Mila" onToggle={onToggle} />,
    );
    const square = screen.getByRole("switch", { name: "Show Mila" });
    expect(square.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(square);
    expect(onToggle).toHaveBeenCalledWith(false);
    rerender(
      <CalendarRow name="Mila" tone={243} shown={false} switchLabel="Show Mila" onToggle={onToggle} />,
    );
    expect(square.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(square);
    expect(onToggle).toHaveBeenLastCalledWith(true);
  });

  it("opens its menu by its name, and says whether the menu stands open", () => {
    const onMenu = vi.fn();
    render(
      <CalendarRow
        name="Lichtgrat studio"
        tone={153}
        shown
        switchLabel="Show Lichtgrat studio"
        menuOpen
        onMenu={onMenu}
      />,
    );
    const name = screen.getByRole("button", { name: /Lichtgrat studio/ });
    expect(name.getAttribute("aria-haspopup")).toBe("menu");
    expect(name.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(name);
    expect(onMenu).toHaveBeenCalledTimes(1);
  });

  it("names what its two marks say: where new events go, and view only", () => {
    render(
      <CalendarRow
        name="Catalogue"
        tone={288}
        shown
        switchLabel="Show Catalogue"
        defaultLabel="New events go here"
        viewOnlyLabel="View only"
      />,
    );
    expect(screen.getByRole("img", { name: "View only" })).toBeTruthy();
    expect(screen.getByTitle("New events go here")).toBeTruthy();
  });

  it("is one switch as a whole where it stands for a kind of mail", () => {
    const onToggle = vi.fn();
    render(
      <CalendarRow
        name="Resurface"
        tone="neutral"
        shown
        switchLabel="Show Resurface"
        layerIcon="resurface"
        onToggle={onToggle}
      />,
    );
    const row = screen.getByRole("switch", { name: "Show Resurface" });
    expect(row.textContent).toContain("Resurface");
    fireEvent.click(row);
    expect(onToggle).toHaveBeenCalledWith(false);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

const VIEWS = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
];

describe("the view switch", () => {
  it("is a group of four where the view you are in is the pressed one", () => {
    const onChange = vi.fn();
    render(<ViewSwitch label="View" views={VIEWS} value="week" onChange={onChange} />);
    expect(screen.getByRole("group", { name: "View" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Week" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Day" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Month" }));
    expect(onChange).toHaveBeenCalledWith("month");
  });

  it("draws in a segment the key that takes its view, and none where the app names none", () => {
    render(
      <ViewSwitch
        label="View"
        views={[
          { value: "day", label: "Day", keyHint: "1" },
          { value: "week", label: "Week", keyHint: "2" },
          { value: "year", label: "Year" },
        ]}
        value="week"
      />,
    );
    const week = screen.getByRole("button", { name: /^Week/ });
    expect(week.getAttribute("aria-pressed")).toBe("true");
    expect(within(week).getByText("2")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /^Day/ })).getByText("1")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Year" }).textContent).toBe("Year");
  });

  it("a segment with a key is named by its word alone: the key is drawn and never said", () => {
    render(
      <ViewSwitch
        label="View"
        views={[
          { value: "day", label: "Day", keyHint: "1" },
          { value: "week", label: "Week", keyHint: "2" },
        ]}
        value="week"
      />,
    );
    const week = screen.getByRole("button", { name: "Week" });
    expect(within(week).getByText("2").getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("button", { name: "Day" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("a view's key reaches a screen reader on its segment where the app names it, and stays out of the segment's name", () => {
    render(
      <ViewSwitch
        label="View"
        views={[
          { value: "day", label: "Day", keyHint: "1", shortcut: "1" },
          { value: "week", label: "Week", keyHint: "2", shortcut: "2" },
          { value: "year", label: "Year" },
        ]}
        value="week"
      />,
    );
    expect(screen.getByRole("button", { name: "Week" }).getAttribute("aria-keyshortcuts")).toBe("2");
    expect(screen.getByRole("button", { name: "Day" }).getAttribute("aria-keyshortcuts")).toBe("1");
    expect(screen.getByRole("button", { name: "Year" }).hasAttribute("aria-keyshortcuts")).toBe(false);
  });

  it("is one capsule that names the view and opens the views' menu where there is no room for four", () => {
    const onOpen = vi.fn();
    const { rerender } = render(
      <ViewSwitch label="View" views={VIEWS} value="week" compact menuOpen={false} onOpen={onOpen} />,
    );
    const capsule = screen.getByRole("button", { name: "Week" });
    expect(capsule.getAttribute("aria-haspopup")).toBe("menu");
    expect(capsule.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: "Month" })).toBeNull();
    fireEvent.click(capsule);
    expect(onOpen).toHaveBeenCalledTimes(1);
    rerender(<ViewSwitch label="View" views={VIEWS} value={null} compact menuOpen onOpen={onOpen} />);
    expect(screen.getByRole("button", { name: "View" }).getAttribute("aria-expanded")).toBe("true");
  });
});

const ANSWERS = [
  { value: "yes", label: "Yes" },
  { value: "maybe", label: "Maybe" },
  { value: "no", label: "No" },
];

describe("the answer switch", () => {
  it("presses none while the invitation waits, and the given answer after", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <AnswerSwitch label="Answer" answers={{ options: ANSWERS, value: null, onChange }} />,
    );
    expect(screen.getByRole("group", { name: "Answer" })).toBeTruthy();
    for (const a of ANSWERS)
      expect(screen.getByRole("button", { name: a.label }).getAttribute("aria-pressed")).toBe("false");
    const maybe = screen.getByRole("button", { name: "Maybe" });
    fireEvent.click(maybe);
    expect(onChange).toHaveBeenCalledWith("maybe", maybe);
    rerender(<AnswerSwitch label="Answer" answers={{ options: ANSWERS, value: "maybe", onChange }} />);
    expect(screen.getByRole("button", { name: "Maybe" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("draws in an answer the key that gives it, where the app names one", () => {
    render(
      <AnswerSwitch
        label="Answer"
        answers={{
          options: [
            { value: "yes", label: "Yes", keyHint: "y" },
            { value: "maybe", label: "Maybe" },
          ],
          value: "yes",
        }}
      />,
    );
    const yes = screen.getByRole("button", { name: "Yes" });
    expect(yes.querySelector("[data-key='y']")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Maybe" }).textContent).toBe("Maybe");
  });

  it("carries the acts of what is no invitation the same way, and the way to propose a time", () => {
    const add = vi.fn(),
      propose = vi.fn();
    render(
      <AnswerSwitch
        label="Answer"
        acts={[
          { id: "add", label: "Add", primary: true, onPress: add },
          { id: "dismiss", label: "Dismiss" },
        ]}
        propose={{ label: "Propose a time", onPress: propose }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Propose a time" }));
    expect(add).toHaveBeenCalledTimes(1);
    expect(propose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();
  });

  it("offers no proposal where the provider takes none", () => {
    render(
      <AnswerSwitch
        label="Answer"
        answers={{ options: ANSWERS, value: null }}
        propose={{ label: "Propose a time", disabled: true }}
      />,
    );
    expect((screen.getByRole("button", { name: "Propose a time" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("names the whole row once something stands beside the three answers", () => {
    render(
      <AnswerSwitch
        label="Answer"
        answers={{ options: ANSWERS, value: null }}
        propose={{ label: "Propose a time" }}
      />,
    );
    const groups = screen.getAllByRole("group", { name: "Answer" });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.contains(screen.getByRole("button", { name: "Yes" }))).toBe(true);
    expect(groups[0]!.contains(screen.getByRole("button", { name: "Propose a time" }))).toBe(true);
  });

  it("keeps Propose a time's name where only its sign is shown", () => {
    render(<AnswerSwitch label="Answer" propose={{ label: "Propose a time" }} />);
    expect(screen.getByRole("button", { name: "Propose a time" }).getAttribute("aria-label")).toBe(
      "Propose a time",
    );
  });
});
